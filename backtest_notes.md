# Back-test reproduction notes

Agreement: 183/187 = 97.9% on in-scope ops (drops only, Prisma repos, 60 migrations).
Verdict renaming applied per brief §4: PREVIOUSLY_REMOVED->PRIOR_SCHEMA_REMOVAL,
NEVER_RELEASED_IN_BASE/TEMP_SCAFFOLDING->NO_PRIOR_SCHEMA_EVIDENCE,
DROPPED_AND_RECREATED->DESTRUCTIVE_REPLACEMENT, UNKNOWN_*->UNKNOWN.

| repo | migration | op | target | expected (renamed) | actual | explanation |
| --- | --- | --- | --- | --- | --- | --- |
| langfuse | #75 | drop_column | audit_logs.user_project_role | DESTRUCTIVE_REPLACEMENT | UNKNOWN | Intentional divergence: migration uses the add/copy/drop/rename swap pattern. Brief §4 requires UNKNOWN ("swap pattern; renames not yet supported") rather than the prototype's coarser DROPPED_AND_RECREATED label. |
| langfuse | #75 | drop_column | membership_invitations.role | DESTRUCTIVE_REPLACEMENT | UNKNOWN | Intentional divergence: migration uses the add/copy/drop/rename swap pattern. Brief §4 requires UNKNOWN ("swap pattern; renames not yet supported") rather than the prototype's coarser DROPPED_AND_RECREATED label. |
| langfuse | #75 | drop_column | project_memberships.role | DESTRUCTIVE_REPLACEMENT | UNKNOWN | Intentional divergence: migration uses the add/copy/drop/rename swap pattern. Brief §4 requires UNKNOWN ("swap pattern; renames not yet supported") rather than the prototype's coarser DROPPED_AND_RECREATED label. |
| langfuse | #76 | drop_column | prompts.prompt | DESTRUCTIVE_REPLACEMENT | UNKNOWN | Intentional divergence: migration uses the add/copy/drop/rename swap pattern. Brief §4 requires UNKNOWN ("swap pattern; renames not yet supported") rather than the prototype's coarser DROPPED_AND_RECREATED label. |
