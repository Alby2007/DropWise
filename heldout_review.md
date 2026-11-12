# Held-out findings for hand review

Every verdict other than `SAME_PR_REMOVAL` from the held-out validation runs,
with the evidence dropwise cited and the full migration SQL it was read from.
Verdicts are claims about evidence, not proof of production behaviour.

# linkwarden

## linkwarden @ 116753fc — drop_column `Subscription.storeEnvironment`

**Verdict:** PRIOR_SCHEMA_REMOVAL

**Summary:** The column is absent from the base schema, but git history shows it was declared earlier and later removed from the schema. This looks like a contract-style cleanup step; whether any deployed version still references it is unverified.

**Evidence:** absent from base schema at 116753f; added by migration packages/prisma/migrations/20260617173711_add_revenuecat_metadata/migration.sql (commit 899f976)

**Recommended action:** confirm the version that removed the column from the schema has finished rolling out before deploying this migration.

<details><summary>migration SQL — `20260618175031_replace_store_environment_with_google_purchase_token`</summary>

```sql
/*
  Warnings:

  - You are about to drop the column `storeEnvironment` on the `Subscription` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[googlePurchaseToken]` on the table `Subscription` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Subscription" DROP COLUMN "storeEnvironment",
ADD COLUMN     "googlePurchaseToken" TEXT;

-- DropEnum
DROP TYPE "SubscriptionEnvironment";

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_googlePurchaseToken_key" ON "Subscription"("googlePurchaseToken");
```

</details>

## linkwarden @ 44ae6d0d — drop_column `Highlight.xPath`

**Verdict:** NO_PRIOR_SCHEMA_EVIDENCE

**Summary:** No declaration of this column was found in the searched history. This is not proof it never reached production.

**Evidence:** column added in 20250329032742_add_field and dropped in 20250330105338_add_field within this pull request

**Recommended action:** confirm manually whether any released version declared this column before relying on this verdict.

<details><summary>migration SQL — `20250330105338_add_field`</summary>

```sql
/*
  Warnings:

  - You are about to drop the column `xPath` on the `Highlight` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Highlight" DROP COLUMN "xPath",
ADD COLUMN     "endXPath" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "startXPath" TEXT NOT NULL DEFAULT '';
```

</details>

## linkwarden @ 9bd821ba — drop_column `Link.indexed`

**Verdict:** NO_PRIOR_SCHEMA_EVIDENCE

**Summary:** No declaration of this column was found in the searched history. This is not proof it never reached production.

**Evidence:** column added in 20250211134725_add_field_to_links and dropped in 20250215181757_add_version_to_index within this pull request

**Recommended action:** confirm manually whether any released version declared this column before relying on this verdict.

<details><summary>migration SQL — `20250215181757_add_version_to_index`</summary>

```sql
/*
  Warnings:

  - You are about to drop the column `indexed` on the `Link` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Link" DROP COLUMN "indexed",
ADD COLUMN     "indexVersion" TEXT;
```

</details>

## linkwarden @ 9bd821ba — drop_column `Link.indexVersion`

**Verdict:** DESTRUCTIVE_REPLACEMENT

**Summary:** The column is dropped and re-added in the same migration with no preceding data copy. Existing values will be lost.

**Evidence:** column dropped and re-added within 20250215182023_change_field_type

**Recommended action:** prefer ALTER COLUMN ... TYPE ... USING, or add a new column, backfill it, and swap — a drop-then-recreate loses existing values.

<details><summary>migration SQL — `20250215182023_change_field_type`</summary>

```sql
/*
  Warnings:

  - The `indexVersion` column on the `Link` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- AlterTable
ALTER TABLE "Link" DROP COLUMN "indexVersion",
ADD COLUMN     "indexVersion" INTEGER;
```

</details>

# papermark

## papermark @ 251defe3 — drop_column `LinkPreset.expiresIn`

**Verdict:** DESTRUCTIVE_REPLACEMENT

**Summary:** The column is dropped and re-added in the same migration with no preceding data copy. Existing values will be lost.

**Evidence:** column dropped and re-added within 20250429175856_update_expires_in

**Recommended action:** prefer ALTER COLUMN ... TYPE ... USING, or add a new column, backfill it, and swap — a drop-then-recreate loses existing values.

<details><summary>migration SQL — `20250429175856_update_expires_in`</summary>

```sql
/*
  Warnings:

  - The `expiresIn` column on the `LinkPreset` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- AlterTable
ALTER TABLE "LinkPreset" DROP COLUMN "expiresIn",
ADD COLUMN     "expiresIn" JSONB;
```

</details>

## papermark @ eb730002 — drop_column `LinkPreset.expiresIn`

**Verdict:** DESTRUCTIVE_REPLACEMENT

**Summary:** The column is dropped and re-added in the same migration with no preceding data copy. Existing values will be lost.

**Evidence:** column dropped and re-added within 20250502000000_add_additional_present_fields

**Recommended action:** prefer ALTER COLUMN ... TYPE ... USING, or add a new column, backfill it, and swap — a drop-then-recreate loses existing values.

<details><summary>migration SQL — `20250502000000_add_additional_present_fields`</summary>

```sql
-- AlterTable
ALTER TABLE "LinkPreset" ADD COLUMN     "agreementId" TEXT,
ADD COLUMN     "customFields" JSONB,
ADD COLUMN     "enableAgreement" BOOLEAN DEFAULT false,
ADD COLUMN     "enableCustomFields" BOOLEAN DEFAULT false,
DROP COLUMN "expiresIn",
ADD COLUMN     "expiresIn" INTEGER;
```

</details>

# typebot

## typebot @ 9fa4c7df — drop_column `PublicTypebot.blocks`

**Verdict:** DESTRUCTIVE_REPLACEMENT

**Summary:** The column is dropped and re-added in the same migration with no preceding data copy. Existing values will be lost.

**Evidence:** column dropped and re-added within 20220106083902_normalize_data

**Recommended action:** prefer ALTER COLUMN ... TYPE ... USING, or add a new column, backfill it, and swap — a drop-then-recreate loses existing values.

<details><summary>migration SQL — `20220106083902_normalize_data`</summary>

```sql
/*
  Warnings:

  - You are about to drop the column `startBlock` on the `PublicTypebot` table. All the data in the column will be lost.
  - You are about to drop the column `startBlock` on the `Typebot` table. All the data in the column will be lost.
  - Added the required column `steps` to the `PublicTypebot` table without a default value. This is not possible if the table is not empty.
  - Changed the type of `blocks` on the `PublicTypebot` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Added the required column `steps` to the `Typebot` table without a default value. This is not possible if the table is not empty.
  - Changed the type of `blocks` on the `Typebot` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- AlterTable
ALTER TABLE "PublicTypebot" DROP COLUMN "startBlock",
ADD COLUMN     "steps" JSONB NOT NULL,
DROP COLUMN "blocks",
ADD COLUMN     "blocks" JSONB NOT NULL;

-- AlterTable
ALTER TABLE "Typebot" DROP COLUMN "startBlock",
ADD COLUMN     "steps" JSONB NOT NULL,
DROP COLUMN "blocks",
ADD COLUMN     "blocks" JSONB NOT NULL;
```

</details>

## typebot @ 9fa4c7df — drop_column `Typebot.blocks`

**Verdict:** DESTRUCTIVE_REPLACEMENT

**Summary:** The column is dropped and re-added in the same migration with no preceding data copy. Existing values will be lost.

**Evidence:** column dropped and re-added within 20220106083902_normalize_data

**Recommended action:** prefer ALTER COLUMN ... TYPE ... USING, or add a new column, backfill it, and swap — a drop-then-recreate loses existing values.

<details><summary>migration SQL — `20220106083902_normalize_data`</summary>

```sql
/*
  Warnings:

  - You are about to drop the column `startBlock` on the `PublicTypebot` table. All the data in the column will be lost.
  - You are about to drop the column `startBlock` on the `Typebot` table. All the data in the column will be lost.
  - Added the required column `steps` to the `PublicTypebot` table without a default value. This is not possible if the table is not empty.
  - Changed the type of `blocks` on the `PublicTypebot` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Added the required column `steps` to the `Typebot` table without a default value. This is not possible if the table is not empty.
  - Changed the type of `blocks` on the `Typebot` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- AlterTable
ALTER TABLE "PublicTypebot" DROP COLUMN "startBlock",
ADD COLUMN     "steps" JSONB NOT NULL,
DROP COLUMN "blocks",
ADD COLUMN     "blocks" JSONB NOT NULL;

-- AlterTable
ALTER TABLE "Typebot" DROP COLUMN "startBlock",
ADD COLUMN     "steps" JSONB NOT NULL,
DROP COLUMN "blocks",
ADD COLUMN     "blocks" JSONB NOT NULL;
```

</details>

---
8 non-SAME_PR_REMOVAL finding(s) total.