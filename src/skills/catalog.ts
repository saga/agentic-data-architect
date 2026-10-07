/**
 * Skill 清单读取与 Schema 校验。
 *
 * Skill 在文件系统里仍然统一使用 SKILL.md 打包。
 * metadata.kind 只负责说明这个 Skill 的运行语义：
 *   - capability：一个可被 Agent 自由组合的能力。
 *   - workflow：一条有明确阶段、顺序和完成条件的工作路线。
 *
 * 这里不解析完整 YAML，只解析本项目明确约定的少量 frontmatter 字段。
 * 这样不需要为了一个很小的 manifest 结构再引入 YAML 运行时依赖；
 * 真正进入业务代码前仍由 Zod 做最终校验。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod';
import { config } from '../config.js';

/** Skill 的两种执行语义；不要继续扩展成 task / agent / tool 等混合概念。 */
export const SkillKindSchema = z.enum(['capability', 'workflow']);
export type SkillKind = z.infer<typeof SkillKindSchema>;

/** SKILL.md frontmatter 中的 metadata 结构。 */
export const SkillMetadataSchema = z.object({
  kind: SkillKindSchema,
}).strict();
export type SkillMetadata = z.infer<typeof SkillMetadataSchema>;

/** 当前项目真正使用的 Skill manifest。 */
export const SkillManifestSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  metadata: SkillMetadataSchema,
}).strict();
export type SkillManifest = z.infer<typeof SkillManifestSchema>;

/** 去掉当前 manifest 中允许出现的单层引号。 */
function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2
    && ((trimmed.startsWith('"') && trimmed.endsWith('"'))
      || (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * 解析项目当前约定的 Skill frontmatter。
 *
 * 只支持这里实际使用到的 name、description、metadata.kind。
 * description 支持普通单行和 YAML folded block（description: >）。
 * 不是完整 YAML parser；字段一旦违反约定，直接抛错，让 CI 尽早发现。
 */
export function parseSkillManifest(markdown: string, filePath = 'SKILL.md'): SkillManifest {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!match) {
    throw new Error(filePath + ' 缺少有效的 frontmatter（--- ... ---）。');
  }

  const lines = (match[1] ?? '').split(/\r?\n/);
  let name = '';
  let description = '';
  let kind: string | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';

    const nameMatch = /^name:\s*(.+)$/.exec(line);
    if (nameMatch) {
      name = unquote(nameMatch[1] ?? '');
      continue;
    }

    const descriptionMatch = /^description:\s*(.*)$/.exec(line);
    if (descriptionMatch) {
      const value = descriptionMatch[1]?.trim() ?? '';
      if (['>', '>-', '|', '|-'].includes(value)) {
        const parts: string[] = [];
        for (index += 1; index < lines.length; index += 1) {
          const continuation = lines[index] ?? '';
          if (continuation.trim() === '') continue;
          if (/^\s+/.test(continuation)) {
            parts.push(continuation.trim());
            continue;
          }
          index -= 1;
          break;
        }
        description = parts.join(' ').trim();
      } else {
        description = unquote(value);
      }
      continue;
    }

    if (/^metadata:\s*$/.test(line)) {
      for (index += 1; index < lines.length; index += 1) {
        const nested = lines[index] ?? '';
        if (nested.trim() === '') continue;
        const kindMatch = /^\s+kind:\s*(.+)$/.exec(nested);
        if (kindMatch) {
          kind = unquote(kindMatch[1] ?? '');
          continue;
        }
        index -= 1;
        break;
      }
    }
  }

  return SkillManifestSchema.parse({
    name,
    description,
    metadata: { kind },
  });
}

/** 从指定 Skill 目录读取并校验 manifest。 */
export async function loadSkillManifest(skillName: string): Promise<SkillManifest> {
  const skillPath = path.join(config.skillsDir, skillName, 'SKILL.md');
  const markdown = await fs.readFile(skillPath, 'utf8');
  return parseSkillManifest(markdown, skillPath);
}

/**
 * 枚举全部 Skill，供 API、设置页和 lint 共用，避免每处各写一套正则。
 * manifest 不合法时直接失败，让坏 Skill 不会悄悄进入运行环境。
 */
export async function listSkillManifests(): Promise<SkillManifest[]> {
  const entries = await fs.readdir(config.skillsDir, { withFileTypes: true });
  const manifests: SkillManifest[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillPath = path.join(config.skillsDir, entry.name, 'SKILL.md');
    try {
      const markdown = await fs.readFile(skillPath, 'utf8');
      const manifest = parseSkillManifest(markdown, skillPath);

      if (manifest.name !== entry.name) {
        throw new Error(
          'name="' + manifest.name + '" 与目录名 "' + entry.name + '" 不一致。',
        );
      }

      manifests.push(manifest);
    } catch (error) {
      throw new Error(
        'Skill ' + entry.name + ' 无法读取：' +
        (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  return manifests.sort((a, b) => a.name.localeCompare(b.name));
}


/**
 * 为不提供 Copilot skillDirectories 的 Runtime 建立本 Investigation 的 Skill bridge。
 * Bridge 只暴露 capability Skill 和当前 Workflow；不会修改内置 Skill，也不会覆盖用户自己放入 workspace 的 Skill。
 */
export async function syncRuntimeSkillWorkspace(
  workingDirectory: string,
  workflowSkill?: string,
): Promise<string> {
  const root = path.join(workingDirectory, '.agents', 'skills');
  await fs.mkdir(root, { recursive: true });

  const manifests = await listSkillManifests();
  const desired = new Set(
    manifests
      .filter((manifest) => manifest.metadata.kind === 'capability' || manifest.name === workflowSkill)
      .map((manifest) => manifest.name),
  );

  const skillRoot = path.resolve(config.skillsDir);
  const managedTarget = (name: string) => path.resolve(skillRoot, name);
  const isManagedTarget = (target: string): boolean => {
    const relative = path.relative(skillRoot, target);
    return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
  };

  const existing = await fs.readdir(root, { withFileTypes: true });
  for (const entry of existing) {
    if (!entry.isSymbolicLink()) continue;
    if (desired.has(entry.name)) continue;
    const linkPath = path.join(root, entry.name);
    try {
      const target = path.resolve(root, await fs.readlink(linkPath));
      if (isManagedTarget(target)) await fs.rm(linkPath, { force: true });
    } catch {
      await fs.rm(linkPath, { force: true }).catch(() => undefined);
    }
  }

  for (const name of desired) {
    const linkPath = path.join(root, name);
    const target = managedTarget(name);
    try {
      const stat = await fs.lstat(linkPath);
      if (stat.isSymbolicLink()) {
        const currentTarget = path.resolve(root, await fs.readlink(linkPath));
        if (currentTarget === target) continue;
        if (isManagedTarget(currentTarget)) await fs.rm(linkPath, { force: true });
        else continue;
      } else {
        continue;
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT')) throw error;
    }

    await fs.symlink(
      target,
      linkPath,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  }

  return root;
}
