import type { PresenceDto } from "@repo/core/contracts";

/** How long an agent counts as "working now" after it last acted on or read a task (matches the API). */
export const PRESENCE_WINDOW_MS = 10 * 60_000;

/** Whether a presence entry is still "working now" at `now` (ms). Future times (clock skew) count. */
export function isWorkingNow(
  lastSeenAt: string,
  now: number,
  windowMs = PRESENCE_WINDOW_MS,
): boolean {
  const seen = Date.parse(lastSeenAt);
  return Number.isFinite(seen) && now - seen < windowMs;
}

/** Ids of the agents working on a task at `now`. */
export function workingActorIds(
  items: PresenceDto[],
  taskKey: string,
  now: number,
): string[] {
  return items
    .filter((p) => p.taskKey === taskKey && isWorkingNow(p.lastSeenAt, now))
    .map((p) => p.actorId);
}
