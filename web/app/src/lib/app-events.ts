import { useEffect, useRef } from "react";

// Tiny bridge between the global command palette / shortcuts and the page that owns the dialog (ST-16).
// An action is delivered as a window event; when it has to navigate first, it waits in `pending` until the target
// page mounts and claims it.

export type AppAction = "new-task" | "new-document";

const EVENT = "spider:action";
const OPEN_PALETTE = "spider:open-palette";
let pending: AppAction | null = null;

export function dispatchAction(action: AppAction) {
  window.dispatchEvent(new CustomEvent<AppAction>(EVENT, { detail: action }));
}

/** Queue an action for the page we are about to navigate to. */
export function queueAction(action: AppAction) {
  pending = action;
  // Don't let a forgotten action fire much later.
  setTimeout(() => {
    if (pending === action) pending = null;
  }, 5000);
}

export const openPalette = () => window.dispatchEvent(new Event(OPEN_PALETTE));

export function useOpenPaletteListener(handler: () => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const listener = () => ref.current();
    window.addEventListener(OPEN_PALETTE, listener);
    return () => window.removeEventListener(OPEN_PALETTE, listener);
  }, []);
}

/** Runs `handler` for the given actions: live ones, and one queued before this page mounted. */
export function useAppAction(actions: readonly AppAction[], handler: (action: AppAction) => void) {
  const ref = useRef(handler);
  ref.current = handler;
  const wanted = actions.join(",");
  // After every commit: the page may be reused for another project, so mounting alone is not enough.
  useEffect(() => {
    if (pending && wanted.split(",").includes(pending)) {
      const action = pending;
      pending = null;
      ref.current(action);
    }
  });
  useEffect(() => {
    const set = wanted.split(",");
    const listener = (e: Event) => {
      if (!(e instanceof CustomEvent)) return;
      const action = e.detail as AppAction;
      if (set.includes(action)) ref.current(action);
    };
    window.addEventListener(EVENT, listener);
    return () => window.removeEventListener(EVENT, listener);
  }, [wanted]);
}
