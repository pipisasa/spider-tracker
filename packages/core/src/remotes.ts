// Git remotes of repos (ST-92): "owner/name" from the URLs `git remote -v` prints. Browser-safe.

/** A GitHub repo, as `owner/name`. */
export interface RepoRemote {
  owner: string;
  name: string;
}

/** GitHub user or organization names: letters, digits and single inner dashes, up to 39 characters. */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
/** GitHub repo names: letters, digits, ".", "-" and "_", up to 100 characters; not "." or "..". */
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);

/** Where a remote points: its host (null for a bare "owner/name") and path. */
function splitRemote(
  input: string,
): { host: string | null; path: string } | null {
  // URLs: https://, http://, ssh://, git://, git+ssh://
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    try {
      const url = new URL(input);
      return {
        host: url.hostname.toLowerCase(),
        path: decodeURIComponent(url.pathname),
      };
    } catch {
      return null;
    }
  }
  // scp-like SSH: git@github.com:owner/name.git
  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(input);
  if (scp?.[1] && scp[2]) return { host: scp[1].toLowerCase(), path: scp[2] };
  // "github.com/owner/name" without a scheme.
  const [first, ...rest] = input.split("/");
  if (first && rest.length >= 2 && first.includes("."))
    return { host: first.toLowerCase(), path: rest.join("/") };
  return { host: null, path: input };
}

/**
 * The GitHub `owner/name` of a remote URL ("https://github.com/o/r.git", "git@github.com:o/r.git",
 * "ssh://git@github.com/o/r") or of a plain "o/r"; null when it isn't one. Other hosts aren't
 * supported: a repo is identified by its GitHub owner and name.
 */
export function parseRepoRemote(input: string): RepoRemote | null {
  const trimmed = input.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  const remote = splitRemote(trimmed);
  if (!remote || (remote.host !== null && !GITHUB_HOSTS.has(remote.host)))
    return null;
  const parts = remote.path
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .split("/");
  if (parts.length !== 2) return null;
  const [owner, name] = parts as [string, string];
  if (!OWNER.test(owner) || !NAME.test(name) || name === "." || name === "..")
    return null;
  return { owner, name };
}

/** "owner/name". */
export const repoFullName = (remote: RepoRemote) =>
  `${remote.owner}/${remote.name}`;
