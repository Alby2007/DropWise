import type { Git, Result } from './git';

const DEFAULT_SCHEMA_FILE = 'prisma/schema.prisma';
const DEFAULT_SCHEMA_DIR = 'prisma/schema';

function parentDir(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

export interface SchemaLocation {
  path: string;
  isDir: boolean;
}

/**
 * Locate the Prisma schema at a revision. Order: explicit input,
 * prisma/schema.prisma, prisma/schema/ directory, then anywhere in the tree
 * (only when unambiguous).
 */
export async function discoverSchema(
  git: Git,
  rev: string,
  schemaPathOpt?: string,
): Promise<Result<SchemaLocation>> {
  if (schemaPathOpt) {
    const p = schemaPathOpt.replace(/\\/g, '/');
    const t = await git.pathType(rev, p);
    if (!t) {
      return { ok: false, error: `configured schema-path "${schemaPathOpt}" not found at ${rev}` };
    }
    return { ok: true, value: { path: p, isDir: t === 'tree' } };
  }
  if (await git.pathExists(rev, DEFAULT_SCHEMA_FILE)) {
    return { ok: true, value: { path: DEFAULT_SCHEMA_FILE, isDir: false } };
  }
  if ((await git.pathType(rev, DEFAULT_SCHEMA_DIR)) === 'tree') {
    return { ok: true, value: { path: DEFAULT_SCHEMA_DIR, isDir: true } };
  }
  const all = await git.listFiles(rev, '');
  if (!all.ok) return { ok: false, error: all.error };
  const prismaFiles = all.value.filter((p) => p.endsWith('.prisma'));
  const schemaFiles = prismaFiles.filter((p) => p.endsWith('schema.prisma'));
  if (schemaFiles.length === 1) {
    return { ok: true, value: { path: schemaFiles[0], isDir: false } };
  }
  if (schemaFiles.length === 0) {
    const dirs = new Set(prismaFiles.map(parentDir));
    if (dirs.size === 1) {
      return { ok: true, value: { path: [...dirs][0], isDir: true } };
    }
  }
  return { ok: false, error: 'no Prisma schema found' };
}

/**
 * Locate the migrations directory at a revision: explicit input, else a
 * "migrations" directory next to the schema.
 */
export async function discoverMigrations(
  git: Git,
  rev: string,
  migrationsPathOpt: string | undefined,
  schemaPath: string | null,
): Promise<string | null> {
  if (migrationsPathOpt) {
    const p = migrationsPathOpt.replace(/\\/g, '/');
    return (await git.pathType(rev, p)) === 'tree' ? p : null;
  }
  if (schemaPath) {
    const dir = parentDir(schemaPath);
    const candidate = dir ? `${dir}/migrations` : 'migrations';
    if ((await git.pathType(rev, candidate)) === 'tree') return candidate;
  }
  return null;
}

/** Read the full schema text at a revision; multi-file schemas are concatenated
 *  in sorted order. Resolves file-vs-directory at the requested revision. */
export async function loadSchemaText(git: Git, rev: string, schemaPath: string): Promise<Result<string>> {
  const t = await git.pathType(rev, schemaPath);
  if (t === 'blob') return git.showFile(rev, schemaPath);
  if (t !== 'tree') {
    return { ok: false, error: `schema path ${schemaPath} not found at ${rev}` };
  }
  const files = await git.listFiles(rev, schemaPath);
  if (!files.ok) return files;
  const prismaFiles = files.value.filter((p) => p.endsWith('.prisma')).sort();
  if (prismaFiles.length === 0) {
    return { ok: false, error: `no .prisma files in schema directory ${schemaPath} at ${rev}` };
  }
  const parts: string[] = [];
  for (const p of prismaFiles) {
    const f = await git.showFile(rev, p);
    if (!f.ok) return f;
    parts.push(f.value);
  }
  return { ok: true, value: parts.join('\n') };
}
