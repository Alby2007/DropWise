#!/usr/bin/env python3
"""Prototype rollout-risk classifier (Prisma only, no renames).

For each DROP COLUMN / DROP TABLE in a mined migration, compare the Prisma
schema at the BASE (parent) commit with the schema at the migration commit.

Verdicts:
  SAME_PR_REMOVAL          in base schema, absent in migration commit schema
  STILL_IN_SCHEMA          in both (migration drops something the schema still has)
  NEVER_RELEASED_IN_BASE   not in base schema AND never created by any base migration
  PREVIOUSLY_REMOVED       not in base schema, but base migrations did create it
  UNKNOWN_DYNAMIC          statement lives in a DO $$ block
  UNKNOWN_NO_SCHEMA        no parsable schema.prisma found
  UNSUPPORTED_ORM          not a Prisma repo
  RENAME_SKIPPED           renames are out of scope for v0.1

Usage: classify.py <repos_dir> <data_dir>
"""
import json
import os
import re
import subprocess
import sys

SCALARS = {"String", "Int", "BigInt", "Float", "Decimal", "Boolean", "DateTime", "Json", "Bytes"}
MIG_DIRS = {
    "documenso": "packages/prisma/migrations",
    "formbricks": "packages/database/migration",
    "langfuse": "packages/shared/prisma/migrations",
    "hoppscotch": "packages/hoppscotch-backend/prisma/migrations",
    "lobe-chat": "packages/database/migrations",
    "trigger.dev": "internal-packages/database/prisma/migrations",
}
PRISMA_REPOS = {"documenso", "formbricks", "langfuse", "hoppscotch", "trigger.dev"}


def git(repo, *args):
    p = subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True, errors="replace")
    return p.returncode, p.stdout


def strip_comments(text):
    return re.sub(r"//[^\n]*", "", text)


def parse_schema(text):
    """Return {'tables': {phys_table: set(phys_cols)}, 'joins': set(implicit join tables)}."""
    text = strip_comments(text)
    enums = set(re.findall(r"^\s*enum\s+(\w+)\s*\{", text, re.M))
    models = {}
    for m in re.finditer(r"^\s*model\s+(\w+)\s*\{(.*?)^\s*\}", text, re.M | re.S):
        name, body = m.group(1), m.group(2)
        table = name
        fields = []
        for line in body.splitlines():
            line = line.strip()
            if not line:
                continue
            mm = re.match(r'@@map\(\s*(?:name:\s*)?"([^"]+)"', line)
            if mm:
                table = mm.group(1)
                continue
            if line.startswith("@@"):
                continue
            fm = re.match(r"(\w+)\s+([\w.]+)(\[\])?(\?)?(.*)", line)
            if not fm:
                continue
            fname, ftype, is_list, _opt, rest = fm.groups()
            colmap = re.search(r'@map\(\s*(?:name:\s*)?"([^"]+)"', rest)
            fields.append({
                "name": fname, "type": ftype, "list": bool(is_list),
                "rest": rest, "map": colmap.group(1) if colmap else None,
            })
        models[name] = {"table": table, "fields": fields}

    tables = {}
    for name, md in models.items():
        cols = set()
        for f in md["fields"]:
            t = f["type"]
            if t in SCALARS or t in enums or t.startswith("Unsupported"):
                cols.add(f["map"] or f["name"])
        tables[md["table"]] = cols

    # implicit many-to-many join tables
    joins = set()
    for a, ad in models.items():
        for f in ad["fields"]:
            b = f["type"]
            if not f["list"] or b not in models or "fields:" in f["rest"]:
                continue
            rn = re.search(r'@relation\(\s*(?:name:\s*)?"([^"]+)"', f["rest"])
            relname = rn.group(1) if rn else None
            back = [g for g in models[b]["fields"]
                    if g["type"] == a and g["list"] and "fields:" not in g["rest"]
                    and (g is not f)]
            if relname:
                back = [g for g in back if re.search(r'"%s"' % re.escape(relname), g["rest"])] or back
            if back or a == b:
                joins.add("_" + (relname or "To".join(sorted([a, b]))))
    return {"tables": tables, "joins": joins}


def find_schema(repo, rev, migfile):
    # schema.prisma sits next to (or one level above) the migrations directory.
    # Also supports multi-file schemas (<dir>/schema/*.prisma).
    mig_root = MIG_DIRS_FOR(repo)
    parent = os.path.dirname(mig_root)
    p = f"{parent}/schema.prisma"
    rc, out = git(repo, "show", f"{rev}:{p}")
    if rc == 0:
        return p, out
    rc, out = git(repo, "ls-tree", "--name-only", rev, f"{parent}/schema/")
    if rc == 0 and out.strip():
        parts = []
        for f in out.splitlines():
            if f.endswith(".prisma"):
                rc2, txt = git(repo, "show", f"{rev}:{f}")
                if rc2 == 0:
                    parts.append(txt)
        if parts:
            return f"{parent}/schema/*.prisma", "\n".join(parts)
    rc, out = git(repo, "ls-tree", "-r", "--name-only", rev)
    if rc == 0:
        pref = os.path.dirname(mig_root).split("/")[0]
        for p in out.splitlines():
            if p.endswith("schema.prisma") and p.startswith(pref):
                rc2, txt = git(repo, "show", f"{rev}:{p}")
                if rc2 == 0:
                    return p, txt
    return None, None


def MIG_DIRS_FOR(repo):
    return MIG_DIRS[os.path.basename(repo)]


def base_created(repo, parent, table, col):
    """Did ANY commit in the base's history add a migration that mentions both
    the table and the column? Full-history search (pickaxe), not just the
    migration files present at the base tree, because projects rewrite or
    squash migration history."""
    mdir = MIG_DIRS_FOR(repo)
    needle = '"%s"' % (col if col else table)
    p = subprocess.run(
        ["git", "-C", repo, "log", parent, "-G", re.escape(needle), "-p", "--no-color",
         "--format=COMMIT%h", "--", mdir],
        capture_output=True, text=True, errors="replace",
    )
    if p.returncode != 0:
        # fail loudly: a silent failure here would read as "never released"
        raise RuntimeError(f"git history search failed: {p.stderr[:200]}")
    cur, added = None, []

    def hit():
        txt = "\n".join(added)
        return cur is not None and ('"%s"' % table) in txt and (col is None or ('"%s"' % col) in txt)

    for line in p.stdout.splitlines():
        if line.startswith("diff --git "):
            if hit():
                return True
            cur, added = line, []
        elif line.startswith("+") and not line.startswith("+++"):
            added.append(line[1:])
    return hit()


def recreated_in_sql(sql, table, col):
    """Same migration re-adds the column (type change by drop+add) or renames
    another column into its name."""
    t, c = re.escape(table), re.escape(col)
    clean = re.sub(r"--[^\n]*", "", re.sub(r"/\*.*?\*/", "", sql, flags=re.S))
    events = []  # ordered ('add'|'drop', position) for THIS table's column
    for m in re.finditer(r'ALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?(?:"?\w+"?\.)?"?%s"?\s+(.*?);' % t,
                         clean, re.I | re.S):
        body, base = m.group(1), m.start(1)
        for a in re.finditer(r'ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?%s"?(?=[\s,;]|$)' % c, body, re.I):
            events.append(("add", base + a.start()))
        for a in re.finditer(r'RENAME\s+COLUMN\s+"?\w+"?\s+TO\s+"?%s"?(?=[\s,;]|$)' % c, body, re.I):
            events.append(("add", base + a.start()))
        for a in re.finditer(r'DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?"?%s"?(?=[\s,;]|$)' % c, body, re.I):
            events.append(("drop", base + a.start()))
    events.sort(key=lambda e: e[1])
    kinds = [e[0] for e in events]
    if "add" not in kinds or "drop" not in kinds:
        return None
    # first event decides: drop-then-add = type change/recreate; add-then-drop = temp scaffolding
    return "recreate" if kinds[0] == "drop" else "scaffold"


def classify_one(repo, parent, commit, f, sql, P, S):
    kind = f["kind"]
    if kind.startswith("rename"):
        return "RENAME_SKIPPED", ""
    if re.search(r"\bDO\s+\$", sql):
        return "UNKNOWN_DYNAMIC", "statement may be inside a DO block"
    table, col = f["table"], f["column"]
    if kind == "drop_column":
        order = recreated_in_sql(sql, table, col)
        if order == "recreate":
            return "DROPPED_AND_RECREATED", "same migration drops then re-adds the column (type change?)"
        if order == "scaffold":
            return "TEMP_SCAFFOLDING", "column added then dropped within the same migration"
        in_p = table in P["tables"] and col in P["tables"][table]
        in_s = table in S["tables"] and col in S["tables"][table]
        if in_p and not in_s:
            return "SAME_PR_REMOVAL", "column in base schema, gone in PR schema"
        if in_p and in_s:
            return "STILL_IN_SCHEMA", "column still declared after PR"
        if base_created(repo, parent, table, col):
            return "PREVIOUSLY_REMOVED", "created by a base migration, absent from base schema"
        return "NEVER_RELEASED_IN_BASE", "no base migration creates it"
    if kind == "drop_table":
        in_p = table in P["tables"] or table in P["joins"]
        in_s = table in S["tables"] or table in S["joins"]
        if in_p and not in_s:
            return "SAME_PR_REMOVAL", "table/model in base schema, gone in PR schema"
        if in_p and in_s:
            return "STILL_IN_SCHEMA", "table still declared after PR"
        return ("PREVIOUSLY_REMOVED", "created by a base migration, absent from base schema") \
            if base_created(repo, parent, table, None) \
            else ("NEVER_RELEASED_IN_BASE", "no base migration creates it")
    return "UNKNOWN_NO_SCHEMA", ""


def main():
    repos_dir, data_dir = sys.argv[1], sys.argv[2]
    C = {c["id"]: c for c in json.load(open(os.path.join(data_dir, "candidates.json")))}
    clean = json.load(open(os.path.join(data_dir, "clean_ids.json")))
    out = []
    cache = {}
    for i in clean:
        c = C[i]
        repo = os.path.join(repos_dir, c["repo"])
        sql = open(os.path.join(data_dir, "sql", c["sqlfile"])).read()
        rc, parent = git(repo, "rev-parse", c["commit"] + "^1")
        parent = parent.strip()
        res = {"id": i, "repo": c["repo"], "date": c["date"], "commit": c["commit"][:8], "ops": []}
        if c["repo"] not in PRISMA_REPOS:
            for f in c["findings"]:
                res["ops"].append({**f, "verdict": "UNSUPPORTED_ORM", "why": ""})
            out.append(res)
            continue
        key = (c["repo"], c["commit"])
        if key not in cache:
            pp, ptxt = find_schema(repo, parent, c["file"])
            sp, stxt = find_schema(repo, c["commit"], c["file"])
            cache[key] = (parse_schema(ptxt) if ptxt else None, parse_schema(stxt) if stxt else None)
        P, S = cache[key]
        for f in c["findings"]:
            if P is None or S is None:
                v, why = "UNKNOWN_NO_SCHEMA", "schema.prisma not found/parsed"
            else:
                v, why = classify_one(repo, parent, c["commit"], f, sql, P, S)
            res["ops"].append({**f, "verdict": v, "why": why})
        out.append(res)
        print(i, c["repo"], [o["verdict"] for o in res["ops"]][:3], flush=True)
    json.dump(out, open(os.path.join(data_dir, "classify.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
