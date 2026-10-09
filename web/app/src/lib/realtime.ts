import type { OrgEvent } from "@repo/core/events";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { apiUrl } from "./api";
import { keys } from "./work";

/**
 * Subscribes to the organization's change events (SSE) and refreshes the affected queries,
 * so boards, lists and task pages update across tabs and when agents make changes.
 * EventSource reconnects on its own; after a reconnect everything is refetched once.
 */
export function useOrgEvents(orgSlug: string) {
  const qc = useQueryClient();

  useEffect(() => {
    const source = new EventSource(`${apiUrl}/v1/orgs/${encodeURIComponent(orgSlug)}/events`, { withCredentials: true });
    let connectedBefore = false;

    const on = <T extends OrgEvent["type"]>(type: T, handle: (event: OrgEvent & { type: T }) => void) =>
      source.addEventListener(type, (message) => handle(JSON.parse((message as MessageEvent<string>).data)));

    source.addEventListener("ready", () => {
      // Missed events while disconnected: refresh this organization's data.
      if (connectedBefore) void qc.invalidateQueries({ queryKey: ["orgs", orgSlug] });
      connectedBefore = true;
    });
    // A child's change can alter any parent's sub-task list; those lists are small.
    const refreshSubtasks = () =>
      void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === "orgs" && q.queryKey[1] === orgSlug && q.queryKey[4] === "subtasks" });
    on("task.changed", (e) => {
      refreshSubtasks();
      void qc.invalidateQueries({ queryKey: keys.tasks(orgSlug, e.projectKey) });
      void qc.invalidateQueries({ queryKey: keys.task(orgSlug, e.taskKey), exact: true });
      void qc.invalidateQueries({ queryKey: keys.activity(orgSlug, e.taskKey) });
    });
    on("task.deleted", (e) => {
      refreshSubtasks();
      void qc.invalidateQueries({ queryKey: keys.tasks(orgSlug, e.projectKey) });
      qc.removeQueries({ queryKey: keys.task(orgSlug, e.taskKey), exact: true });
    });
    on("comment.created", (e) => {
      void qc.invalidateQueries({ queryKey: keys.comments(orgSlug, e.taskKey) });
      void qc.invalidateQueries({ queryKey: keys.activity(orgSlug, e.taskKey) });
    });
    on("project.changed", () => void qc.invalidateQueries({ queryKey: keys.projects(orgSlug) }));
    on("tags.changed", () => {
      void qc.invalidateQueries({ queryKey: keys.tags(orgSlug) });
      // Deleting a tag removes it from tasks.
      void qc.invalidateQueries({ queryKey: ["orgs", orgSlug, "projects"] });
    });

    return () => source.close();
  }, [orgSlug, qc]);
}
