// Task keys in git: branch names, commit messages and PR titles. Browser-safe (no database).
import { toKebab } from "./handles";
import { parseTaskKey } from "./schemas";

/** The task-key shape of parseTaskKey: 2–10 letters or digits starting with a letter, a dash, 1–9 digits. */
const KEY = String.raw`[A-Za-z][A-Za-z0-9]{1,9}-\d{1,9}`;

/** A task key at the start of the branch name or after a separator, e.g. "st-12-fix" or "feat/ST-12". */
const KEY_IN_BRANCH = new RegExp(String.raw`(?:^|[^A-Za-z0-9])(${KEY})(?!\d)`);

/** A whole-word task key in free text: "xST-1" and "ST-123x" don't count, "ST-123" is never "ST-12". */
const KEY_IN_TEXT = new RegExp(String.raw`(?<![A-Za-z0-9])(${KEY})(?![A-Za-z0-9])`, "g");

/** "Fixes ST-12", "closes: ST-12", "resolved ST-12" (any case). */
const CLOSING_KEY = new RegExp(
  String.raw`(?<![A-Za-z0-9])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+(${KEY})(?![A-Za-z0-9])`,
  "gi",
);

const normalizeKey = (value: string) => {
  const parsed = parseTaskKey(value);
  return parsed ? `${parsed.projectKey}-${parsed.number}` : null;
};

const uniqueKeys = (text: string, pattern: RegExp) => {
  const keys = new Set<string>();
  for (const match of text.matchAll(pattern)) {
    const key = match[1] ? normalizeKey(match[1]) : null;
    if (key) keys.add(key);
  }
  return [...keys];
};

/** The task key a branch name refers to ("st-12-fix" → "ST-12"), or null. */
export function taskKeyFromBranch(branch: string): string | null {
  const match = KEY_IN_BRANCH.exec(branch);
  return match?.[1] ? normalizeKey(match[1]) : null;
}

/**
 * Every task key mentioned in `text`, upper-cased, without repeats, in order of appearance.
 * Matching is purely syntactic ("UTF-8" and "SHA-256" match too); callers keep the keys of projects that exist.
 */
export function taskKeysIn(text: string): string[] {
  return uniqueKeys(text, KEY_IN_TEXT);
}

/** The task keys `text` closes with a keyword: "fixes ST-12", "Closes: ST-3", "resolved st-7". */
export function closingKeysIn(text: string): string[] {
  return uniqueKeys(text, CLOSING_KEY);
}

/** The branch to work on a task in: "st-12-short-title" (the title part at most 40 characters), or "st-12". */
export function branchNameFor(key: string, title: string): string {
  const prefix = key.toLowerCase();
  const slug = toKebab(title, 40);
  return slug ? `${prefix}-${slug}` : prefix;
}
