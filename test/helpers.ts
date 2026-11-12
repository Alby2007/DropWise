import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

export interface CommitSpec {
  /** path -> content; null deletes the file */
  files: Record<string, string | null>;
  message?: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

export interface BuiltRepo {
  dir: string;
  commits: string[];
  cleanup: () => void;
}

/** Build a synthetic git repo from a list of commit specs. */
export function buildRepo(commits: CommitSpec[]): BuiltRepo {
  const dir = mkdtempSync(path.join(tmpdir(), 'dropwise-fixture-'));
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'fixture@example.com']);
  git(dir, ['config', 'user.name', 'fixture']);
  const shas: string[] = [];
  for (const c of commits) {
    for (const [p, content] of Object.entries(c.files)) {
      const abs = path.join(dir, p);
      if (content === null) {
        if (existsSync(abs)) rmSync(abs);
      } else {
        mkdirSync(path.dirname(abs), { recursive: true });
        writeFileSync(abs, content);
      }
    }
    git(dir, ['add', '-A']);
    git(dir, ['commit', '--allow-empty', '-m', c.message ?? `commit ${shas.length}`]);
    shas.push(git(dir, ['rev-parse', 'HEAD']).trim());
  }
  return { dir, commits: shas, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Shallow-clone a built repo at the given depth. */
export function shallowClone(repo: BuiltRepo, depth: number): BuiltRepo {
  const dir = mkdtempSync(path.join(tmpdir(), 'dropwise-shallow-'));
  execFileSync('git', ['clone', '--depth', String(depth), `file://${repo.dir.replace(/\\/g, '/')}`, dir], {
    encoding: 'utf8',
  });
  return {
    dir,
    commits: repo.commits, // shas are identical in the clone
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export const DATASOURCE = `datasource db {
  provider = "postgresql"
  url = env("DATABASE_URL")
}

`;

export function schema(...blocks: string[]): string {
  return DATASOURCE + blocks.join('\n\n') + '\n';
}

/** Prisma migration path helper. */
export function mig(name: string, sql: string): Record<string, string> {
  return { [`prisma/migrations/${name}/migration.sql`]: sql };
}
