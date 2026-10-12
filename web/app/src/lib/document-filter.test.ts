import { describe, expect, test } from "bun:test";
import type { DocumentSummaryDto } from "@repo/core/contracts";
import { filterDocumentsByProject, ORG_FILTER } from "./document-filter";

const doc = (id: string, projectKey: string | null, taskKey: string | null = null) =>
  ({ id, projectKey, taskKey }) as DocumentSummaryDto;
const docs = [doc("a", null), doc("b", "ST"), doc("c", "ST", "ST-1"), doc("d", "WEB")];

describe("filterDocumentsByProject", () => {
  test("no filter keeps everything", () => {
    expect(filterDocumentsByProject(docs, "")).toHaveLength(4);
  });
  test("a project includes its tasks' documents", () => {
    expect(filterDocumentsByProject(docs, "ST").map((d) => d.id)).toEqual(["b", "c"]);
  });
  test("organization-wide only", () => {
    expect(filterDocumentsByProject(docs, ORG_FILTER).map((d) => d.id)).toEqual(["a"]);
  });
});
