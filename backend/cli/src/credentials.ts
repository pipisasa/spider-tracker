import type { ProjectRefDto } from "@repo/core/contracts";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { usageError } from "./resolve";

// Saved agents: <config dir>/credentials.json, readable only by the user, nested
// server → organization → agent handle. SPIDER_TOKEN in the environment can still stand in
// for a saved agent (CI, scripts).

export interface SavedAgent {
  /** The agent's API key. Never printed. */
  token: string;
  actor: { id?: string; name: string; handle: string };
  /** The projects the agent may work in; null when unknown or all of them. */
  projects: ProjectRefDto[] | null;
  /** How the key was obtained. */
  source: "invite" | "login";
  createdAt: string;
}

export interface SavedOrg {
  name: string;
  agents: Record<string, SavedAgent>;
}

export interface Server {
  name?: string;
  /** The API origin, e.g. https://tracker-api.batele.plus. */
  url: string;
  /** The web app's origin, where invite links point. */
  webUrl?: string;
}

export interface SavedServer extends Server {
  orgs: Record<string, SavedOrg>;
}

export interface AgentPointer {
  server: string;
  org: string;
  agent: string;
}

export interface Store {
  version: 2;
  default?: AgentPointer;
  servers: Record<string, SavedServer>;
}

/** A saved agent with where it lives; `ref` is its full name, server/org/handle. */
export interface AgentEntry extends AgentPointer {
  ref: string;
  serverUrl: string;
  orgName: string;
  saved: SavedAgent;
}

/** Servers the CLI knows by name. */
export const KNOWN_SERVERS: Record<string, Required<Server>> = {
  prod: {
    name: "Prod tracker",
    url: "https://tracker-api.batele.plus",
    webUrl: "https://tracker.batele.plus",
  },
  local: {
    name: "Local",
    url: "http://localhost:4000",
    webUrl: "http://localhost:5173",
  },
};

/** $SPIDER_CONFIG_DIR, else ~/.config/spider-tracker; undefined without a home directory. */
export function configDir(
  env: Record<string, string | undefined>,
): string | undefined {
  if (env.SPIDER_CONFIG_DIR) return env.SPIDER_CONFIG_DIR;
  return env.HOME ? join(env.HOME, ".config", "spider-tracker") : undefined;
}

const file = (dir: string) => join(dir, "credentials.json");

const trimUrl = (url: string) => url.trim().replace(/\/+$/, "");
const origin = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
};

/** A name for a server not in the table: its host, e.g. "tracker.example.com" or "localhost-8080". */
const nameFromUrl = (url: string) =>
  origin(url) ? new URL(url).host.replace(/:/g, "-") : url;

/** The saved or built-in server with this name or API/web URL. */
function findServer(
  store: Store,
  nameOrUrl: string,
): { key: string; server: Server } | undefined {
  if (store.servers[nameOrUrl])
    return { key: nameOrUrl, server: store.servers[nameOrUrl] };
  if (KNOWN_SERVERS[nameOrUrl])
    return { key: nameOrUrl, server: KNOWN_SERVERS[nameOrUrl] };
  const target = origin(nameOrUrl);
  if (!target) return undefined;
  const all: [string, Server][] = [
    ...Object.entries(store.servers),
    ...Object.entries(KNOWN_SERVERS),
  ];
  const found = all.find(
    ([, s]) =>
      origin(s.url) === target || (s.webUrl && origin(s.webUrl) === target),
  );
  return found && { key: found[0], server: found[1] };
}

/** `--server` (a name or an API URL) → the server to talk to; unknown URLs get a name from their host. */
export function resolveServer(
  store: Store,
  nameOrUrl: string,
): { key: string; server: Server } {
  const value = nameOrUrl.trim();
  const found = findServer(store, value);
  if (found) return found;
  if (!origin(value)) {
    const names = [
      ...new Set([
        ...Object.keys(store.servers),
        ...Object.keys(KNOWN_SERVERS),
      ]),
    ];
    throw usageError(
      `Unknown server "${value}". Use a URL or one of: ${names.join(", ")}`,
    );
  }
  return { key: nameFromUrl(value), server: { url: trimUrl(value) } };
}

/** The server an invite link points at (its web or API origin), if the CLI knows it. */
export function serverForLink(
  store: Store,
  link: string,
): { key: string; server: Server } | undefined {
  return /^https?:\/\//i.test(link.trim())
    ? findServer(store, link.trim())
    : undefined;
}

const emptyStore = (): Store => ({ version: 2, servers: {} });

interface V1Credentials {
  apiUrl: string;
  token: string;
  actor: { handle: string; name: string };
  organization: { slug: string; name: string };
  createdAt?: string;
}

/** The single key `spider login` saved before agents were nested. */
export function migrateV1(old: V1Credentials): Store {
  const store = emptyStore();
  const { key, server } = resolveServer(store, old.apiUrl);
  putAgent(store, key, server, old.organization, {
    token: old.token,
    actor: { name: old.actor.name, handle: old.actor.handle },
    projects: null,
    source: "login",
    createdAt: old.createdAt ?? new Date().toISOString(),
  });
  store.default = {
    server: key,
    org: old.organization.slug,
    agent: old.actor.handle,
  };
  return store;
}

/** The saved agents (an empty store when there is no file); an old single-key file is migrated. */
export async function readStore(
  env: Record<string, string | undefined>,
): Promise<Store> {
  const dir = configDir(env);
  if (!dir) return emptyStore();
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file(dir), "utf8"));
  } catch {
    return emptyStore();
  }
  if (typeof parsed !== "object" || parsed === null) return emptyStore();
  if ("version" in parsed && parsed.version === 2 && "servers" in parsed)
    return parsed as Store;
  const old = parsed as Partial<V1Credentials>;
  if (old.token && old.apiUrl && old.actor?.handle && old.organization?.slug)
    return migrateV1(old as V1Credentials);
  return emptyStore();
}

/** Saves the store (temp file + rename, 0600 in a 0700 directory); removes the file once it holds no agents. */
export async function writeStore(
  env: Record<string, string | undefined>,
  store: Store,
) {
  const dir = configDir(env);
  if (!dir) throw new Error("No home directory: set SPIDER_CONFIG_DIR");
  const path = file(dir);
  if (listAgents(store).length === 0) {
    await rm(path, { force: true });
    return path;
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, path);
  return path;
}

export const refOf = (p: AgentPointer) => `${p.server}/${p.org}/${p.agent}`;

export function listAgents(store: Store): AgentEntry[] {
  return Object.entries(store.servers).flatMap(([server, s]) =>
    Object.entries(s.orgs).flatMap(([org, o]) =>
      Object.entries(o.agents).map(([agent, saved]) => ({
        server,
        org,
        agent,
        ref: refOf({ server, org, agent }),
        serverUrl: s.url,
        orgName: o.name,
        saved,
      })),
    ),
  );
}

/** `handle`, `org/handle` or `server/org/handle` → the saved agent; unknown or ambiguous refs are usage errors. */
export function findAgent(store: Store, ref: string): AgentEntry {
  const parts = ref.trim().replace(/^@/, "").split("/");
  const all = listAgents(store);
  const known = all.length
    ? ` Saved agents: ${all.map((a) => a.ref).join(", ")}`
    : " No agents are saved yet.";
  if (parts.length > 3 || parts.some((p) => !p))
    throw usageError(
      `Invalid agent "${ref}". Use handle, org/handle or server/org/handle.`,
    );
  const [handle, org, server] = [...parts].reverse();
  const matches = all.filter(
    (a) =>
      a.agent === handle &&
      (org === undefined || a.org === org) &&
      (server === undefined || a.server === server),
  );
  if (matches.length === 1 && matches[0]) return matches[0];
  if (matches.length === 0)
    throw usageError(`No saved agent "${ref}".${known}`);
  throw usageError(
    `"${ref}" is ambiguous: ${matches.map((a) => a.ref).join(", ")}`,
  );
}

/** The default agent: the one marked default, else the only one saved. */
export function defaultAgent(store: Store): AgentEntry | undefined {
  const all = listAgents(store);
  const d = store.default;
  return (
    (d &&
      all.find(
        (a) => a.server === d.server && a.org === d.org && a.agent === d.agent,
      )) ??
    (all.length === 1 ? all[0] : undefined)
  );
}

/** Adds or replaces an agent; returns its full ref. */
export function putAgent(
  store: Store,
  serverKey: string,
  server: Server,
  org: { slug: string; name: string },
  agent: SavedAgent,
): string {
  const saved = (store.servers[serverKey] ??= {
    ...server,
    url: trimUrl(server.url),
    orgs: {},
  });
  const savedOrg = (saved.orgs[org.slug] ??= { name: org.name, agents: {} });
  savedOrg.name = org.name;
  savedOrg.agents[agent.actor.handle] = agent;
  return refOf({ server: serverKey, org: org.slug, agent: agent.actor.handle });
}

/** Forgets an agent (and empty parents); a removed default falls back to none. */
export function removeAgent(store: Store, entry: AgentPointer) {
  const server = store.servers[entry.server];
  const org = server?.orgs[entry.org];
  if (!server || !org) return;
  delete org.agents[entry.agent];
  if (Object.keys(org.agents).length === 0) delete server.orgs[entry.org];
  if (Object.keys(server.orgs).length === 0) delete store.servers[entry.server];
  const d = store.default;
  if (
    d &&
    d.server === entry.server &&
    d.org === entry.org &&
    d.agent === entry.agent
  )
    delete store.default;
}
