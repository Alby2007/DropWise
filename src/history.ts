import type { Git } from './git';
import { extractOps, type MigrationOps } from './sql';

export interface HistoryEvidence {
  migration: string;
  commit: string;
}

export interface HistoryIndex {
  ok: boolean;
  error?: string;
  /** "table.col" -> earliest adding migration */
  columnAdds: Map<string, HistoryEvidence>;
  /** table -> earliest creating migration */
  tableCreates: Map<string, HistoryEvidence>;
  filesSearched: number;
  /** Files whose SQL could not be parsed — search was incomplete. */
  incomplete: string[];
}

export function failedHistory(error: string): HistoryIndex {
  return {
    ok: false,
    error,
    columnAdds: new Map(),
    tableCreates: new Map(),
    filesSearched: 0,
    incomplete: [],
  };
}

/**
 * Index which migrations in history (ancestors of base) added each column or
 * created each table. Fails closed: shallow history or git failures produce
 * ok:false so callers return UNKNOWN rather than a guess.
 */
export async function buildHistoryIndex(
  git: Git,
  base: string,
  migrationsPath: string | null,
): Promise<HistoryIndex> {
  const index: HistoryIndex = {
    ok: true,
    columnAdds: new Map(),
    tableCreates: new Map(),
    filesSearched: 0,
    incomplete: [],
  };

  if (!migrationsPath) {
    return failedHistory('no migrations directory found; git history cannot be searched');
  }

  const shallow = await git.isShallow();
  if (shallow === null) return failedHistory('could not determine whether history is shallow');
  if (shallow) return failedHistory('shallow git history (fetch-depth is limited); re-run with fetch-depth: 0');
  if (!(await git.revExists(base))) return failedHistory(`base commit ${base} not present in this clone`);

  const added = await git.logAddedFiles(base, migrationsPath);
  if (!added.ok) return failedHistory(added.error);

  // logAddedFiles is newest-first; keep overwriting so each path maps to the
  // earliest commit that added it. Only SQL files are migration content —
  // skip lockfiles (migration_lock.toml) and other non-SQL files.
  const earliest = new Map<string, string>();
  for (const { commit, path } of added.value) {
    if (path.endsWith('.sql')) earliest.set(path, commit);
  }

  const parseCache = new Map<string, Promise<MigrationOps>>();
  const parseOnce = (sql: string): Promise<MigrationOps> => {
    let p = parseCache.get(sql);
    if (!p) {
      p = extractOps(sql);
      parseCache.set(sql, p);
    }
    return p;
  };

  for (const [path, commit] of earliest) {
    index.filesSearched++;
    const file = await git.showFile(commit, path);
    if (!file.ok) {
      index.incomplete.push(`${path}: ${file.error}`);
      continue;
    }
    const ops = await parseOnce(file.value);
    if (!ops.ok) {
      index.incomplete.push(`${path}: ${ops.parseError}`);
      continue;
    }
    const record = (map: Map<string, HistoryEvidence>, key: string) => {
      if (!map.has(key)) map.set(key, { migration: path, commit });
    };
    for (const c of ops.creates) record(index.tableCreates, c.table);
    for (const a of ops.adds) record(index.columnAdds, `${a.table}.${a.column}`);
  }

  return index;
}
