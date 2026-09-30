import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { askCopilot } from '../agent/copilot.js';
import { LEAD_SYSTEM_PROMPT } from '../agent/prompts.js';
import { appendContextInput, appendTranscript, setCopilotSessionId, workspaceRoot } from '../investigation/workspace.js';
import { investigationExists, loadInvestigation, newInvestigation, saveInvestigation } from '../investigation/store.js';
import { runReport } from './report.js';

function defaultSessionName(): string {
  return 'default';
}

function copilotSessionId(name: string): string {
  return 'agentic-data-architect-' + name;
}

async function createInvestigation(name: string) {
  await saveInvestigation(newInvestigation(name));
  return loadInvestigation(name);
}

async function loadSessionSkill(): Promise<string> {
  const file = path.resolve(process.cwd(), 'skills/investigation-session/SKILL.md');
  return fs.readFile(file, 'utf-8');
}

export async function runInteractiveSession(requestedName?: string): Promise<void> {
  const name = requestedName?.trim() || defaultSessionName();
  const existed = await investigationExists(name);
  const investigation = existed ? await loadInvestigation(name) : await createInvestigation(name);

  const skill = await loadSessionSkill();
  const sessionId = investigation.copilotSessionId ?? copilotSessionId(name);
  if (!investigation.copilotSessionId) await setCopilotSessionId(name, sessionId);

  console.log('\nInvestigation: ' + name);
  console.log('Workspace: .workspace/' + name);
  console.log('持续会话已启动。补充上下文、文档、GitHub URL、问题或纠正方向都可以直接输入。');
  console.log('命令：/report 生成当前报告，/context 查看 context.json，/exit 结束。\n');

  const rl = readline.createInterface({ input, output, terminal: true });
  const systemPrompt = LEAD_SYSTEM_PROMPT + '\n\nSESSION SKILL:\n' + skill;

  try {
    const initial = existed
      ? 'Resume this investigation. Read context.json and the session skill. Continue from the latest state. Ask the single most useful next question, or start analysis if the context is already sufficient.'
      : 'Start this investigation. Read context.json and the session skill. Ask the single most useful first question, then continue interactively one useful question at a time until enough context exists to analyze.';
    await appendTranscript(name, 'system', initial);

    let response = await askCopilot({
      prompt: initial,
      systemPrompt,
      sessionId,
      workingDirectory: workspaceRoot(name),
    });
    await appendContextInput(name, { kind: 'assistant_message', title: 'Agent', content: response, source: 'copilot', artifactPath: 'transcript.md' });
    await appendTranscript(name, 'assistant', response);
    console.log(response);

    while (true) {
      const message = (await rl.question('\n> ')).trim();
      if (!message) continue;
      if (message === '/exit' || message === '/quit') break;
      if (message === '/help') {
        console.log('/report 生成当前报告\n/context 显示 context.json 路径\n/exit 结束会话');
        continue;
      }
      if (message === '/context') {
        console.log(path.join('.workspace', name, 'context.json'));
        continue;
      }
      if (message === '/report') {
        const report = await runReport(name);
        console.log(report.markdown);
        console.log('\nwritten: ' + report.path);
        continue;
      }

      await appendContextInput(name, {
        kind: 'user_message',
        title: message.slice(0, 120),
        content: message,
        source: 'interactive-session',
        important: true,
      });
      await appendTranscript(name, 'user', message);

      response = await askCopilot({
        prompt: message,
        systemPrompt,
        sessionId,
        workingDirectory: workspaceRoot(name),
      });
      await appendContextInput(name, { kind: 'assistant_message', title: 'Agent', content: response, source: 'copilot', artifactPath: 'transcript.md' });
      await appendTranscript(name, 'assistant', response);
      console.log(response);
    }
  } finally {
    rl.close();
    console.log('\nSession saved: .workspace/' + name);
  }
}