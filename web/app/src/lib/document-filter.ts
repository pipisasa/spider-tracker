import type { DocumentSummaryDto } from "@repo/core/contracts";

/** Filter value for organization-wide documents (no project). */
export const ORG_FILTER = "__org";

/** Documents in a project (its tasks' included), only organization-wide ones, or all when `filter` is empty. */
export function filterDocumentsByProject(
  documents: DocumentSummaryDto[],
  filter: string,
): DocumentSummaryDto[] {
  if (!filter) return documents;
  if (filter === ORG_FILTER)
    return documents.filter((d) => d.projectKey === null);
  return documents.filter((d) => d.projectKey === filter);
}
