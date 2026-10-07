import assert from 'node:assert/strict';
import test from 'node:test';
import { isCodeBuddyToolAllowed } from '../src/agent/codebuddy.js';

test('CodeBuddy investigation policy denies host mutation tools', () => {
  assert.equal(isCodeBuddyToolAllowed('Read'), true);
  assert.equal(isCodeBuddyToolAllowed('Glob'), true);
  assert.equal(isCodeBuddyToolAllowed('Grep'), true);
  assert.equal(isCodeBuddyToolAllowed('AskUserQuestion'), true);
  assert.equal(isCodeBuddyToolAllowed('Skill'), true);
  assert.equal(isCodeBuddyToolAllowed('mcp__workbench__local_query'), true);
  for (const tool of ['Write', 'Edit', 'Bash', 'NotebookEdit', 'Task', 'TodoWrite', 'TodoRead']) {
    assert.equal(isCodeBuddyToolAllowed(tool), false, tool + ' must be denied');
  }
});
