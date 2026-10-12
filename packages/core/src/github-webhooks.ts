import type { Db, Tx } from "@repo/db";
import { schema } from "@repo/db";
import { and, eq, sql } from "drizzle-orm";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { ActorContext } from "./access";
import { recordActivity } from "./activity";
import { DomainError } from "./errors";
import { publish } from "./events";
import { handleCreate, handleDelete, handlePullRequest, handlePush } from "./git-links";
import { githubBotContext, grantGithubRepos, releaseGithubRepos, repoAccessChanges, type GithubRepoGrant } from "./github";
import { repoFullName } from "./remotes";

// GitHub webhooks (ST-83). The API checks the signature over the raw body (verifyGithubSignature)
// and hands the event here. Each delivery is handled once, in one transaction: its
// X-GitHub-Delivery id is inserted into `github_deliveries` first, so a redelivery, or two copies
// arriving together, finds the row (the second insert waits for the first transaction) and does
// nothing. Events are mapped to the organization that connected the installation; events of
// installations no organization has connected are recorded and ignored. Changes are attributed to
// the organization's GitHub bot (activity source "git"). Handling never calls GitHub: everything
// needed is in the payload.

const { githubDeliveries, githubInstallations, repos } = schema;

/** The largest body the endpoint reads (GitHub caps payloads at 25 MB; ours are far smaller). */
export const GITHUB_WEBHOOK_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Whether `signature` (X-Hub-Signature-256: `sha256=<hex>`) is the HMAC-SHA256 of the raw body
 * with the webhook secret. Compared in constant time; any change to the bytes (even whitespace in
 * the JSON) fails it.
 */
export function verifyGithubSignature(secret: string, body: Uint8Array, signature: string | null | undefined): boolean {
  const hex = signature?.match(/^sha256=([0-9a-f]{64})$/i)?.[1];
  if (!hex) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  const given = Buffer.from(hex, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// --- Payloads: only the fields used -------------------------------------------------------------

const installationRef = z.object({ id: z.number().int().positive() });

/** What every delivery is recorded with. */
const envelope = z.object({
  action: z.string().max(100).optional(),
  installation: installationRef.optional(),
});

/** A user or organization; enterprise accounts have a slug instead of a login. */
const account = z.object({ login: z.string().optional(), slug: z.string().optional() });

const installationPayload = z.object({
  action: z.string(),
  installation: z.object({
    id: z.number().int().positive(),
    account: account.nullable().optional(),
    repository_selection: z.enum(["all", "selected"]).optional(),
  }),
  // Sent with `created` (the repositories it grants).
  repositories: z.array(z.object({ full_name: z.string() })).optional(),
});

const repoList = z.array(z.object({ full_name: z.string() })).default([]);

const installationRepositoriesPayload = z.object({
  action: z.string(),
  installation: installationRef,
  repository_selection: z.enum(["all", "selected"]).optional(),
  repositories_added: repoList,
  repositories_removed: repoList,
});

const repositoryPayload = z.object({
  action: z.string(),
  installation: installationRef,
  repository: z.object({ name: z.string(), owner: z.object({ login: z.string() }), default_branch: z.string().optional() }),
  changes: z
    .object({
      repository: z.object({ name: z.object({ from: z.string() }) }).optional(),
      owner: z.object({ from: z.object({ user: account.optional(), organization: account.optional() }) }).optional(),
      default_branch: z.object({ from: z.string() }).optional(),
    })
    .optional(),
});

function parsePayload<T extends z.ZodType>(schemaOf: T, event: string, payload: unknown): z.infer<T> {
  const parsed = schemaOf.safeParse(payload);
  if (!parsed.success) throw new DomainError("validation", `Unexpected ${event} payload: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  return parsed.data;
}

/** `owner/name` into its parts; null when it isn't one. */
function splitFullName(fullName: string): GithubRepoGrant | null {
  const [owner, name, extra] = fullName.split("/");
  return owner && name && extra === undefined ? { owner, name } : null;
}

const grantsOf = (list: { full_name: string }[]) => list.map((r) => splitFullName(r.full_name)).filter((r) => r !== null);

const accountLogin = (a: z.infer<typeof account> | null | undefined) => a?.login ?? a?.slug ?? null;

// --- Dispatch ---------------------------------------------------------------------------------

type InstallationRow = typeof githubInstallations.$inferSelect;

/** What a handler gets: the event, its payload, and the connected installation (locked). */
export interface GithubEvent {
  event: string;
  action: string | null;
  payload: unknown;
  installation: InstallationRow;
  /** The organization's GitHub bot. */
  ctx: ActorContext;
}

/** Handles one event inside the delivery's transaction; true when it changed something. */
export type GithubEventHandler = (tx: Tx, event: GithubEvent) => Promise<boolean>;

const recordInstallationActivity = (tx: Tx, e: GithubEvent, action: string, changes: Record<string, unknown> = {}) =>
  recordActivity(tx, e.ctx, {
    entityType: "organization",
    entityId: e.ctx.orgId,
    action,
    changes: { installation: e.installation.id, account: e.installation.accountLogin, ...changes },
  });

/** installation: created (again, for a connected one), deleted, suspend, unsuspend. */
const handleInstallation: GithubEventHandler = async (tx, e) => {
  const data = parsePayload(installationPayload, "installation", e.payload);
  const { installation } = e;
  switch (data.action) {
    case "deleted": {
      // Uninstalled on GitHub: forget it here too; its repos stay, without it.
      await tx.delete(githubInstallations).where(eq(githubInstallations.id, installation.id));
      await recordInstallationActivity(tx, e, "github.uninstalled");
      await publish(tx, { type: "repos.changed", orgId: e.ctx.orgId });
      return true;
    }
    case "suspend":
    case "unsuspend": {
      const suspended = data.action === "suspend";
      if ((installation.suspendedAt !== null) === suspended) return false;
      await tx
        .update(githubInstallations)
        .set({ suspendedAt: suspended ? new Date() : null, updatedAt: new Date() })
        .where(eq(githubInstallations.id, installation.id));
      await recordInstallationActivity(tx, e, suspended ? "github.suspended" : "github.unsuspended");
      await publish(tx, { type: "repos.changed", orgId: e.ctx.orgId });
      return true;
    }
    case "created": {
      // Usually not connected yet (ignored before getting here); when the setup callback was
      // first, this refreshes the account and grants what the payload lists.
      const login = accountLogin(data.installation.account);
      await tx
        .update(githubInstallations)
        .set({
          ...(login ? { accountLogin: login } : {}),
          ...(data.installation.repository_selection ? { repositorySelection: data.installation.repository_selection } : {}),
          updatedAt: new Date(),
        })
        .where(eq(githubInstallations.id, installation.id));
      const access = await grantGithubRepos(tx, e.ctx, installation.id, grantsOf(data.repositories ?? []));
      await recordInstallationActivity(tx, e, "github.synced", repoAccessChanges(access));
      await publish(tx, { type: "repos.changed", orgId: e.ctx.orgId });
      return true;
    }
    default:
      return false;
  }
};

/** installation_repositories: repositories added to or removed from the installation. */
const handleInstallationRepositories: GithubEventHandler = async (tx, e) => {
  const data = parsePayload(installationRepositoriesPayload, "installation_repositories", e.payload);
  const selection = data.repository_selection;
  const selectionChanged = selection !== undefined && selection !== e.installation.repositorySelection;
  if (selectionChanged) {
    await tx
      .update(githubInstallations)
      .set({ repositorySelection: selection, updatedAt: new Date() })
      .where(eq(githubInstallations.id, e.installation.id));
  }
  const access = await grantGithubRepos(tx, e.ctx, e.installation.id, grantsOf(data.repositories_added));
  const removed = new Set(data.repositories_removed.map((r) => r.full_name.toLowerCase()));
  const released = removed.size ? await releaseGithubRepos(tx, e.ctx.orgId, e.installation.id, (key) => removed.has(key)) : [];
  const changes = repoAccessChanges({ ...access, released });
  if (Object.keys(changes).length === 0 && !selectionChanged) return false;
  await recordInstallationActivity(tx, e, "github.repos_changed", {
    ...(selectionChanged ? { repositorySelection: [e.installation.repositorySelection, selection] } : {}),
    ...changes,
  });
  await publish(tx, { type: "repos.changed", orgId: e.ctx.orgId });
  return true;
};

/** repository: renamed or transferred (owner/name), edited (the default branch). */
const handleRepository: GithubEventHandler = async (tx, e) => {
  const data = parsePayload(repositoryPayload, "repository", e.payload);
  const { repository, changes } = data;
  const next = { owner: repository.owner.login, name: repository.name };
  let previous: { owner: string; name: string };
  switch (data.action) {
    case "renamed": {
      const from = changes?.repository?.name.from;
      if (!from) return false;
      previous = { owner: next.owner, name: from };
      break;
    }
    case "transferred": {
      const from = accountLogin(changes?.owner?.from.user) ?? accountLogin(changes?.owner?.from.organization);
      if (!from) return false;
      previous = { owner: from, name: next.name };
      break;
    }
    case "edited":
      if (!changes?.default_branch || !repository.default_branch) return false;
      previous = next;
      break;
    default:
      return false;
  }

  const byName = (r: { owner: string; name: string }) =>
    and(
      eq(repos.orgId, e.ctx.orgId),
      sql`lower(${repos.owner}) = ${r.owner.toLowerCase()}`,
      sql`lower(${repos.name}) = ${r.name.toLowerCase()}`,
    );
  const [current] = await tx.select().from(repos).where(byName(previous)).for("update").limit(1);
  if (!current) return false;

  const update: { owner?: string; name?: string; defaultBranch?: string } = {};
  const activityChanges: Record<string, [string, string]> = {};
  if (repoFullName(current) !== repoFullName(next)) {
    // Another row already has the new name (added by URL meanwhile): leave both as they are.
    const [taken] = await tx.select({ id: repos.id }).from(repos).where(byName(next)).limit(1);
    if (taken && taken.id !== current.id) return false;
    Object.assign(update, next);
    activityChanges.repo = [repoFullName(current), repoFullName(next)];
  }
  if (data.action === "edited" && repository.default_branch && repository.default_branch !== current.defaultBranch) {
    update.defaultBranch = repository.default_branch;
    activityChanges.defaultBranch = [current.defaultBranch, repository.default_branch];
  }
  if (Object.keys(activityChanges).length === 0) return false;

  await tx.update(repos).set(update).where(eq(repos.id, current.id));
  await recordActivity(tx, e.ctx, { entityType: "repo", entityId: current.id, action: "repo.updated", changes: activityChanges });
  await publish(tx, { type: "repos.changed", orgId: e.ctx.orgId });
  return true;
};

/**
 * Handlers by X-GitHub-Event. Others (ping, and events nothing handles yet) are recorded and
 * ignored. Branches, commits and pull requests are linked to tasks in git-links.ts (ST-84).
 */
export const githubEventHandlers: Readonly<Partial<Record<string, GithubEventHandler>>> = {
  installation: handleInstallation,
  installation_repositories: handleInstallationRepositories,
  repository: handleRepository,
  create: handleCreate,
  delete: handleDelete,
  push: handlePush,
  pull_request: handlePullRequest,
};

export type GithubWebhookResult = "processed" | "ignored" | "duplicate";

const deliveryIdPattern = /^[A-Za-z0-9-]{1,100}$/;
const eventPattern = /^[a-z_]{1,100}$/;

/**
 * Handles one verified delivery, once: "duplicate" when its id was seen before, "ignored" when
 * nothing was changed (ping, unhandled events and actions, installations no organization has
 * connected), "processed" otherwise. A payload that doesn't match is a validation error and
 * nothing is recorded, so a redelivery is handled again.
 */
export async function handleGithubWebhook(
  db: Db,
  { deliveryId, event, payload }: { deliveryId: string; event: string; payload: unknown },
): Promise<GithubWebhookResult> {
  if (!deliveryIdPattern.test(deliveryId)) throw new DomainError("validation", "Invalid X-GitHub-Delivery");
  if (!eventPattern.test(event)) throw new DomainError("validation", "Invalid X-GitHub-Event");
  const head = parsePayload(envelope, event, payload);
  const installationId = head.installation?.id ?? null;

  return db.transaction(async (tx) => {
    const [claimed] = await tx
      .insert(githubDeliveries)
      .values({ id: deliveryId, event, action: head.action ?? null, installationId })
      .onConflictDoNothing()
      .returning({ id: githubDeliveries.id });
    if (!claimed) return "duplicate";

    const handler = githubEventHandlers[event];
    if (!handler || installationId === null) return "ignored";
    const [installation] = await tx
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.id, installationId))
      .for("update")
      .limit(1);
    if (!installation) return "ignored";

    const ctx = await githubBotContext(tx, installation.orgId);
    const changed = await handler(tx, { event, action: head.action ?? null, payload, installation, ctx });
    await tx
      .update(githubDeliveries)
      .set({ orgId: installation.orgId, result: changed ? "processed" : "ignored" })
      .where(eq(githubDeliveries.id, deliveryId));
    return changed ? "processed" : "ignored";
  });
}
