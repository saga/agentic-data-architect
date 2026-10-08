import assert from 'node:assert/strict';
import test from 'node:test';
import { selectRecommendedRuntime } from '../src/agent/provider-catalog.js';

test('recommendation skips a configured default when it is known to be unusable', () => {
  assert.equal(
    selectRecommendedRuntime('copilot-sdk', ['copilot-sdk', 'codebuddy-sdk', 'opencode-run'], [
      { runtime: 'copilot-sdk', usable: false },
      { runtime: 'codebuddy-sdk', usable: true },
      { runtime: 'opencode-run', usable: true },
    ]),
    'codebuddy-sdk',
  );
});

test('recommendation respects the configured default when it is usable', () => {
  assert.equal(
    selectRecommendedRuntime('copilot-sdk', ['copilot-sdk', 'codebuddy-sdk', 'opencode-run'], [
      { runtime: 'copilot-sdk', usable: true },
      { runtime: 'codebuddy-sdk', usable: true },
      { runtime: 'opencode-run', usable: true },
    ]),
    'copilot-sdk',
  );
});

test('no available runtime preserves a stable form value but does not enable submission', () => {
  assert.equal(
    selectRecommendedRuntime('copilot-sdk', ['copilot-sdk', 'codebuddy-sdk', 'opencode-run'], [
      { runtime: 'copilot-sdk', usable: false },
      { runtime: 'codebuddy-sdk', usable: false },
      { runtime: 'opencode-run', usable: false },
    ]),
    'copilot-sdk',
  );
});
