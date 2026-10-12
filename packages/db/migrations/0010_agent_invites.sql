CREATE TABLE "agent_invites" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"code" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"created_by" uuid,
	"expires_at" timestamp with time zone DEFAULT now() + interval '7 days' NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_invites_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "agent_projects" (
	"agent_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	CONSTRAINT "agent_projects_agent_id_project_id_pk" PRIMARY KEY("agent_id","project_id")
);
--> statement-breakpoint
ALTER TABLE "agent_invites" ADD CONSTRAINT "agent_invites_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_invites" ADD CONSTRAINT "agent_invites_agent_id_actors_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_invites" ADD CONSTRAINT "agent_invites_created_by_actors_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."actors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_projects" ADD CONSTRAINT "agent_projects_agent_id_actors_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_projects" ADD CONSTRAINT "agent_projects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_invites_org_idx" ON "agent_invites" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "agent_invites_agent_idx" ON "agent_invites" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_projects_project_idx" ON "agent_projects" USING btree ("project_id");