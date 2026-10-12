import { PRESENCE_WINDOW_MS, publish, type ActorContext, type PresenceDto } from "@repo/core";
import type { Db } from "@repo/db";

/** At most one presence event per agent and task in this period. */
export const TOUCH_EVENT_INTERVAL_MS = 60_000;

/**
 * Agents' reads of tasks (GET task, get_task, start_task, list comments), kept in memory
 * (ST-67): reads are not worth a row in the activity log. Per process, which is fine with one
 * API replica; with more, an agent's reads would only show on the replica that served them.
 */
export function createPresence(db: Db, now: () => number = Date.now) {
  // "orgId|TASK-KEY" -> actorId -> last read (ms)
  const touches = new Map<string, Map<string, number>>();
  const lastEvent = new Map<string, number>();

  const prune = (cutoff: number) => {
    for (const [taskId, byActor] of touches) {
      for (const [actorId, at] of byActor) if (at < cutoff) byActor.delete(actorId);
      if (byActor.size === 0) touches.delete(taskId);
    }
    for (const [id, at] of lastEvent) if (at < cutoff) lastEvent.delete(id);
  };

  return {
    /** Records that the agent read the task; announces it to clients at most once a minute. */
    async touch(ctx: ActorContext, taskKey: string) {
      const key = `${ctx.orgId}|${taskKey.toUpperCase()}`;
      const at = now();
      let byActor = touches.get(key);
      if (!byActor) touches.set(key, (byActor = new Map()));
      byActor.set(ctx.actorId, at);
      const eventId = `${key}|${ctx.actorId}`;
      const last = lastEvent.get(eventId);
      if (last !== undefined && at - last < TOUCH_EVENT_INTERVAL_MS) return;
      prune(at - PRESENCE_WINDOW_MS);
      lastEvent.set(eventId, at);
      // Presence is best-effort: a failed event must not fail the read that triggered it.
      try {
        await publish(db, { type: "presence", orgId: ctx.orgId, taskKey: taskKey.toUpperCase() });
      } catch (err) {
        console.error("[presence] publishing a presence event failed:", err);
      }
    },

    /** Activity-log presence plus recent reads of the project's tasks; the latest time per task and agent. */
    merge(orgId: string, projectKey: string, written: PresenceDto[], since: Date): PresenceDto[] {
      const prefix = `${orgId}|${projectKey.toUpperCase()}-`;
      const latest = new Map<string, PresenceDto>(written.map((p) => [`${p.taskKey}|${p.actorId}`, p]));
      for (const [key, byActor] of touches) {
        if (!key.startsWith(prefix)) continue;
        const taskKey = key.slice(orgId.length + 1);
        for (const [actorId, at] of byActor) {
          if (at < since.getTime()) continue;
          const id = `${taskKey}|${actorId}`;
          const seen = latest.get(id);
          if (!seen || Date.parse(seen.lastSeenAt) < at) latest.set(id, { taskKey, actorId, lastSeenAt: new Date(at).toISOString() });
        }
      }
      return [...latest.values()].sort((a, b) => (a.taskKey + a.actorId).localeCompare(b.taskKey + b.actorId));
    },
  };
}

export type Presence = ReturnType<typeof createPresence>;
