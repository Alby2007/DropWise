import { describe, expect, it } from 'vitest';
import { loadPhysicalSchema } from '../src/prisma';
import { schema } from './helpers';

describe('implicit many-to-many mapping', () => {
  it('produces no warnings for ordinary one-to-many relations', async () => {
    const s = schema(
      `model User {
        id    Int    @id
        posts Post[]
        org   Org?   @relation(fields: [orgId], references: [id])
        orgId Int?
      }`,
      `model Post {
        id       Int      @id
        author   User     @relation(fields: [authorId], references: [id])
        authorId Int
        comments Comment[]
      }`,
      `model Org {
        id    Int    @id
        users User[]
      }`,
      `model Comment {
        id     Int  @id
        post   Post @relation(fields: [postId], references: [id])
        postId Int
      }`,
    );
    const r = await loadPhysicalSchema(s);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.warnings).toEqual([]);
    // implicit join tables must NOT be created for ordinary one-to-many
    expect([...r.value.tables.keys()].filter((t) => t.startsWith('_'))).toEqual([]);
  });

  it('creates the _<relationName> join table for a real implicit many-to-many', async () => {
    const s = schema(
      `model Post {
        id         Int        @id
        categories Category[]
      }`,
      `model Category {
        id    Int    @id
        posts Post[]
      }`,
    );
    const r = await loadPhysicalSchema(s);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const join = r.value.tables.get('_CategoryToPost');
    expect(join).toBeDefined();
    expect([...join!.columns].sort()).toEqual(['A', 'B']);
    expect(r.value.warnings).toEqual([]);
  });
});
