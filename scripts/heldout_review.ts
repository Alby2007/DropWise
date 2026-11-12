/**
 * Builds heldout_review.md: every non-SAME_PR_REMOVAL finding from the
 * held-out reports in .backtest/heldout/, shown side by side with the
 * migration SQL so each verdict can be hand-checked independently.
 *
 * Usage: npx tsx scripts/heldout_review.ts
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import type { Report, Finding } from '../src/types';

const ROOT = path.join(__dirname, '..');
const REPOS_DIR = path.join(ROOT, '.backtest', 'repos');
const HELDOUT_DIR = path.join(ROOT, '.backtest', 'heldout');
const OUT = path.join(ROOT, 'heldout_review.md');

function git(repoDir: string, args: string[]): string {
  return execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function findMigrationSql(repoDir: string, head: string, migration: string): string | null {
  const files = git(repoDir, ['ls-tree', '-r', '--name-only', head]).split('\n');
  const file = files.find((p) => p.includes(`/${migration}/`) && p.endsWith('.sql'));
  if (!file) return null;
  return git(repoDir, ['show', `${head}:${file}`]);
}

const lines: string[] = [
  '# Held-out findings for hand review',
  '',
  'Every verdict other than `SAME_PR_REMOVAL` from the held-out validation runs,',
  'with the evidence dropwise cited and the full migration SQL it was read from.',
  'Verdicts are claims about evidence, not proof of production behaviour.',
  '',
];

let count = 0;
for (const repo of readdirSync(HELDOUT_DIR)) {
  const repoDir = path.join(REPOS_DIR, repo);
  const dir = path.join(HELDOUT_DIR, repo);
  if (!existsSync(repoDir)) continue;
  const repoLines: string[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const report = JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as Report;
    for (const m of report.migrations) {
      const interesting = m.findings.filter((x: Finding) => x.verdict !== 'SAME_PR_REMOVAL');
      if (!interesting.length) continue;
      for (const finding of interesting) {
        count++;
        const op = finding.operation;
        repoLines.push(
          `## ${repo} @ ${f.replace('.json', '')} — ${op.kind} \`${op.table}${op.column ? '.' + op.column : ''}\``,
          '',
          `**Verdict:** ${finding.verdict}${finding.reason ? ` — ${finding.reason}` : ''}`,
          '',
          `**Summary:** ${finding.summary}`,
          '',
          `**Evidence:** ${finding.evidence.join('; ') || 'none recorded'}`,
          '',
          `**Recommended action:** ${finding.recommendation}`,
          '',
        );
        const sql = findMigrationSql(repoDir, report.head, m.migration);
        repoLines.push(
          sql === null
            ? '*migration SQL could not be read from git*'
            : `<details><summary>migration SQL — \`${m.migration}\`</summary>\n\n\`\`\`sql\n${sql.trim()}\n\`\`\`\n\n</details>`,
          '',
        );
      }
    }
  }
  if (repoLines.length) lines.push(`# ${repo}`, '', ...repoLines);
}

lines.push('---', `${count} non-SAME_PR_REMOVAL finding(s) total.`);
writeFileSync(OUT, lines.join('\n'));
console.log(`wrote ${OUT} (${count} findings)`);
