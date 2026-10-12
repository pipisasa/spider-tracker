ALTER TABLE "inbox_items" ALTER COLUMN "task_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "rules_document_id" uuid;--> statement-breakpoint
ALTER TABLE "inbox_items" ADD COLUMN "document_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_rules_document_id_documents_id_fk" FOREIGN KEY ("rules_document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_subject" CHECK ("inbox_items"."task_id" is not null or "inbox_items"."document_id" is not null);