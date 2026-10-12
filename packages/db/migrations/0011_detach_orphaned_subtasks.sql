-- ST-9: deleting a task now detaches its sub-tasks. Detach the ones orphaned before that fix.
UPDATE "tasks" AS "child"
SET "parent_id" = NULL, "updated_at" = now()
FROM "tasks" AS "parent"
WHERE "child"."parent_id" = "parent"."id"
  AND "parent"."deleted_at" IS NOT NULL
  AND "child"."deleted_at" IS NULL;
