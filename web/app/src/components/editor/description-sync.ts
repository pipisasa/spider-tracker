/**
 * Decides what a text field backed by the server (a task description) does when
 * the server copy changes while the page is open, and when an edit may be saved.
 * `null` and "" are the same empty value.
 */
const norm = (value: string | null): string => value ?? "";

export type RemoteChange =
  /** The server value is the one the edit started from. */
  | "none"
  /** Not edited here: load the server value into the editor. */
  | "remount"
  /** Edited here and the server now holds exactly that: just move the baseline. */
  | "adopt"
  /** Edited here and someone else changed it too: keep ours, ask before saving. */
  | "conflict";

export function remoteChange(input: {
  server: string | null;
  baseline: string | null;
  draft: string;
  dirty: boolean;
  /**
   * The description of a save still in flight. The optimistic cache write echoes
   * it back as the server value; that is not a success (it may be rolled back),
   * so it counts as no change until the save settles.
   */
  saving?: string | null;
}): RemoteChange {
  if (norm(input.server) === norm(input.baseline)) return "none";
  if (input.saving !== undefined && norm(input.server).trim() === norm(input.saving).trim())
    return "none";
  if (!input.dirty) return "remount";
  return input.draft.trim() === norm(input.server).trim() ? "adopt" : "conflict";
}

/**
 * After a save succeeded: the baseline moves to what was saved, and the editor is
 * clean unless the user kept typing while the save was in flight.
 */
export function afterSave(input: { saved: string | null; draft: string }): { baseline: string | null; dirty: boolean } {
  return { baseline: input.saved, dirty: input.draft.trim() !== norm(input.saved).trim() };
}

/**
 * What to send on blur: `undefined` means don't save (nothing was edited, or the
 * edit leaves the server value unchanged), otherwise the description to write.
 */
export function descriptionToSave(input: {
  dirty: boolean;
  draft: string;
  server: string | null;
}): string | null | undefined {
  if (!input.dirty) return undefined;
  const next = input.draft.trim() ? input.draft : null;
  return next === input.server ? undefined : next;
}
