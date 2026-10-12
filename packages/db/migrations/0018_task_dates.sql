ALTER TABLE "tasks" ADD COLUMN "start_date" date;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "target_date" date;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_dates_ordered" CHECK ("tasks"."start_date" is null or "tasks"."target_date" is null or "tasks"."start_date" <= "tasks"."target_date");