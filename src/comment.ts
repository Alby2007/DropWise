import type { Report, Finding } from './types';

export const COMMENT_MARKER = '<!-- dropwise-report -->';

const VERDICT_LABEL: Record<string, string> = {
  SAME_PR_REMOVAL: 'Same-PR schema removal',
  PRIOR_SCHEMA_REMOVAL: 'Prior schema removal (contract step candidate)',
  NO_PRIOR_SCHEMA_EVIDENCE: 'No prior schema evidence',
  DESTRUCTIVE_REPLACEMENT: 'Destructive replacement',
  UNKNOWN: 'Unknown',
};

function opHeading(f: Finding): string {
  const op = f.operation;
  if (op.kind === 'drop_column') return `DROP COLUMN \`${op.table}.${op.column}\``;
  if (op.kind === 'drop_table') return `DROP TABLE \`${op.table}\``;
  if (op.kind === 'unparsed') return 'Migration could not be parsed';
  return `Dynamic SQL${op.detail ? ` (${op.detail})` : ''}`;
}

function findingBlock(f: Finding): string {
  const label = VERDICT_LABEL[f.verdict] ?? f.verdict;
  const lines: string[] = [];
  lines.push(`#### ${opHeading(f)} — ${f.verdict}${f.confidenceNote ? ` — *${f.confidenceNote}*` : ''}`);
  lines.push('');
  lines.push(`**${label}.** ${f.summary}`);
  lines.push('');
  lines.push(`**Recommended action:** ${f.recommendation}`);
  lines.push('');
  if (f.evidence.length > 0) {
    lines.push(`**Evidence:** ${f.evidence.join('; ')}.`);
  } else if (f.verdict === 'UNKNOWN' && f.reason) {
    lines.push(`**Evidence:** none usable — ${f.reason}.`);
  }
  return lines.join('\n');
}

export function renderComment(report: Report, squawk?: string): string {
  const out: string[] = [];
  out.push(COMMENT_MARKER);
  out.push('## Migration rollout-risk report');
  out.push('');

  if (report.shallowHistory === true) {
    out.push('> **Tip:** this checkout is shallow — set `fetch-depth: 0` on `actions/checkout` to enable git-history evidence. Verdicts that need history currently report UNKNOWN.');
    out.push('');
  }

  if (report.fatal) {
    out.push(`> **Could not analyse this pull request:** ${report.fatal}`);
    out.push('');
    out.push('All findings that would depend on this analysis are **UNKNOWN** — review destructive migrations manually.');
    out.push('');
  }

  const migrationsWithFindings = report.migrations.filter((m) => m.findings.length > 0);
  const totalFindings = report.migrations.reduce((n, m) => n + m.findings.length, 0);

  if (!report.fatal && totalFindings === 0) {
    out.push(`No destructive migration operations (DROP COLUMN / DROP TABLE) detected in this pull request.`);
    out.push('');
  }

  for (const m of migrationsWithFindings) {
    out.push(`### \`${m.migration}\``);
    out.push('');
    for (const f of m.findings) {
      out.push(findingBlock(f));
      out.push('');
    }
  }

  if (report.warnings.length > 0) {
    out.push('<details><summary>Warnings</summary>');
    out.push('');
    for (const w of report.warnings) out.push(`- ${w}`);
    out.push('');
    out.push('</details>');
    out.push('');
  }

  if (squawk) {
    out.push('<details><summary>Squawk findings (passed through)</summary>');
    out.push('');
    out.push('```json');
    out.push(squawk.trim());
    out.push('```');
    out.push('');
    out.push('</details>');
    out.push('');
  }

  const s = report.stats;
  out.push('---');
  out.push(
    `<sub>dropwise · base ${report.base.slice(0, 7)} → head ${report.head.slice(0, 7)} · ` +
      `${s.migrationsChanged} migration(s) changed, ${s.operationsTotal} finding(s) · ` +
      `mapping v${report.mappingVersion}. Evidence from source and git history — ` +
      `this does not prove what any deployed version reads or writes. Non-blocking report.</sub>`,
  );

  return out.join('\n');
}
