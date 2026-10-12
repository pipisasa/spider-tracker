-- ST-49: tag names become unique per organization regardless of case, and `relates` links are
-- stored smaller task id first. Existing rows are fixed up first so neither step can fail.
ALTER TABLE "tags" DROP CONSTRAINT "tags_org_name_key";--> statement-breakpoint
-- Tags differing only by case were allowed: the oldest keeps its name, later ones get " (2)", " (3)"…
DO $$
DECLARE
  dup record;
  n integer;
BEGIN
  FOR dup IN
    SELECT "id", "org_id", "name" FROM (
      SELECT "id", "org_id", "name",
        row_number() OVER (PARTITION BY "org_id", lower("name") ORDER BY "created_at", "id") AS "rn"
      FROM "tags"
    ) AS "ranked"
    WHERE "rn" > 1
    ORDER BY "org_id", lower("name"), "rn"
  LOOP
    n := 2;
    WHILE EXISTS (
      SELECT 1 FROM "tags" WHERE "org_id" = dup."org_id" AND lower("name") = lower(dup."name" || ' (' || n || ')')
    ) LOOP
      n := n + 1;
    END LOOP;
    UPDATE "tags" SET "name" = dup."name" || ' (' || n || ')' WHERE "id" = dup."id";
  END LOOP;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX "tags_org_lower_name_key" ON "tags" USING btree ("org_id",lower("name"));--> statement-breakpoint
-- A pair linked as "relates" in both directions keeps one row.
DELETE FROM "task_relations" AS "r"
USING "task_relations" AS "o"
WHERE "r"."type" = 'relates' AND "o"."type" = 'relates'
  AND "r"."from_task_id" = "o"."to_task_id" AND "r"."to_task_id" = "o"."from_task_id"
  AND "r"."from_task_id" > "r"."to_task_id";--> statement-breakpoint
UPDATE "task_relations"
SET "from_task_id" = "to_task_id", "to_task_id" = "from_task_id"
WHERE "type" = 'relates' AND "from_task_id" > "to_task_id";--> statement-breakpoint
ALTER TABLE "task_relations" ADD CONSTRAINT "task_relations_relates_ordered" CHECK ("task_relations"."type" <> 'relates' or "task_relations"."from_task_id" < "task_relations"."to_task_id");
