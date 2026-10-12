CREATE TABLE "release_apps" (
	"release_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"version" text NOT NULL,
	CONSTRAINT "release_apps_release_id_app_id_pk" PRIMARY KEY("release_id","app_id")
);
--> statement-breakpoint
CREATE TABLE "release_repos" (
	"release_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	CONSTRAINT "release_repos_release_id_repo_id_pk" PRIMARY KEY("release_id","repo_id")
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "release_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "shipped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "no_code" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "release_apps" ADD CONSTRAINT "release_apps_release_id_tasks_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_apps" ADD CONSTRAINT "release_apps_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_repos" ADD CONSTRAINT "release_repos_release_id_tasks_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_repos" ADD CONSTRAINT "release_repos_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "release_apps_app_idx" ON "release_apps" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "release_repos_repo_idx" ON "release_repos" USING btree ("repo_id");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_release_id_tasks_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tasks_release_idx" ON "tasks" USING btree ("release_id");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_release_not_self" CHECK ("tasks"."release_id" <> "tasks"."id");