CREATE TABLE "git_links" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"pull_request_id" uuid,
	"via" text NOT NULL,
	"title" text,
	"author" text,
	"occurred_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "git_links_task_ref_key" UNIQUE("task_id","repo_id","kind","ref"),
	CONSTRAINT "git_links_kind_check" CHECK ("git_links"."kind" in ('branch', 'commit', 'pull_request')),
	CONSTRAINT "git_links_via_check" CHECK ("git_links"."via" in ('closing', 'branch', 'title', 'body', 'message')),
	CONSTRAINT "git_links_pull_request_check" CHECK (("git_links"."kind" = 'pull_request') = ("git_links"."pull_request_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "pull_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"state" text NOT NULL,
	"draft" boolean DEFAULT false NOT NULL,
	"head_branch" text NOT NULL,
	"base_branch" text NOT NULL,
	"author_login" text,
	"merged_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"github_updated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pull_requests_repo_number_key" UNIQUE("repo_id","number"),
	CONSTRAINT "pull_requests_state_check" CHECK ("pull_requests"."state" in ('open', 'closed', 'merged'))
);
--> statement-breakpoint
ALTER TABLE "git_links" ADD CONSTRAINT "git_links_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_links" ADD CONSTRAINT "git_links_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_links" ADD CONSTRAINT "git_links_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_links" ADD CONSTRAINT "git_links_pull_request_id_pull_requests_id_fk" FOREIGN KEY ("pull_request_id") REFERENCES "public"."pull_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "git_links_repo_ref_idx" ON "git_links" USING btree ("repo_id","kind","ref");--> statement-breakpoint
CREATE INDEX "git_links_pull_request_idx" ON "git_links" USING btree ("pull_request_id");