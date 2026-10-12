CREATE TABLE "github_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"event" text NOT NULL,
	"action" text,
	"installation_id" bigint,
	"org_id" uuid,
	"result" text DEFAULT 'ignored' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_deliveries_result_check" CHECK ("github_deliveries"."result" in ('processed', 'ignored'))
);
--> statement-breakpoint
ALTER TABLE "github_deliveries" ADD CONSTRAINT "github_deliveries_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "github_deliveries_received_at_idx" ON "github_deliveries" USING btree ("received_at");