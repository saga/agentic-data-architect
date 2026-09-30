import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';

const execFileAsync = promisify(execFile);

test('financial review skill script produces deterministic review artifact', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentic-data-architect-skill-'));
  const session = 'skill-test';
  const sessionDir = path.join(root, session);
  try {
    await mkdir(path.join(sessionDir, 'discovery'), { recursive: true });
    await mkdir(path.join(sessionDir, 'artifacts'), { recursive: true });

    await writeFile(path.join(sessionDir, 'context.json'), JSON.stringify({
      schemaVersion: 3,
      name: session,
      userPrompt: '',
      goal: '',
      scope: [],
      systems: [],
      questions: [],
      discoveryRuns: [],
      evidence: [
        {
          id: 'ev-position-a',
          type: 'metadata',
          investigationId: session,
          discoveryRunId: 'run-001',
          source: 'metadata:position_a',
          dataset: 'position_a',
          collectedAt: '2026-09-30T00:00:00.000Z',
        },
        {
          id: 'ev-position-b',
          type: 'metadata',
          investigationId: session,
          discoveryRunId: 'run-001',
          source: 'metadata:position_b',
          dataset: 'position_b',
          collectedAt: '2026-09-30T00:00:00.000Z',
        },
      ],
      claims: [],
      findings: [],
      unknowns: [],
      importantInformation: [],
      inputs: [],
      updatedAt: '2026-09-30T00:00:00.000Z',
    }, null, 2));

    await writeFile(path.join(sessionDir, 'discovery', 'run-001.json'), JSON.stringify({
      run: { id: 'run-001' },
      inventory: null,
      lineage: {
        tables: ['position_a', 'position_b'],
        columns: [
          {
            sourceDataset: 'position_a',
            sourceColumn: 'security_id',
            targetDataset: 'position_a',
            targetColumn: 'security_id',
          },
          {
            sourceDataset: 'position_b',
            sourceColumn: 'security_id',
            targetDataset: 'position_b',
            targetColumn: 'security_id',
          },
        ],
      },
      estate: { nodes: [], edges: [] },
      profiles: [],
      findingIds: [],
    }, null, 2));

    await execFileAsync(process.execPath, [
      'skills/financial-data-review/scripts/review.mjs',
      session,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, WORKSPACE_DIR: root },
    });

    const artifact = JSON.parse(
      await readFile(path.join(sessionDir, 'artifacts', 'financial-data-review.json'), 'utf8'),
    );
    assert.equal(artifact.status, 'ok');
    assert.ok(artifact.observations.some((item) => item.type === 'multiple_sources_of_truth'));
    assert.ok(artifact.observations.some((item) => item.type === 'temporal_risk'));
    assert.ok(artifact.observations.some((item) => item.type === 'identifier_fragmentation'));

    assert.ok(artifact.questions.length > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
