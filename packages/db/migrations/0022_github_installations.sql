ALTER TYPE "public"."actor_type" ADD VALUE 'integration';--> statement-breakpoint
CREATE TABLE "github_installations" (
	"id" bigint PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"account_login" text NOT NULL,
	"account_type" text NOT NULL,
	"repository_selection" text NOT NULL,
	"suspended_at" timestamp with time zone,
	"connected_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_installations_account_type_check" CHECK ("github_installations"."account_type" in ('User', 'Organization')),
	CONSTRAINT "github_installations_repository_selection_check" CHECK ("github_installations"."repository_selection" in ('all', 'selected'))
);
--> statement-breakpoint
ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_connected_by_actors_id_fk" FOREIGN KEY ("connected_by") REFERENCES "public"."actors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "github_installations_org_idx" ON "github_installations" USING btree ("org_id");--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_github_installation_id_github_installations_id_fk" FOREIGN KEY ("github_installation_id") REFERENCES "public"."github_installations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "repos_github_installation_idx" ON "repos" USING btree ("github_installation_id");