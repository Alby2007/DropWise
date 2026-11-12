import * as core from '@actions/core';
import * as github from '@actions/github';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { analyzeRepo } from './analyze';
import { renderComment, COMMENT_MARKER } from './comment';

async function upsertComment(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
): Promise<void> {
  const existing = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100,
  });
  const mine = existing.data.find((c: { body?: string }) => c.body?.includes(COMMENT_MARKER));
  if (mine) {
    await octokit.rest.issues.updateComment({ owner, repo, comment_id: mine.id, body });
  } else {
    await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body });
  }
}

async function run(): Promise<void> {
  const pr = github.context.payload.pull_request;
  if (!pr) {
    core.setFailed('dropwise runs on pull_request events only.');
    return;
  }

  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const token = core.getInput('token') || process.env.GITHUB_TOKEN || '';
  const schemaPath = core.getInput('schema-path') || undefined;
  const migrationsPath = core.getInput('migrations-path') || undefined;
  const zeroDowntimeDeploys = core.getInput('zero-downtime-deploys') !== 'false';
  const squawkReport = core.getInput('squawk-report') || '';
  const jsonOutput = core.getInput('json-output') || 'dropwise-report.json';
  const shouldComment = core.getInput('comment') !== 'false';

  const base: string = pr.base.sha;
  const head: string = pr.head.sha;
  core.info(`dropwise: analysing ${base.slice(0, 7)}..${head.slice(0, 7)} in ${workspace}`);

  const report = await analyzeRepo({
    cwd: workspace,
    base,
    head,
    schemaPath,
    migrationsPath,
    zeroDowntimeDeploys,
  });

  const outPath = path.join(workspace, jsonOutput);
  await fs.writeFile(outPath, JSON.stringify(report, null, 2));
  core.setOutput('report-path', outPath);
  core.setOutput('verdicts', JSON.stringify(report.stats.byVerdict));

  let squawk: string | undefined;
  if (squawkReport) {
    try {
      squawk = (await fs.readFile(path.join(workspace, squawkReport), 'utf8')).slice(0, 60_000);
    } catch {
      core.warning(`squawk-report "${squawkReport}" could not be read; skipping passthrough`);
    }
  }

  const totalFindings = report.migrations.reduce((n, m) => n + m.findings.length, 0);
  if (shouldComment && (totalFindings > 0 || report.fatal)) {
    if (!token) {
      core.warning('no token available; skipping PR comment');
    } else {
      const octokit = github.getOctokit(token);
      const { owner, repo } = github.context.repo;
      await upsertComment(octokit, owner, repo, pr.number, renderComment(report, squawk));
    }
  } else {
    core.info(`dropwise: ${totalFindings} finding(s), comment ${shouldComment ? 'skipped (nothing to report)' : 'disabled'}`);
  }

  core.info(`dropwise: done — ${JSON.stringify(report.stats.byVerdict)}`);
}

run().catch((e) => {
  core.setFailed(e instanceof Error ? e.message : String(e));
});
