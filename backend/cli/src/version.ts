import packageJson from "../package.json" with { type: "json" };

/** This CLI's version. */
export const CLI_VERSION: string = packageJson.version;

/** "1.2.3", "v1.2.3" or "cli-v1.2.3" (a pre-release or build suffix is ignored) → [1, 2, 3]. */
export function parseVersion(
  text: string,
): [number, number, number] | undefined {
  const match = /^(?:cli-)?v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(text.trim());
  return match
    ? [Number(match[1]), Number(match[2]), Number(match[3])]
    : undefined;
}

/** Negative when a < b, 0 when equal, positive when a > b; unparseable versions sort first. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return (x ? 1 : 0) - (y ? 1 : 0);
  for (let i = 0; i < 3; i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

/** True when `candidate` is a newer version than `current`. */
export const isNewer = (
  candidate: string | null | undefined,
  current: string,
) =>
  !!candidate &&
  !!parseVersion(candidate) &&
  compareVersions(candidate, current) > 0;
