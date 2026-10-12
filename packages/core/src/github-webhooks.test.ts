import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, schema } from "@repo/db";
import { and, eq, inArray } from "drizzle-orm";
import { createHmac } from "node:crypto";
import type { ActorContext } from "./access";
import { listGithubInstallations, saveGithubInstallation } from "./github";
import { handleGithubWebhook, verifyGithubSignature } from "./github-webhooks";
import { createOrganization } from "./organizations";
import { createProject } from "./projects";
import { createRepo, getRepo, listRepos } from "./repos";

const SECRET = "webhook-secret";
const sign = (body: string, secret = SECRET) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
const bytes = (s: string) => new TextEncoder().encode(s);

describe("GitHub webhook signatures (ST-83)", () => {
  const body = JSON.stringify({ zen: "Keep it logically awesome.", hook_id: 1 });

  test("accepts the HMAC-SHA256 of the exact bytes", () => {
    expect(verifyGithubSignature(SECRET, bytes(body), sign(body))).toBe(true);
    expect(verifyGithubSignature(SECRET, bytes(body), sign(body).toUpperCase().replace("SHA256=", "sha256="))).toBe(true);
  });

  test("refuses the same JSON with other whitespace, another secret and malformed headers", () => {
    const reformatted = JSON.stringify(JSON.parse(body), null, 2);
    expect(verifyGithubSignature(SECRET, bytes(reformatted), sign(body))).toBe(false);
    expect(verifyGithubSignature(SECRET, bytes(`${body} `), sign(body))).toBe(false);
    expect(verifyGithubSignature("another-secret", bytes(body), sign(body))).toBe(false);
    expect(verifyGithubSignature(SECRET, bytes(body), sign(body).replace("sha256=", "sha1="))).toBe(false);
    expect(verifyGithubSignature(SECRET, bytes(body), sign(body).slice(0, -2))).toBe(false);
    expect(verifyGithubSignature(SECRET, bytes(body), "")).toBe(false);
    expect(verifyGithubSignature(SECRET, bytes(body), null)).toBe(false);
    expect(verifyGithubSignature(SECRET, bytes(body), undefined)).toBe(false);
  });
});

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run("GitHub webhooks (ST-83)", () => {
  const db = createDb(url ?? "");
  const userId = `test-${crypto.randomUUID()}`;
  const stamp = Date.now();
  const slug = `gh-hooks-${stamp}`;
  // GitHub ids are global: unique per run (and apart from github.test.ts's).
  const installationId = stamp + 100;
  const unknownInstallationId = stamp + 101;
  let owner: ActorContext;
  let n = 0;
  const deliveries: string[] = [];
  const nextDelivery = () => {
    const id = `${stamp}-${++n}-${crypto.randomUUID()}`;
    deliveries.push(id);
    return id;
  };

  const deliver = (event: string, payload: unknown, deliveryId = nextDelivery()) => handleGithubWebhook(db, { deliveryId, event, payload });
  const installationRef = (id = installationId) => ({ id, account: { login: "acme" } });

  async function activity(action: string) {
    const rows = await db
      .select()
      .from(schema.activity)
      .where(and(eq(schema.activity.orgId, owner.orgId), eq(schema.activity.action, action)));
    return rows;
  }

  async function delivery(id: string) {
    const [row] = await db.select().from(schema.githubDeliveries).where(eq(schema.githubDeliveries.id, id));
    return row;
  }

  beforeAll(async () => {
    await db.insert(schema.user).values({ id: userId, name: "Owner", email: `${userId}@example.com` });
    const created = await createOrganization(db, { id: userId, name: "Owner", email: "owner@example.com" }, { name: "Hooks", slug });
    owner = { orgId: created.organization.id, actorId: created.actor.id, role: "owner", source: "ui" };
    await createProject(db, owner, { name: "Spider", key: "ST" });
    await createRepo(db, owner, { url: "acme/web", projects: ["ST"] });
    await saveGithubInstallation(db, owner, {
      installation: { id: installationId, account: "acme", accountType: "Organization", repositorySelection: "selected", suspended: false },
      repositories: [{ owner: "acme", name: "web", defaultBranch: "main" }],
    });
  });

  afterAll(async () => {
    await db.delete(schema.githubDeliveries).where(inArray(schema.githubDeliveries.id, deliveries));
    await db.delete(schema.organizations).where(eq(schema.organizations.slug, slug));
    await db.delete(schema.user).where(eq(schema.user.id, userId));
    await db.$client.end();
  });

  test("ping and unhandled events are recorded and ignored", async () => {
    const ping = nextDelivery();
    expect(await deliver("ping", { zen: "Design for failure.", hook_id: 1 }, ping)).toBe("ignored");
    expect(await delivery(ping)).toMatchObject({ event: "ping", action: null, installationId: null, orgId: null, result: "ignored" });

    const checks = nextDelivery();
    expect(await deliver("check_run", { action: "completed", installation: { id: installationId } }, checks)).toBe("ignored");
    expect(await delivery(checks)).toMatchObject({ event: "check_run", action: "completed", installationId, result: "ignored" });
  });

  test("events of installations no organization has connected are recorded and ignored", async () => {
    const id = nextDelivery();
    const result = await deliver(
      "installation_repositories",
      {
        action: "added",
        installation: installationRef(unknownInstallationId),
        repository_selection: "selected",
        repositories_added: [{ full_name: "stranger/repo" }],
        repositories_removed: [],
      },
      id,
    );
    expect(result).toBe("ignored");
    expect(await delivery(id)).toMatchObject({ event: "installation_repositories", action: "added", installationId: unknownInstallationId, orgId: null });
    expect((await listRepos(db, owner)).map((r) => r.fullName)).toEqual(["acme/web"]);
  });

  test("repositories added and removed: existing rows get the installation, new ones are added, removed ones released", async () => {
    await createRepo(db, owner, { url: "acme/docs" });
    const id = nextDelivery();
    const result = await deliver(
      "installation_repositories",
      {
        action: "added",
        installation: installationRef(),
        repository_selection: "selected",
        repositories_added: [{ full_name: "Acme/Docs" }, { full_name: "acme/api" }],
        repositories_removed: [],
      },
      id,
    );
    expect(result).toBe("processed");
    expect(await delivery(id)).toMatchObject({ orgId: owner.orgId, result: "processed" });
    expect((await listRepos(db, owner)).map((r) => [r.fullName, r.githubInstallationId, r.defaultBranch])).toEqual([
      ["acme/api", installationId, "main"],
      ["acme/docs", installationId, "main"],
      ["acme/web", installationId, "main"],
    ]);

    expect(
      await deliver("installation_repositories", {
        action: "removed",
        installation: installationRef(),
        repository_selection: "selected",
        repositories_added: [],
        repositories_removed: [{ full_name: "acme/docs" }],
      }),
    ).toBe("processed");
    expect((await getRepo(db, owner, "acme/docs")).githubInstallationId).toBeNull();

    // Attributed to the GitHub bot, source git.
    const changes = await activity("github.repos_changed");
    expect(changes.map((a) => a.changes)).toEqual([
      { installation: installationId, account: "acme", attached: ["acme/docs"], added: ["acme/api"] },
      { installation: installationId, account: "acme", released: ["acme/docs"] },
    ]);
    const [bot] = await db
      .select()
      .from(schema.actors)
      .where(and(eq(schema.actors.orgId, owner.orgId), eq(schema.actors.type, "integration")));
    expect(changes.every((a) => a.actorId === bot?.id && a.source === "git")).toBe(true);
    const [created] = await db
      .select()
      .from(schema.activity)
      .where(and(eq(schema.activity.orgId, owner.orgId), eq(schema.activity.action, "repo.created"), eq(schema.activity.actorId, bot?.id ?? "")));
    expect(created?.changes).toMatchObject({ repo: "acme/api", githubInstallationId: installationId });
  });

  test("a delivery is handled once, also when copies arrive together", async () => {
    const payload = {
      action: "added",
      installation: installationRef(),
      repository_selection: "selected",
      repositories_added: [{ full_name: "acme/parallel" }],
      repositories_removed: [],
    };
    const id = nextDelivery();
    const results = await Promise.all(Array.from({ length: 5 }, () => deliver("installation_repositories", payload, id)));
    expect(results.filter((r) => r === "processed")).toHaveLength(1);
    expect(results.filter((r) => r === "duplicate")).toHaveLength(4);
    // Redelivered later: still once.
    expect(await deliver("installation_repositories", payload, id)).toBe("duplicate");
    const added = (await activity("github.repos_changed")).filter((a) => JSON.stringify(a.changes).includes("acme/parallel"));
    expect(added).toHaveLength(1);
  });

  test("a payload that doesn't match is refused and not recorded, so a redelivery is handled", async () => {
    const id = nextDelivery();
    await expect(deliver("installation_repositories", { action: "added", installation: installationRef(), repositories_added: "x" }, id)).rejects.toMatchObject({
      code: "validation",
    });
    expect(await delivery(id)).toBeUndefined();
    await expect(deliver("ping", {}, "not a delivery id")).rejects.toMatchObject({ code: "validation" });
    await expect(deliver("Not An Event", {})).rejects.toMatchObject({ code: "validation" });
    expect(
      await deliver(
        "installation_repositories",
        { action: "removed", installation: installationRef(), repositories_added: [], repositories_removed: [{ full_name: "acme/parallel" }] },
        id,
      ),
    ).toBe("processed");
  });

  test("repository renamed, transferred and edited update the row", async () => {
    const repository = (owner: string, name: string, defaultBranch = "main") => ({ name, owner: { login: owner }, default_branch: defaultBranch });
    expect(
      await deliver("repository", {
        action: "renamed",
        installation: { id: installationId },
        repository: repository("acme", "website"),
        changes: { repository: { name: { from: "web" } } },
      }),
    ).toBe("processed");
    const renamed = await getRepo(db, owner, "acme/website");
    expect(renamed.projects).toEqual(["ST"]);

    expect(
      await deliver("repository", {
        action: "transferred",
        installation: { id: installationId },
        repository: repository("acme-inc", "website"),
        changes: { owner: { from: { organization: { login: "acme" } } } },
      }),
    ).toBe("processed");
    expect((await getRepo(db, owner, "acme-inc/website")).id).toBe(renamed.id);

    expect(
      await deliver("repository", {
        action: "edited",
        installation: { id: installationId },
        repository: repository("acme-inc", "website", "trunk"),
        changes: { default_branch: { from: "main" } },
      }),
    ).toBe("processed");
    expect((await getRepo(db, owner, "acme-inc/website")).defaultBranch).toBe("trunk");

    const updates = await activity("repo.updated");
    expect(updates.map((a) => [a.source, a.changes])).toEqual([
      ["git", { repo: ["acme/web", "acme/website"] }],
      ["git", { repo: ["acme/website", "acme-inc/website"] }],
      ["git", { defaultBranch: ["main", "trunk"] }],
    ]);

    // Repos the organization doesn't have, a name another row has, other actions: ignored.
    expect(
      await deliver("repository", {
        action: "renamed",
        installation: { id: installationId },
        repository: repository("acme", "nope"),
        changes: { repository: { name: { from: "unknown" } } },
      }),
    ).toBe("ignored");
    expect(
      await deliver("repository", {
        action: "renamed",
        installation: { id: installationId },
        repository: repository("acme", "api"),
        changes: { repository: { name: { from: "docs" } } },
      }),
    ).toBe("ignored");
    expect(await deliver("repository", { action: "publicized", installation: { id: installationId }, repository: repository("acme", "api") })).toBe(
      "ignored",
    );
  });

  test("suspend and unsuspend", async () => {
    expect(await deliver("installation", { action: "suspend", installation: installationRef() })).toBe("processed");
    expect((await listGithubInstallations(db, owner))[0]?.suspended).toBe(true);
    // Already suspended: nothing to do.
    expect(await deliver("installation", { action: "suspend", installation: installationRef() })).toBe("ignored");
    expect(await deliver("installation", { action: "unsuspend", installation: installationRef() })).toBe("processed");
    expect((await listGithubInstallations(db, owner))[0]?.suspended).toBe(false);
    expect((await activity("github.suspended")).length).toBe(1);
    expect((await activity("github.unsuspended")).length).toBe(1);
  });

  test("created again for a connected installation grants the listed repos", async () => {
    expect(
      await deliver("installation", {
        action: "created",
        installation: { ...installationRef(), repository_selection: "selected" },
        repositories: [{ full_name: "acme/docs" }],
      }),
    ).toBe("processed");
    expect((await getRepo(db, owner, "acme/docs")).githubInstallationId).toBe(installationId);
  });

  test("deleted (uninstalled on GitHub) forgets the installation; the repos stay", async () => {
    const id = nextDelivery();
    expect(await deliver("installation", { action: "deleted", installation: installationRef() }, id)).toBe("processed");
    expect(await listGithubInstallations(db, owner)).toEqual([]);
    expect((await listRepos(db, owner)).every((r) => r.githubInstallationId === null)).toBe(true);
    expect((await activity("github.uninstalled")).map((a) => a.changes)).toEqual([{ installation: installationId, account: "acme" }]);
    expect(await delivery(id)).toMatchObject({ orgId: owner.orgId, result: "processed" });
    // From now on its events are ignored.
    expect(await deliver("installation", { action: "deleted", installation: installationRef() })).toBe("ignored");
  });
});
