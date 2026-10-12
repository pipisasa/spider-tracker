CREATE TYPE "public"."task_kind" AS ENUM('task', 'release', 'milestone');--> statement-breakpoint
ALTER TABLE "statuses" DROP CONSTRAINT "statuses_project_name_key";--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_status_id_statuses_id_fk";
--> statement-breakpoint
ALTER TABLE "statuses" ADD COLUMN "kind" "task_kind" DEFAULT 'task' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "kind" "task_kind" DEFAULT 'task' NOT NULL;--> statement-breakpoint
-- The foreign key below needs this unique constraint first (drizzle-kit orders them the other way).
ALTER TABLE "statuses" ADD CONSTRAINT "statuses_project_kind_id_key" UNIQUE("project_id","kind","id");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_status_fk" FOREIGN KEY ("project_id","kind","status_id") REFERENCES "public"."statuses"("project_id","kind","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "statuses_project_kind_lower_name_key" ON "statuses" USING btree ("project_id","kind",lower("name"));--> statement-breakpoint
-- Task kinds (ST-90): every existing project gets the default release and milestone workflows
-- (the same as DEFAULT_WORKFLOWS in @repo/core); its statuses so far are the task workflow.
INSERT INTO "statuses" ("project_id", "kind", "name", "category", "color", "position")
SELECT "p"."id", "w"."kind"::"task_kind", "w"."name", "w"."category"::"status_category", "w"."color", "w"."position"
FROM "projects" "p"
CROSS JOIN (VALUES
  ('release', 'Planned', 'todo', '#71717a', 0),
  ('release', 'On staging', 'in_progress', '#eab308', 1),
  ('release', 'Release review', 'in_review', '#22c55e', 2),
  ('release', 'Released', 'done', '#6366f1', 3),
  ('release', 'Canceled', 'canceled', '#a1a1aa', 4),
  ('milestone', 'Planned', 'todo', '#71717a', 0),
  ('milestone', 'Active', 'in_progress', '#eab308', 1),
  ('milestone', 'Ready to close', 'in_review', '#22c55e', 2),
  ('milestone', 'Done', 'done', '#6366f1', 3)
) AS "w"("kind", "name", "category", "color", "position")
WHERE NOT EXISTS (SELECT 1 FROM "statuses" "s" WHERE "s"."project_id" = "p"."id" AND "s"."kind" = "w"."kind"::"task_kind");
