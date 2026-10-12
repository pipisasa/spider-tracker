import type { DocumentSummaryDto } from "@repo/core/contracts";
import { normalizeTitle, resolveTitle, taskKeyTarget } from "@repo/core/links";
import type { WikiSuggestion } from "@/components/editor/wiki-link";

/** Where a `[[target]]` written in a document of `fromProjectKey` leads (ST-100). */
export type WikiDestination =
  | { type: "document"; id: string }
  | { type: "task"; key: string }
  | { type: "missing"; title: string };

export function wikiDestination(
  documents: readonly DocumentSummaryDto[],
  target: string,
  fromProjectKey: string | null,
): WikiDestination {
  const key = taskKeyTarget(target);
  if (key) return { type: "task", key };
  const title = (target.split("#")[0] ?? "").trim();
  const doc = resolveTitle(documents, title, fromProjectKey);
  return doc ? { type: "document", id: doc.id } : { type: "missing", title };
}

/** Characters a `[[link]]` target can't contain: brackets end it, `|` starts a label, `#` a heading. */
export const UNLINKABLE = /[[\]|#]/;

/**
 * Documents to offer after `[[query`: titles starting with the query first, then containing it;
 * the same project's before others; never the document being edited. A task key offers the task.
 */
export function wikiSuggestions(
  documents: readonly DocumentSummaryDto[],
  query: string,
  { fromProjectKey, excludeId, limit = 8 }: { fromProjectKey: string | null; excludeId?: string; limit?: number },
): WikiSuggestion[] {
  const q = normalizeTitle(query);
  const scored: { doc: DocumentSummaryDto; score: number }[] = [];
  for (const doc of documents) {
    // `[[…]]` can't hold these: a title with them can't be linked to (docs/features.md).
    if (doc.id === excludeId || UNLINKABLE.test(doc.title)) continue;
    const title = normalizeTitle(doc.title);
    const at = q ? title.indexOf(q) : 0;
    if (at < 0) continue;
    const score = (at === 0 ? 0 : 2) + (doc.projectKey === fromProjectKey ? 0 : 1);
    scored.push({ doc, score });
  }
  scored.sort((a, b) => a.score - b.score || b.doc.updatedAt.localeCompare(a.doc.updatedAt));
  const out: WikiSuggestion[] = [];
  const key = taskKeyTarget(query);
  if (key) out.push({ target: key, title: key, hint: "Task" });
  const seen = new Set<string>();
  for (const { doc } of scored) {
    // One entry per title: a link names a title, not a document.
    const title = normalizeTitle(doc.title);
    if (seen.has(title)) continue;
    seen.add(title);
    out.push({ target: doc.title.trim(), title: doc.title, hint: doc.taskKey ?? doc.projectKey ?? "Org" });
    if (out.length >= limit) break;
  }
  return out;
}
