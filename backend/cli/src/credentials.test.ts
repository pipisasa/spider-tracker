import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultAgent,
  findAgent,
  putAgent,
  readStore,
  removeAgent,
  resolveServer,
  serverForLink,
  writeStore,
  type Store,
} from "./credentials";

const agent = (handle: string, token = `spt_${handle}`) => ({
  token,
  actor: { name: handle, handle },
  projects: null,
  source: "invite" as const,
  createdAt: "2026-01-01T00:00:00.000Z",
});

function twoServers(): Store {
  const store: Store = { version: 2, servers: {} };
  const prod = resolveServer(store, "prod");
  const local = resolveServer(store, "local");
  putAgent(
    store,
    prod.key,
    prod.server,
    { slug: "batele", name: "Batele" },
    agent("reviewer"),
  );
  putAgent(
    store,
    prod.key,
    prod.server,
    { slug: "batele", name: "Batele" },
    agent("writer"),
  );
  putAgent(
    store,
    local.key,
    local.server,
    { slug: "batele", name: "Batele" },
    agent("writer", "spt_local"),
  );
  return store;
}

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "spider-cred-"));
  dirs.push(dir);
  return dir;
};
afterEach(() =>
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })),
);

describe("credentials", () => {
  test("a v1 file is migrated on read and rewritten nested, keeping the key", async () => {
    const dir = tempDir();
    const env = { SPIDER_CONFIG_DIR: dir };
    const v1 = {
      apiUrl: "https://tracker-api.batele.plus",
      token: "spt_old",
      actor: { handle: "cli-box", name: "spider CLI · Box" },
      organization: { slug: "batele", name: "Batele" },
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    writeFileSync(join(dir, "credentials.json"), JSON.stringify(v1));
    const store = await readStore(env);
    expect(store).toEqual({
      version: 2,
      default: { server: "prod", org: "batele", agent: "cli-box" },
      servers: {
        prod: {
          name: "Prod tracker",
          url: "https://tracker-api.batele.plus",
          webUrl: "https://tracker.batele.plus",
          orgs: {
            batele: {
              name: "Batele",
              agents: {
                "cli-box": {
                  token: "spt_old",
                  actor: { name: "spider CLI · Box", handle: "cli-box" },
                  projects: null,
                  source: "login",
                  createdAt: "2026-01-01T00:00:00.000Z",
                },
              },
            },
          },
        },
      },
    });
    await writeStore(env, store);
    expect(
      JSON.parse(readFileSync(join(dir, "credentials.json"), "utf8")),
    ).toEqual(store);
    expect(
      (statSync(join(dir, "credentials.json")).mode & 0o777).toString(8),
    ).toBe("600");

    // An unknown server is named after its host.
    writeFileSync(
      join(dir, "credentials.json"),
      JSON.stringify({ ...v1, apiUrl: "https://spider.example.com:8443/" }),
    );
    expect(Object.keys((await readStore(env)).servers)).toEqual([
      "spider.example.com-8443",
    ]);
  });

  test("no file is an empty store; a corrupt, unknown or unreadable file is an error", async () => {
    const dir = tempDir();
    const env = { SPIDER_CONFIG_DIR: dir };
    expect(await readStore(env)).toEqual({ version: 2, servers: {} });
    const path = join(dir, "credentials.json");
    writeFileSync(path, '{"version": 2, "servers": {"prod": "spt_leak');
    await expect(readStore(env)).rejects.toMatchObject({
      exitCode: 1,
      message: expect.stringContaining("isn't valid JSON"),
    });
    await expect(readStore(env)).rejects.not.toMatchObject({
      message: expect.stringContaining("spt_leak"),
    });
    writeFileSync(path, '{"version": 9, "servers": {}}');
    await expect(readStore(env)).rejects.toThrow("unknown version 9");
    writeFileSync(
      path,
      JSON.stringify({
        version: 2,
        servers: { prod: { url: "u", orgs: { a: { name: "A", agents: { b: { token: 1 } } } } } },
      }),
    );
    await expect(readStore(env)).rejects.toThrow(
      "unexpected content at servers.prod.orgs.a.agents.b",
    );
    writeFileSync(path, JSON.stringify({ hello: "world" }));
    await expect(readStore(env)).rejects.toThrow("isn't a known older format");
    rmSync(path);
    mkdirSync(path);
    await expect(readStore(env)).rejects.toThrow("can't be read (EISDIR)");
    const valid = twoServers();
    rmSync(path, { recursive: true });
    await writeStore(env, valid);
    expect(await readStore(env)).toEqual(valid);
  });

  test("refs: unique handle, org/handle, server/org/handle; ambiguous and unknown refs are usage errors", () => {
    const store = twoServers();
    expect(findAgent(store, "reviewer").ref).toBe("prod/batele/reviewer");
    expect(findAgent(store, "@reviewer").ref).toBe("prod/batele/reviewer");
    expect(findAgent(store, "local/batele/writer").saved.token).toBe(
      "spt_local",
    );
    expect(() => findAgent(store, "batele/writer")).toThrow(
      '"batele/writer" is ambiguous: prod/batele/writer, local/batele/writer',
    );
    expect(() => findAgent(store, "nobody")).toThrow(
      "Saved agents: prod/batele/reviewer",
    );
    try {
      findAgent(store, "writer");
    } catch (err) {
      expect(err).toMatchObject({ exitCode: 2 });
    }
  });

  test("default: the marked one, else the only one; removing it clears it", () => {
    const store = twoServers();
    expect(defaultAgent(store)).toBeUndefined();
    store.default = { server: "local", org: "batele", agent: "writer" };
    expect(defaultAgent(store)?.ref).toBe("local/batele/writer");
    removeAgent(store, { server: "local", org: "batele", agent: "writer" });
    expect(store.default).toBeUndefined();
    expect(store.servers.local).toBeUndefined();
    removeAgent(store, { server: "prod", org: "batele", agent: "writer" });
    expect(defaultAgent(store)?.ref).toBe("prod/batele/reviewer");
  });

  test("servers by name or URL; invite links map their web host to the API", () => {
    const store: Store = { version: 2, servers: {} };
    expect(resolveServer(store, "local").server.url).toBe(
      "http://localhost:4000",
    );
    expect(resolveServer(store, "https://tracker-api.batele.plus/").key).toBe(
      "prod",
    );
    expect(resolveServer(store, "https://other.test/").server).toEqual({
      url: "https://other.test",
    });
    expect(() => resolveServer(store, "staging")).toThrow(
      'Unknown server "staging"',
    );
    expect(
      serverForLink(store, "https://tracker.batele.plus/agent-invite/ABCD-EFGH")
        ?.key,
    ).toBe("prod");
    expect(
      serverForLink(store, "http://localhost:5173/agent-invite/ABCD-EFGH")
        ?.server.url,
    ).toBe("http://localhost:4000");
    expect(serverForLink(store, "ABCD-EFGH")).toBeUndefined();
  });
});
