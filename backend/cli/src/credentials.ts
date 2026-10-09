import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Where `spider login` keeps its key: <config dir>/credentials.json, readable only by the user.
// SPIDER_TOKEN in the environment always wins (CI, agents).

export interface Credentials {
  apiUrl: string;
  token: string;
  actor: { handle: string; name: string };
  organization: { slug: string; name: string };
  createdAt: string;
}

/** $SPIDER_CONFIG_DIR, else ~/.config/spider-tracker; undefined without a home directory. */
export function configDir(env: Record<string, string | undefined>): string | undefined {
  if (env.SPIDER_CONFIG_DIR) return env.SPIDER_CONFIG_DIR;
  return env.HOME ? join(env.HOME, ".config", "spider-tracker") : undefined;
}

const file = (dir: string) => join(dir, "credentials.json");

export async function readCredentials(env: Record<string, string | undefined>): Promise<Credentials | null> {
  const dir = configDir(env);
  if (!dir) return null;
  try {
    const parsed = JSON.parse(await readFile(file(dir), "utf8")) as Partial<Credentials>;
    return parsed.token && parsed.apiUrl ? (parsed as Credentials) : null;
  } catch {
    return null;
  }
}

export async function writeCredentials(env: Record<string, string | undefined>, credentials: Credentials) {
  const dir = configDir(env);
  if (!dir) throw new Error("No home directory: set SPIDER_CONFIG_DIR");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(file(dir), `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  // writeFile keeps an existing file's mode; make sure it's private either way.
  await chmod(file(dir), 0o600);
  return file(dir);
}

export async function deleteCredentials(env: Record<string, string | undefined>) {
  const dir = configDir(env);
  if (dir) await rm(file(dir), { force: true });
}
