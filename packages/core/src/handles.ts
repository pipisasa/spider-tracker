import { RESERVED_HANDLES } from "./schemas";

function toKebab(source: string, maxLength: number): string {
  return source
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, maxLength)
    .replace(/^-+|-+$/g, "");
}

/** Derives an actor handle like `jane-doe` from a name or email; never a reserved word ("me" becomes "me-1"). */
export function handleFrom(source: string): string {
  const handle = toKebab(source.split("@")[0] ?? "", 32) || "member";
  return RESERVED_HANDLES.includes(handle) ? `${handle}-1` : handle;
}

/** Turns an organization name into a slug suggestion; empty when nothing usable is left. */
export function slugFrom(name: string): string {
  return toKebab(name, 40);
}
