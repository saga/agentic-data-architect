import fs from 'node:fs/promises';
import { parseJourneyMarkdown } from './journey.js';

const file = process.argv[2] ?? 'skills/legacy-modernization/SKILL.md';

try {
  const markdown = await fs.readFile(file, 'utf8');
  const result = parseJourneyMarkdown(markdown);

  if (result.issues.length) {
    for (const issue of result.issues) {
      console.error('ERROR ' + issue);
    }
    process.exitCode = 1;
  } else {
    console.log('OK ' + file);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
