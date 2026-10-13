import type {
  DocumentGraphDto,
  DocumentSummaryDto,
} from "@repo/core/contracts";
import { describe, expect, test } from "bun:test";
import {
  buildDocumentGraph,
  DEFAULT_FILTERS,
  matchesSearch,
  neighbours,
} from "./doc-graph";

const doc = (
  id: string,
  title: string,
  projectKey: string | null,
  taskKey: string | null = null,
): DocumentSummaryDto => ({
  id,
  title,
  format: "md",
  projectKey,
  taskKey,
  version: 1,
  authorId: "a",
  createdBy: "a",
  createdAt: "2026-10-01",
  updatedAt: "2026-10-01",
});

const dto: DocumentGraphDto = {
  documents: [
    doc("a", "Plan", "ST"),
    doc("b", "Notes", "ST", "ST-1"),
    doc("c", "Lonely", null),
  ],
  tasks: [
    { key: "ST-1", title: "Login", projectKey: "ST", statusCategory: "todo" },
  ],
  projects: [{ key: "ST", name: "Spider" }],
  links: [
    { from: "a", to: { type: "document", id: "b" } },
    { from: "b", to: { type: "document", id: "a" } },
    { from: "a", to: { type: "task", key: "ST-1" } },
    { from: "a", to: { type: "unresolved", title: "later" } },
  ],
};

const ids = (g: ReturnType<typeof buildDocumentGraph>) =>
  g.nodes.map((n) => n.id).sort();
const edges = (g: ReturnType<typeof buildDocumentGraph>) =>
  g.edges.map((e) => `${e.source}>${e.target}:${e.kind}`);

describe("buildDocumentGraph", () => {
  test("defaults: documents, tasks and unresolved titles; links deduplicated; degrees counted", () => {
    const g = buildDocumentGraph(dto, DEFAULT_FILTERS);
    expect(ids(g)).toEqual([
      "doc:a",
      "doc:b",
      "doc:c",
      "missing:later",
      "task:ST-1",
    ]);
    expect(edges(g)).toEqual([
      "doc:a>doc:b:link",
      "doc:a>task:ST-1:link",
      "doc:a>missing:later:link",
      "doc:b>task:ST-1:contains",
    ]);
    expect(g.nodes.find((n) => n.id === "doc:a")?.degree).toBe(3);
  });

  test("hiding tasks hangs task documents off their project; orphans and unresolved can go", () => {
    const g = buildDocumentGraph(dto, {
      showTasks: false,
      showProjects: true,
      showUnresolved: false,
      showOrphans: false,
    });
    expect(ids(g)).toEqual(["doc:a", "doc:b", "project:ST"]);
    expect(edges(g)).toEqual([
      "doc:a>doc:b:link",
      "doc:a>project:ST:contains",
      "doc:b>project:ST:contains",
    ]);
  });

  test("tasks and projects together chain document → task → project", () => {
    const g = buildDocumentGraph(dto, {
      ...DEFAULT_FILTERS,
      showProjects: true,
    });
    expect(edges(g)).toContain("task:ST-1>project:ST:contains");
    expect(edges(g)).toContain("doc:b>task:ST-1:contains");
  });
});

test("neighbours and search", () => {
  const g = buildDocumentGraph(dto, DEFAULT_FILTERS);
  expect([...(neighbours(g.edges).get("task:ST-1") ?? [])].sort()).toEqual([
    "doc:a",
    "doc:b",
  ]);
  const plan = g.nodes.find((n) => n.id === "doc:a");
  if (!plan) throw new Error("missing node");
  expect(matchesSearch(plan, " pla")).toBe(true);
  expect(matchesSearch(plan, "zzz")).toBe(false);
});
