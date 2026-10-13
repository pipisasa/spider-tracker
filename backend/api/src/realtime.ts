import { EVENTS_CHANNEL, type OrgEvent } from "@repo/core";
import type { Db } from "@repo/db";
import { createPresence } from "./presence";

/**
 * Fans committed change events (pg_notify) out to in-process subscribers: SSE streams and
 * waiting inbox requests. One LISTEN connection per API instance, opened on first use;
 * postgres.js reconnects it if it drops.
 */
export function createRealtime(db: Db) {
  const subscribers = new Set<(event: OrgEvent) => void>();
  let listening: Promise<unknown> | undefined;

  const listen = () =>
    (listening ??= db.$client
      .listen(EVENTS_CHANNEL, (payload) => {
        let event: OrgEvent;
        try {
          event = JSON.parse(payload) as OrgEvent;
        } catch {
          return;
        }
        for (const fn of subscribers) fn(event);
      })
      .catch((err: unknown) => {
        // Let the next subscriber retry instead of caching a failed LISTEN.
        listening = undefined;
        throw err;
      }));

  const presence = createPresence(db);

  return {
    /** Agents' reads of tasks (in memory), for "working now" (ST-67). */
    presence,

    /** Calls `fn` for every event until the returned function is called. */
    async subscribe(fn: (event: OrgEvent) => void) {
      subscribers.add(fn);
      await listen();
      return () => void subscribers.delete(fn);
    },

    /** Resolves when `match` accepts an event, or after `ms`, or when `signal` aborts. */
    async waitFor(
      match: (event: OrgEvent) => boolean,
      ms: number,
      signal?: AbortSignal,
    ) {
      let done: () => void = () => {};
      const settled = new Promise<void>((resolve) => (done = resolve));
      const unsubscribe = await this.subscribe(
        (event) => match(event) && done(),
      );
      const timer = setTimeout(done, ms);
      signal?.addEventListener("abort", done, { once: true });
      await settled;
      clearTimeout(timer);
      unsubscribe();
    },
  };
}

export type Realtime = ReturnType<typeof createRealtime>;
