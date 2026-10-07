import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fetch as proxyFetch, ProxyAgent } from 'undici';
import { config } from '../config.js';

const execFileAsync = promisify(execFile);
const MAX_CACHE_BYTES = 50 * 1024 * 1024;
const MAX_CACHE_TOTAL_BYTES = 512 * 1024 * 1024;

/**
 * 出站代理：Node 的 fetch 不读代理环境变量，直连外网（如 video.twimg.com）
 * 在本机网络下会超时。代理地址与 opencode serve 共用同一套本机默认值。
 */
function proxyDispatcher(): ProxyAgent | undefined {
  const proxyUrl = process.env.HTTPS_PROXY
    || process.env.https_proxy
    || process.env.HTTP_PROXY
    || process.env.http_proxy
    || 'http://127.0.0.1:10809';
  try {
    return new ProxyAgent(proxyUrl);
  } catch {
    return undefined;
  }
}

let proxyAgent: ProxyAgent | undefined;
function dispatcher(): ProxyAgent | undefined {
  proxyAgent ??= proxyDispatcher();
  return proxyAgent;
}

let ytDlpAvailability: Promise<boolean> | undefined;

async function isYtDlpAvailable(): Promise<boolean> {
  ytDlpAvailability ??= execFileAsync('yt-dlp', ['--version'], {
    timeout: 3_000,
    maxBuffer: 64 * 1024,
  }).then(() => true).catch(() => false);
  return ytDlpAvailability;
}

export type RemoteMediaKind = 'image' | 'video' | 'remote';

export interface ResolvedRemoteMedia {
  source: string;
  kind: RemoteMediaKind;
  remoteUrl?: string;
  cacheKey: string;
  cachePath?: string;
  mimeType?: string;
}

function mediaCacheRoot(): string {
  return path.join(config.dataDir, 'cache', 'media');
}

export function mediaCacheFile(cacheKey: string): string {
  if (!/^[a-f0-9]{64}$/i.test(cacheKey)) throw new Error('Invalid media cache key');
  return path.join(mediaCacheRoot(), cacheKey + '.bin');
}

function mediaCacheMetaFile(cacheKey: string): string {
  return path.join(mediaCacheRoot(), cacheKey + '.json');
}

function cacheKeyFor(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

async function ensureCacheRoot(): Promise<void> {
  await fs.mkdir(mediaCacheRoot(), { recursive: true });
}

async function enforceCacheBudget(): Promise<void> {
  const entries = await fs.readdir(mediaCacheRoot(), { withFileTypes: true });
  const files: Array<{ path: string; size: number; mtimeMs: number }> = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.bin')) continue;
    try {
      const file = path.join(mediaCacheRoot(), entry.name);
      const stat = await fs.stat(file);
      files.push({ path: file, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      // Concurrent cache activity must not make the resolver fail.
    }
  }

  let total = files.reduce((sum, item) => sum + item.size, 0);
  if (total <= MAX_CACHE_TOTAL_BYTES) return;

  files.sort((left, right) => left.mtimeMs - right.mtimeMs);
  for (const file of files) {
    if (total <= MAX_CACHE_TOTAL_BYTES) break;
    await fs.rm(file.path, { force: true });
    await fs.rm(file.path.replace(/\.bin$/, '.json'), { force: true });
    total -= file.size;
  }
}

function isSupportedSocialMediaPage(source: string): boolean {
  try {
    const url = new URL(source);
    return /(^|\.)x\.com$|(^|\.)twitter\.com$|(^|\.)mobile\.twitter\.com$/i.test(url.hostname)
      && /\/status\//i.test(url.pathname);
  } catch {
    return false;
  }
}

function looksLikeDirectMedia(source: string, kind: RemoteMediaKind): boolean {
  try {
    const pathname = new URL(source).pathname.toLowerCase();
    if (kind === 'video') return /\.(mp4|webm|mov|m4v)$/.test(pathname);
    if (kind === 'image') return /\.(png|jpe?g|webp|gif|avif)$/.test(pathname);
    return /\.(png|jpe?g|webp|gif|avif|mp4|webm|mov|m4v)$/.test(pathname);
  } catch {
    return false;
  }
}

function mimeFromMediaUrl(value: string): string | undefined {
  try {
    const pathname = new URL(value).pathname.toLowerCase();
    if (/\.(png|jpe?g|webp|gif|avif)$/.test(pathname)) {
      return pathname.endsWith('.png') ? 'image/png'
        : pathname.endsWith('.webp') ? 'image/webp'
          : pathname.endsWith('.gif') ? 'image/gif'
            : 'image/jpeg';
    }
    if (/\.(webm)$/.test(pathname)) return 'video/webm';
    if (/\.(mov|m4v)$/.test(pathname)) return 'video/quicktime';
    if (/\.(mp4)$/.test(pathname)) return 'video/mp4';
  } catch {}
  return undefined;
}

async function resolveWithYtDlp(source: string, kind: RemoteMediaKind): Promise<{ remoteUrl?: string; mimeType?: string }> {
  if (kind !== 'video' && !isSupportedSocialMediaPage(source)) return {};
  if (!(await isYtDlpAvailable())) return {};
  try {
    const { stdout } = await execFileAsync(
      'yt-dlp',
      [
        '--no-playlist',
        '--no-warnings',
        '--skip-download',
        '--get-url',
        '-f', 'best[ext=mp4]/best',
        source,
      ],
      {
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      },
    );
    const remoteUrl = stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    const mimeType = remoteUrl ? mimeFromMediaUrl(remoteUrl) : undefined;
    return remoteUrl ? { remoteUrl, ...(mimeType ? { mimeType } : {}) } : {};
  } catch {
    return {};
  }
}

async function cacheRemoteResource(cacheKey: string, remoteUrl: string, kind: RemoteMediaKind, mimeHint?: string): Promise<{ cachePath: string; mimeType?: string } | undefined> {
  await ensureCacheRoot();
  const target = mediaCacheFile(cacheKey);
  const metadata = mediaCacheMetaFile(cacheKey);
  try {
    const stat = await fs.stat(target);
    if (stat.isFile() && stat.size > 0) {
      let mimeType = mimeHint;
      try {
        const raw = JSON.parse(await fs.readFile(metadata, 'utf8')) as { mimeType?: unknown };
        if (!mimeType && typeof raw.mimeType === 'string') mimeType = raw.mimeType;
      } catch {}
      await fs.utimes(target, new Date(), new Date()).catch(() => undefined);
      return { cachePath: target, ...(mimeType ? { mimeType } : {}) };
    }
  } catch {}

  // 必须用同一份 undici 的 fetch + dispatcher；把 npm 包的 dispatcher
  // 传给 Node 内建 fetch 会报 UND_ERR_INVALID_ARG。
  const agent = dispatcher();
  const response = await proxyFetch(remoteUrl, {
    redirect: 'follow',
    ...(agent ? { dispatcher: agent } : {}),
    headers: {
      'User-Agent': 'Mozilla/5.0 agentic-data-architect remote-media-cache',
    },
  });
  if (!response.ok || !response.body) return undefined;

  const mimeType = response.headers.get('content-type')?.split(';', 1)[0].trim() || mimeHint;
  if (!mimeType || (kind === 'video' && !mimeType.startsWith('video/')) || (kind === 'image' && !mimeType.startsWith('image/')) || (kind === 'remote' && !mimeType.startsWith('image/') && !mimeType.startsWith('video/'))) {
    return undefined;
  }
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > MAX_CACHE_BYTES) return undefined;

  const temporary = target + '.tmp-' + process.pid + '-' + Date.now();
  let bytes = 0;
  const limited = Readable.fromWeb(response.body as any);

  const limiter = async function* () {
    for await (const chunk of limited) {
      bytes += Buffer.byteLength(chunk as Uint8Array);
      if (bytes > MAX_CACHE_BYTES) throw new Error('Remote media exceeds cache size limit');
      yield chunk;
    }
  };

  try {
    await pipeline(limiter(), fsSync.createWriteStream(temporary));
    await fs.rename(temporary, target);
    await fs.writeFile(
      metadata,
      JSON.stringify({ source: remoteUrl, mimeType, sizeBytes: bytes, cachedAt: new Date().toISOString() }, null, 2) + '\n',
      'utf8',
    );
    await enforceCacheBudget();
    return { cachePath: target, ...(mimeType ? { mimeType } : {}) };
  } catch {
    await fs.rm(temporary, { force: true });
    return undefined;
  }
}

export async function getCachedRemoteMedia(cacheKey: string): Promise<{ path: string; mimeType?: string; sizeBytes: number } | undefined> {
  const target = mediaCacheFile(cacheKey);
  try {
    const stat = await fs.stat(target);
    if (!stat.isFile() || stat.size <= 0) return undefined;
    let mimeType: string | undefined;
    try {
      const metadata = JSON.parse(await fs.readFile(mediaCacheMetaFile(cacheKey), 'utf8')) as { mimeType?: unknown };
      if (typeof metadata.mimeType === 'string') mimeType = metadata.mimeType;
    } catch {}
    await fs.utimes(target, new Date(), new Date()).catch(() => undefined);
    return { path: target, sizeBytes: stat.size, ...(mimeType ? { mimeType } : {}) };
  } catch {
    return undefined;
  }
}

export async function resolveAndCacheRemoteMedia(
  source: string,
  kind: RemoteMediaKind = 'remote',
): Promise<ResolvedRemoteMedia> {
  const normalizedSource = source.trim();
  let url: URL;
  try {
    url = new URL(normalizedSource);
  } catch {
    throw new Error('远程媒体 URL 无效。');
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error('只支持 HTTP/HTTPS 远程媒体 URL。');

  const resolvedKind: RemoteMediaKind = kind === 'remote' && /\/video\//i.test(url.pathname) && isSupportedSocialMediaPage(normalizedSource)
    ? 'video'
    : kind;
  const cacheKey = cacheKeyFor(normalizedSource);
  const existingMeta = await (async () => {
    try {
      return JSON.parse(await fs.readFile(mediaCacheMetaFile(cacheKey), 'utf8')) as {
        source?: unknown; mimeType?: unknown;
      };
    } catch {
      return undefined;
    }
  })();

  let remoteUrl = typeof existingMeta?.source === 'string' ? existingMeta.source : undefined;
  let mimeType = typeof existingMeta?.mimeType === 'string' ? existingMeta.mimeType : undefined;

  const resolved = await resolveWithYtDlp(normalizedSource, resolvedKind);
  remoteUrl = resolved.remoteUrl ?? remoteUrl ?? (looksLikeDirectMedia(normalizedSource, resolvedKind) ? normalizedSource : undefined);
  mimeType = resolved.mimeType ?? mimeType;

  const cached = remoteUrl
    ? await cacheRemoteResource(cacheKey, remoteUrl, resolvedKind, mimeType)
    : undefined;
  return {
    source: normalizedSource,
    kind: resolvedKind,
    ...(remoteUrl ? { remoteUrl } : {}),
    cacheKey,
    ...(cached?.cachePath ? { cachePath: cached.cachePath } : {}),
    ...(cached?.mimeType ? { mimeType: cached.mimeType } : {}),
  };
}
