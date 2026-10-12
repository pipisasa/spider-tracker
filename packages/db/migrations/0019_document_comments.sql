ALTER TABLE "comments" ALTER COLUMN "task_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "document_id" uuid;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "quote" text;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "document_version" integer;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "resolved_by" uuid;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_resolved_by_actors_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comments_document_idx" ON "comments" USING btree ("document_id","created_at");--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_subject" CHECK (("comments"."task_id" is null) <> ("comments"."document_id" is null));--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_quote_on_documents" CHECK ("comments"."quote" is null or "comments"."document_id" is not null);