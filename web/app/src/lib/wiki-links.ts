import type { DocumentSummaryDto } from "@repo/core/contracts";
import {
  documentIdTarget,
  isLinkableTitle,
  normalizeTitle,
  resolveTitle,
  taskKeyTarget,
} from "@repo/core/links";
import type { WikiSuggestion } from "@/components/editor/wiki-link";

/**
 * Where a `[[target]]` written in a document of `fromProjectKey` leads (ST-100). A
 * `[[doc:<id>]]` no visible document has is "unknown": unlike a title, there is nothing to create.
 */
export type WikiDestination =
  | { type: "document"; id: string }
  | { type: "task"; key: string }
  | { type: "missing"; title: string }
  | { type: "unknown"; id: string };

export function wikiDestination(
  documents: readonly DocumentSummaryDto[],
  target: string,
  fromProjectKey: string | null,
): WikiDestination {
  const key = taskKeyTarget(target);
  if (key) return { type: "task", key };
  const id = documentIdTarget(target.split("#")[0] ?? "");
  if (id)
    return documents.some((d) => d.id === id)
      ? { type: "document", id }
      : { type: "unknown", id };
  const title = (target.split("#")[0] ?? "").trim();
  const doc = resolveTitle(documents, title, fromProjectKey);
  return doc ? { type: "document", id: doc.id } : { type: "missing", title };
}

/** The text a `[[target]]` without a label shows: the document's current title for `[[doc:<id>]]` (ST-115). */
export function wikiLabel(
  documents: readonly DocumentSummaryDto[],
  target: string,
): string | null {
  const id = documentIdTarget(target.split("#")[0] ?? "");
  return id ? (documents.find((d) => d.id === id)?.title ?? null) : null;
}

/**
 * Documents to offer after `[[query`: titles starting with the query first, then containing it;
 * the same project's before others; never the document being edited. A task key offers the task.
 */
export function wikiSuggestions(
  documents: readonly DocumentSummaryDto[],
  query: string,
  {
    fromProjectKey,
    excludeId,
    limit = 8,
  }: { fromProjectKey: string | null; excludeId?: string; limit?: number },
): WikiSuggestion[] {
  const q = normalizeTitle(query);
  const scored: { doc: DocumentSummaryDto; score: number }[] = [];
  for (const doc of documents) {
    // A title with `[`, `]`, `|` or `#` can't be linked to by title (docs/features.md).
    if (doc.id === excludeId || !isLinkableTitle(doc.title)) continue;
    const title = normalizeTitle(doc.title);
    const at = q ? title.indexOf(q) : 0;
    if (at < 0) continue;
    const score =
      (at === 0 ? 0 : 2) + (doc.projectKey === fromProjectKey ? 0 : 1);
    scored.push({ doc, score });
  }
  scored.sort(
    (a, b) =>
      a.score - b.score || b.doc.updatedAt.localeCompare(a.doc.updatedAt),
  );
  const out: WikiSuggestion[] = [];
  const key = taskKeyTarget(query);
  if (key) out.push({ target: key, title: key, hint: "Task" });
  const seen = new Set<string>();
  for (const { doc } of scored) {
    // One entry per title: a link names a title, not a document.
    const title = normalizeTitle(doc.title);
    if (seen.has(title)) continue;
    seen.add(title);
    out.push({
      target: doc.title.trim(),
      title: doc.title,
      hint: doc.taskKey ?? doc.projectKey ?? "Org",
    });
    if (out.length >= limit) break;
  }
  return out;
}
