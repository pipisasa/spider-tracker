import { describe, expect, test } from "bun:test";
import { formatUnifiedDiff } from "./diff";
import type { DocumentDiffDto, DocumentVersionDto, TaskDto } from "./contracts";
import {
  actorHandle,
  commentView,
  diffNotes,
  documentDiffView,
  documentVersionView,
  projectRulesView,
  relationView,
  taskView,
} from "./views";

const task: TaskDto = {
  id: "t",
  key: "ST-1",
  number: 1,
  projectId: "p",
  kind: "task",
  title: "Views",
  description: null,
  statusId: "s1",
  priority: 1,
  parentId: null,
  parentKey: null,
  sortKey: "a0",
  startDate: null,
  targetDate: "2026-02-01",
  assigneeIds: ["a1", "a2", "a3"],
  tagIds: ["g1", "g9"],
  creatorId: "a1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  completedAt: null,
  subtasks: null,
  releaseId: null,
  shippedAt: null,
  noCode: false,
  shipping: null,
  milestoneId: null,
  milestone: null,
};
const actors = [
  { id: "a1", handle: "alice", deactivated: false },
  { id: "a2", handle: "gone", deactivated: true },
];

describe("views shared by the CLI and MCP (ST-107)", () => {
  test("a task keeps every DTO field and adds status, handles and tag names", () => {
    const view = taskView(task, {
      statuses: [{ id: "s1", name: "Todo", category: "todo" }],
      actors,
      tags: [{ id: "g1", name: "infra" }],
    });
    expect(view).toEqual({
      ...task,
      status: { id: "s1", name: "Todo", category: "todo" },
      assignees: ["alice", "gone (deactivated)", "a3"],
      tags: ["infra", "g9"],
    });
    expect(
      taskView(
        { ...task, statusId: "elsewhere" },
        { statuses: [], actors, tags: [] },
      ).status,
    ).toBeNull();
  });

  test("tasks from servers before tags get an empty tag list, and before kinds the kind task", () => {
    const old: Partial<TaskDto> = { ...task };
    delete old.tagIds;
    delete old.kind;
    const view = taskView(old as TaskDto, { statuses: [], actors, tags: [] });
    expect(view).toMatchObject({ kind: "task", tagIds: [], tags: [] });
  });

  test("comments, relations and old document versions", () => {
    expect(actorHandle(actors, "nobody")).toBe("nobody");
    const comment = {
      id: "c",
      taskKey: "ST-1",
      parentId: null,
      authorId: "a1",
      body: "Hi",
      createdAt: "x",
      editedAt: null,
    };
    expect(commentView(comment, actors)).toEqual({
      ...comment,
      author: "alice",
    });
    expect(
      relationView({ kind: "blocks", task: { key: "ST-2", title: "Next" } }),
    ).toEqual({ kind: "blocks", task: "ST-2", title: "Next" });

    const old: DocumentVersionDto = {
      documentId: "d",
      version: 1,
      title: "Spec",
      format: "md",
      authorId: null,
      createdAt: "x",
      content: "# v1",
    };
    expect(
      documentVersionView(
        {
          id: "d",
          projectKey: "ST",
          taskKey: null,
          version: 3,
          url: "https://web/d",
        },
        old,
      ),
    ).toEqual({
      ...old,
      id: "d",
      projectKey: "ST",
      taskKey: null,
      currentVersion: 3,
      url: "https://web/d",
    });
  });

  test("document diffs get their unified text; rules come from the project and its document", () => {
    const side = (version: number) => ({
      version,
      title: "Spec",
      format: "md" as const,
      authorId: null,
      createdAt: "x",
    });
    const dto: DocumentDiffDto = {
      documentId: "d",
      from: side(1),
      to: side(2),
      added: 1,
      removed: 1,
      hunks: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: [
            { kind: "removed", text: "old", oldLine: 1, newLine: null },
            { kind: "added", text: "new", oldLine: null, newLine: 1 },
          ],
        },
      ],
      trailingNewlineChanged: false,
      lineEndingsChanged: false,
    };
    expect(documentDiffView(dto)).toEqual({
      ...dto,
      diff: formatUnifiedDiff(dto.hunks, "v1", "v2"),
    });
    expect(documentDiffView(dto).diff).toStartWith(
      "--- v1\n+++ v2\n@@ -1 +1 @@\n-old\n+new",
    );
    expect(documentDiffView({ ...dto, hunks: [] }).diff).toBe("");
    expect(diffNotes(dto)).toEqual([]);
    expect(
      diffNotes({
        ...dto,
        trailingNewlineChanged: true,
        lineEndingsChanged: true,
      }),
    ).toEqual([
      "The newline at the end differs between version 1 and 2",
      "Line endings differ between version 1 and 2 (CRLF and LF)",
    ]);

    const document = {
      id: "d",
      title: "Rules",
      format: "md" as const,
      version: 3,
      updatedAt: "y",
      content: "Be kind",
      url: "https://web/d",
    };
    expect(projectRulesView({ key: "ST", name: "Spider" }, document)).toEqual({
      projectKey: "ST",
      projectName: "Spider",
      documentId: "d",
      title: "Rules",
      format: "md",
      version: 3,
      updatedAt: "y",
      content: "Be kind",
      url: "https://web/d",
    });
  });
});
