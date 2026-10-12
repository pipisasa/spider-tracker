-- Plain CREATE INDEX, not CONCURRENTLY: drizzle runs migrations in a transaction, and activity is small enough that the brief write lock is fine.
CREATE INDEX "activity_org_created_idx" ON "activity" USING btree ("org_id","created_at");
