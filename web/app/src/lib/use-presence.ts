import { useQuery } from "@tanstack/react-query";
import { useMemo, useSyncExternalStore } from "react";
import { workingActorIds } from "./presence";
import { presenceQuery } from "./work";

// One shared clock for every component showing presence: "working now" must lapse without a refetch.
const TICK_MS = 15_000;
const listeners = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const fn of listeners) fn();
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) clearInterval(timer);
  };
}

const getNow = () => now;

const projectKeyOf = (taskKey: string) =>
  taskKey.slice(0, taskKey.lastIndexOf("-"));

/** Ids of the agents working on a task right now. The project's presence is fetched once and shared. */
export function useWorkingNow(orgSlug: string, taskKey: string): string[] {
  const { data } = useQuery(presenceQuery(orgSlug, projectKeyOf(taskKey)));
  const clock = useSyncExternalStore(subscribe, getNow);
  return useMemo(
    () => workingActorIds(data ?? [], taskKey, clock),
    [data, taskKey, clock],
  );
}
