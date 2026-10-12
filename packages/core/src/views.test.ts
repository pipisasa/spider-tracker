import { describe, expect, test } from "bun:test";
import type { DocumentVersionDto, TaskDto } from "./contracts";
import { actorHandle, commentView, documentVersionView, relationView, taskView } from "./views";

const task: TaskDto = {
  id: "t",
  key: "ST-1",
  number: 1,
  projectId: "p",
  title: "Views",
  description: null,
  statusId: "s1",
  priority: 1,
  parentId: null,
  parentKey: null,
  sortKey: "a0",
  assigneeIds: ["a1", "a2", "a3"],
  tagIds: ["g1", "g9"],
  creatorId: "a1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  completedAt: null,
  subtasks: null,
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
    expect(taskView({ ...task, statusId: "elsewhere" }, { statuses: [], actors, tags: [] }).status).toBeNull();
  });

  test("tasks from servers before tags get an empty tag list", () => {
    const old: Partial<TaskDto> = { ...task };
    delete old.tagIds;
    const view = taskView(old as TaskDto, { statuses: [], actors, tags: [] });
    expect(view).toMatchObject({ tagIds: [], tags: [] });
  });

  test("comments, relations and old document versions", () => {
    expect(actorHandle(actors, "nobody")).toBe("nobody");
    const comment = { id: "c", taskKey: "ST-1", parentId: null, authorId: "a1", body: "Hi", createdAt: "x", editedAt: null };
    expect(commentView(comment, actors)).toEqual({ ...comment, author: "alice" });
    expect(relationView({ kind: "blocks", task: { key: "ST-2", title: "Next" } })).toEqual({ kind: "blocks", task: "ST-2", title: "Next" });

    const old: DocumentVersionDto = { documentId: "d", version: 1, title: "Spec", format: "md", authorId: null, createdAt: "x", content: "# v1" };
    expect(documentVersionView({ id: "d", projectKey: "ST", taskKey: null, version: 3, url: "https://web/d" }, old)).toEqual({
      ...old,
      id: "d",
      projectKey: "ST",
      taskKey: null,
      currentVersion: 3,
      url: "https://web/d",
    });
  });
});
