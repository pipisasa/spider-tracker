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
      try {
        await listen();
      } catch (err) {
        // A failed LISTEN leaves no subscriber behind (the caller never gets its unsubscribe).
        subscribers.delete(fn);
        throw err;
      }
      return () => void subscribers.delete(fn);
    },

    /**
     * Starts listening for events `match` accepts; resolves once LISTEN is up. Subscribe before
     * reading what you wait for: an event that arrives between the read and `next` isn't lost
     * (ST-124; waiting inbox requests used to miss it and sleep until the 5 s re-check).
     * `next(ms, signal)` resolves at once if a matching event came since the last call, else on
     * the next one, after `ms`, or when `signal` aborts. Call `close` when done.
     */
    async watch(match: (event: OrgEvent) => boolean) {
      let pending = false;
      let wake: (() => void) | null = null;
      const unsubscribe = await this.subscribe((event) => {
        if (!match(event)) return;
        pending = true;
        wake?.();
      });
      return {
        async next(ms: number, signal?: AbortSignal) {
          if (!pending && !signal?.aborted) {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(done, ms);
              function done() {
                clearTimeout(timer);
                signal?.removeEventListener("abort", done);
                wake = null;
                resolve();
              }
              wake = done;
              signal?.addEventListener("abort", done, { once: true });
            });
          }
          pending = false;
        },
        close: unsubscribe,
      };
    },
  };
}

export type Realtime = ReturnType<typeof createRealtime>;
