import { useEffect, useRef } from "react";
import { EMPTY_SEQUENCE, advanceSequence, isEditableElement, shortcutKey, type SequenceState, type ShortcutId } from "./shortcuts";

/** True while a modal dialog, menu or popup is open (their own keys win). */
const overlayOpen = () =>
  document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]') !== null;

/** Calls `handler` for global shortcuts; ignored while typing or while a dialog is open. Return true to swallow the key. */
export function useShortcuts(handler: (id: ShortcutId) => boolean | void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    let state: SequenceState = EMPTY_SEQUENCE;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const key = shortcutKey(event);
      if (key === null) return;
      if (isEditableElement(event.target instanceof Element ? event.target : null) || overlayOpen()) {
        state = EMPTY_SEQUENCE;
        return;
      }
      const next = advanceSequence(state, key, Date.now());
      state = next.state;
      if (next.matched && ref.current(next.matched) === true) event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
