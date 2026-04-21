import * as fs from 'fs';
import * as path from 'path';

const OUTPUT_BASE = path.join(__dirname, '../../output');

export function getNextRunNumber(): number {
  if (!fs.existsSync(OUTPUT_BASE)) {
    fs.mkdirSync(OUTPUT_BASE, { recursive: true });
    return 1;
  }

  const entries = fs.readdirSync(OUTPUT_BASE);
  let maxRun = 0;

  for (const entry of entries) {
    const match = entry.match(/^run-(\d+)$/);
    const rawRun = match?.[1];
    if (!rawRun) {
      continue;
    }

    const num = parseInt(rawRun, 10);
    if (num > maxRun) {
      maxRun = num;
    }
  }

  return maxRun + 1;
}

export function getRunOutputDir(): string {
  const runNumber = getNextRunNumber();
  const runDir = path.join(OUTPUT_BASE, `run-${runNumber}`);
  fs.mkdirSync(runDir, { recursive: true });
  return runDir;
}
