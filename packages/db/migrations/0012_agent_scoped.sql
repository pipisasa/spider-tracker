ALTER TABLE "agents" ADD COLUMN "scoped" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- ST-52: agents with project rows are scoped; keep them scoped when those rows go away.
UPDATE "agents" SET "scoped" = true WHERE "actor_id" IN (SELECT "agent_id" FROM "agent_projects");
