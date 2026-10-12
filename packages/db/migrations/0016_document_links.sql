CREATE TABLE "document_links" (
	"document_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"target" text NOT NULL,
	CONSTRAINT "document_links_document_id_kind_target_pk" PRIMARY KEY("document_id","kind","target"),
	CONSTRAINT "document_links_kind_check" CHECK ("document_links"."kind" in ('document', 'task'))
);
--> statement-breakpoint
ALTER TABLE "document_links" ADD CONSTRAINT "document_links_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_links_target_idx" ON "document_links" USING btree ("kind",lower("target"));--> statement-breakpoint
-- Backfill from current content. An approximation of outgoingLinksIn (@repo/core/links): code isn't
-- skipped here; the next save of a document rewrites its rows exactly.
INSERT INTO "document_links" ("document_id", "kind", "target")
-- One row per title however it is cased or spaced, keeping the first spelling (like outgoingLinksIn).
SELECT DISTINCT ON (l."document_id", l."kind", lower(l."target")) l."document_id", l."kind", l."target"
FROM (
  SELECT d."id" AS "document_id", m.n,
    CASE WHEN btrim(m.g[1]) ~ '^[A-Za-z][A-Za-z0-9]{1,9}-[0-9]{1,9}$' THEN 'task' ELSE 'document' END AS "kind",
    CASE WHEN btrim(m.g[1]) ~ '^[A-Za-z][A-Za-z0-9]{1,9}-[0-9]{1,9}$'
      THEN upper(split_part(btrim(m.g[1]), '-', 1)) || '-' || split_part(btrim(m.g[1]), '-', 2)::bigint
      ELSE regexp_replace(btrim(m.g[1]), '\s+', ' ', 'g') END AS "target"
  FROM "documents" d,
    regexp_matches(d."content", '\[\[([^][\n|#]+)(#[^][\n|]*)?(\|[^][\n]*)?\]\]', 'g') WITH ORDINALITY AS m(g, n)
  WHERE d."deleted_at" IS NULL AND btrim(m.g[1]) <> ''
) l
ORDER BY l."document_id", l."kind", lower(l."target"), l.n
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "document_links" ("document_id", "kind", "target")
SELECT d."id", 'task', upper(split_part(m[1], '-', 1)) || '-' || split_part(m[1], '-', 2)::bigint
FROM "documents" d,
  regexp_matches(d."content", '(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]{1,9}-[0-9]{1,9})(?![A-Za-z0-9])', 'g') AS m
WHERE d."deleted_at" IS NULL
ON CONFLICT DO NOTHING;
