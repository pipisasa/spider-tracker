CREATE TABLE "task_relations" (
	"from_task_id" uuid NOT NULL,
	"to_task_id" uuid NOT NULL,
	"type" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_relations_from_task_id_to_task_id_type_pk" PRIMARY KEY("from_task_id","to_task_id","type"),
	CONSTRAINT "task_relations_not_self" CHECK ("task_relations"."from_task_id" <> "task_relations"."to_task_id")
);
--> statement-breakpoint
ALTER TABLE "task_relations" ADD CONSTRAINT "task_relations_from_task_id_tasks_id_fk" FOREIGN KEY ("from_task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_relations" ADD CONSTRAINT "task_relations_to_task_id_tasks_id_fk" FOREIGN KEY ("to_task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_relations" ADD CONSTRAINT "task_relations_created_by_actors_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."actors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_relations_to_idx" ON "task_relations" USING btree ("to_task_id");