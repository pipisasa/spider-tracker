import { describe, expect, test } from "bun:test";
import type { OrgEvent } from "@repo/core";
import type { Db } from "@repo/db";
import { createRealtime } from "./realtime";

/** A database whose LISTEN fails the first time, then succeeds and hands over its callback. */
function fakeDb() {
  let calls = 0;
  let notify: ((payload: string) => void) | undefined;
  const client = {
    async listen(_channel: string, onNotify: (payload: string) => void) {
      calls += 1;
      if (calls === 1) throw new Error("connection refused");
      notify = onNotify;
      return {};
    },
  };
  return {
    db: { $client: client } as unknown as Db,
    emit: (event: OrgEvent) => notify?.(JSON.stringify(event)),
  };
}

const event = {
  type: "inbox.created",
  orgId: "org",
  recipientIds: ["a"],
} as unknown as OrgEvent;

describe("realtime (ST-124)", () => {
  test("a failed LISTEN leaves no subscriber behind; the next one retries", async () => {
    const { db, emit } = fakeDb();
    const realtime = createRealtime(db);
    const failed: OrgEvent[] = [];
    await expect(realtime.subscribe((e) => failed.push(e))).rejects.toThrow(
      "connection refused",
    );
    const received: OrgEvent[] = [];
    await realtime.subscribe((e) => received.push(e));
    emit(event);
    expect(received).toHaveLength(1);
    expect(failed).toEqual([]);
  });

  test("watch keeps an event that arrives before next(); next() stops on abort", async () => {
    const { db, emit } = fakeDb();
    const realtime = createRealtime(db);
    await realtime.subscribe(() => {}).catch(() => undefined);
    const watch = await realtime.watch((e) => e.type === "inbox.created");
    emit(event);
    const started = Date.now();
    await watch.next(5000);
    expect(Date.now() - started).toBeLessThan(1000);
    const stop = new AbortController();
    const waiting = watch.next(5000, stop.signal);
    stop.abort();
    await waiting;
    expect(Date.now() - started).toBeLessThan(1000);
    watch.close();
  });
});
