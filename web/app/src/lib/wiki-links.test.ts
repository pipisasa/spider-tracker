import type { DocumentSummaryDto } from "@repo/core/contracts";
import { describe, expect, test } from "bun:test";
import { wikiDestination, wikiLabel, wikiSuggestions } from "./wiki-links";

const doc = (
  id: string,
  title: string,
  projectKey: string | null,
  updatedAt = "2026-10-01",
): DocumentSummaryDto => ({
  id,
  title,
  format: "md",
  projectKey,
  taskKey: null,
  version: 1,
  authorId: "a",
  createdBy: "a",
  createdAt: updatedAt,
  updatedAt,
});

const docs = [
  doc("1", "Release plan", "ST"),
  doc("5", "Plan | draft", "ST"),
  doc("6", "Plan #2", "ST"),
  doc("2", "Plan", "OPS", "2026-10-05"),
  doc("3", "Plan", null),
  doc("4", "Roadmap", "ST"),
];

describe("wikiDestination", () => {
  test("tasks, documents by title, and missing titles", () => {
    expect(wikiDestination(docs, "st-4", "ST")).toEqual({
      type: "task",
      key: "ST-4",
    });
    expect(wikiDestination(docs, "plan#Goals", "ST")).toEqual({
      type: "document",
      id: "3",
    });
    expect(wikiDestination(docs, "Plan", "OPS")).toEqual({
      type: "document",
      id: "2",
    });
    expect(wikiDestination(docs, "Nope", "ST")).toEqual({
      type: "missing",
      title: "Nope",
    });
  });

  test("[[doc:<id>]] opens the document by id, shown with its title (ST-115)", () => {
    const id = "01a13118-982f-7c2e-8a6e-932d744cc798";
    const withId = [...docs, doc(id, "Architecture", "ST")];
    expect(
      wikiDestination(withId, `DOC:${id.toUpperCase()}#Goals`, "OPS"),
    ).toEqual({ type: "document", id });
    expect(wikiLabel(withId, `doc:${id}`)).toBe("Architecture");
    const gone = "00000000-0000-7000-8000-000000000000";
    expect(wikiDestination(withId, `doc:${gone}`, "ST")).toEqual({
      type: "unknown",
      id: gone,
    });
    expect(wikiLabel(withId, `doc:${gone}`)).toBeNull();
    expect(wikiLabel(withId, "Plan")).toBeNull();
  });
});

describe("wikiSuggestions", () => {
  test("prefix matches first, one entry per title; the edited document and unlinkable titles left out", () => {
    expect(
      wikiSuggestions(docs, "pla", {
        fromProjectKey: "ST",
        excludeId: "4",
      }).map((s) => [s.title, s.hint]),
    ).toEqual([
      ["Plan", "OPS"],
      ["Release plan", "ST"],
    ]);
  });

  test("an empty query lists recent documents; a task key offers the task", () => {
    expect(
      wikiSuggestions(docs, "", { fromProjectKey: "ST", limit: 2 }).map(
        (s) => s.title,
      ),
    ).toEqual(["Release plan", "Roadmap"]);
    expect(
      wikiSuggestions(docs, "ops-12", { fromProjectKey: null })[0],
    ).toEqual({
      target: "OPS-12",
      title: "OPS-12",
      hint: "Task",
    });
  });
});
