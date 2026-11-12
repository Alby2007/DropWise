import { execFile } from 'node:child_process';

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const MAX_BUFFER = 64 * 1024 * 1024;

function runGit(cwd: string, args: string[]): Promise<Result<string>> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
      if (err) {
        const code = (err as NodeJS.ErrnoException & { code?: number | string }).code;
        resolve({
          ok: false,
          error: `git ${args.join(' ')} failed (code ${String(code)}): ${stderr.trim() || err.message}`,
        });
        return;
      }
      resolve({ ok: true, value: stdout });
    });
  });
}

export function createGit(cwd: string) {
  return {
    cwd,
    async isRepo(): Promise<boolean> {
      const r = await runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
      return r.ok && r.value.trim() === 'true';
    },
    /** true = shallow, false = full, null = could not determine */
    async isShallow(): Promise<boolean | null> {
      const r = await runGit(cwd, ['rev-parse', '--is-shallow-repository']);
      if (!r.ok) return null;
      return r.value.trim() === 'true';
    },
    async revExists(rev: string): Promise<boolean> {
      const r = await runGit(cwd, ['cat-file', '-e', `${rev}^{commit}`]);
      return r.ok;
    },
    async showFile(rev: string, path: string): Promise<Result<string>> {
      return runGit(cwd, ['show', `${rev}:${path}`]);
    },
    async pathExists(rev: string, path: string): Promise<boolean> {
      const r = await runGit(cwd, ['cat-file', '-e', `${rev}:${path}`]);
      return r.ok;
    },
    /** 'blob' | 'tree' | null */
    async pathType(rev: string, path: string): Promise<'blob' | 'tree' | null> {
      const r = await runGit(cwd, ['cat-file', '-t', `${rev}:${path}`]);
      if (!r.ok) return null;
      const t = r.value.trim();
      return t === 'blob' || t === 'tree' ? t : null;
    },
    /** List files under a path at a rev. */
    async listFiles(rev: string, path: string): Promise<Result<string[]>> {
      const r = await runGit(cwd, ['ls-tree', '-r', '--name-only', rev, '--', path]);
      if (!r.ok) return r;
      return { ok: true, value: r.value.split('\n').filter((l) => l.trim().length > 0) };
    },
    /** Files changed between base and head under pathspec. */
    async diffFiles(
      base: string,
      head: string,
      pathspec: string,
    ): Promise<Result<{ status: string; path: string }[]>> {
      const args = ['diff', '--name-status', '--find-renames', `${base}..${head}`];
      if (pathspec) args.push('--', pathspec);
      const r = await runGit(cwd, args);
      if (!r.ok) return r;
      const out: { status: string; path: string }[] = [];
      for (const line of r.value.split('\n')) {
        if (!line.trim()) continue;
        const parts = line.split('\t');
        const status = parts[0];
        const path = parts[parts.length - 1]; // renames: last field is the new path
        out.push({ status, path });
      }
      return { ok: true, value: out };
    },
    /**
     * Commits (ancestors of rev, newest first) that added files under pathspec,
     * each with the added file path.
     */
    async logAddedFiles(rev: string, pathspec: string): Promise<Result<{ commit: string; path: string }[]>> {
      const r = await runGit(cwd, [
        'log',
        rev,
        '--diff-filter=A',
        '--format=commit:%H',
        '--name-only',
        '--',
        pathspec,
      ]);
      if (!r.ok) return r;
      const out: { commit: string; path: string }[] = [];
      let commit = '';
      for (const line of r.value.split('\n')) {
        if (line.startsWith('commit:')) commit = line.slice('commit:'.length).trim();
        else if (line.trim() && commit) out.push({ commit, path: line.trim() });
      }
      return { ok: true, value: out };
    },
  };
}

export type Git = ReturnType<typeof createGit>;
