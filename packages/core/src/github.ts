import type { Db, Tx } from "@repo/db";
import { schema } from "@repo/db";
import { and, asc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ensureBot } from "./bots";
import {
  assertCanManageProjects,
  assertRole,
  orgIdOf,
  projectScope,
  type ActorContext,
  type Viewer,
} from "./access";
import { recordActivity } from "./activity";
import type { GithubInstallationDto } from "./contracts";
import { DomainError } from "./errors";
import { publish } from "./events";
import { repoFullName } from "./remotes";
import { insertRepo, repoVisibleIn } from "./repos";

// The GitHub App (ST-82). An owner or admin installs it on a GitHub account; the setup callback
// connects the installation to the organization, attaching the repos the organization already has
// (matched by owner/name) and adding the others. Git-driven changes (webhooks, ST-83 and later)
// are attributed to the organization's GitHub bot with activity source "git".
//
// Core never calls GitHub: the API's GitHub port (Octokit, or a fake in tests) fetches the
// installation and its repositories and hands them over as plain data.

const {
  actors,
  githubInstallations,
  githubInstallStates,
  organizations,
  repos,
} = schema;

/** An installation as GitHub describes it. */
export interface GithubInstallationData {
  id: number;
  account: string;
  accountType: "User" | "Organization";
  repositorySelection: "all" | "selected";
  suspended: boolean;
}

/** A repository an installation grants. */
export interface GithubRepoData {
  owner: string;
  name: string;
  defaultBranch: string;
}

// --- The signed `state` of the install flow ---------------------------------------------------

/** How long an install link stays valid. */
export const GITHUB_INSTALL_STATE_TTL_MS = 15 * 60_000;

/** Who started the install flow, for which organization; bound to the person's session. */
export interface GithubInstallState {
  orgId: string;
  userId: string;
  expiresAt: number;
  /** Makes the state single-use: recorded in github_install_states when issued, deleted when used (ST-137). */
  nonce: string;
}

const statePayload = z.object({
  o: z.string(),
  u: z.string(),
  e: z.number(),
  n: z.string(),
});

// A key of its own, so a state can't be replayed as any other signed value.
const stateKey = (secret: string) =>
  createHmac("sha256", secret)
    .update("spider-tracker/github-install-state")
    .digest();
const sign = (secret: string, payload: string) =>
  createHmac("sha256", stateKey(secret)).update(payload).digest("base64url");

const newNonce = () => randomBytes(18).toString("base64url");

/** `<payload>.<HMAC-SHA256>`, both base64url; valid for GITHUB_INSTALL_STATE_TTL_MS. */
export function signGithubInstallState(
  secret: string,
  state: { orgId: string; userId: string; nonce?: string },
  now: number = Date.now(),
): string {
  const payload = Buffer.from(
    JSON.stringify({
      o: state.orgId,
      u: state.userId,
      e: now + GITHUB_INSTALL_STATE_TTL_MS,
      n: state.nonce ?? newNonce(),
    }),
  ).toString("base64url");
  return `${payload}.${sign(secret, payload)}`;
}

/** The state when it is well formed, correctly signed and not expired; null otherwise. */
export function verifyGithubInstallState(
  secret: string,
  state: string,
  now: number = Date.now(),
): GithubInstallState | null {
  const [payload, signature, extra] = state.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  const expected = Buffer.from(sign(secret, payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given))
    return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const data = statePayload.safeParse(parsed);
  if (!data.success || data.data.e <= now) return null;
  return {
    orgId: data.data.o,
    userId: data.data.u,
    expiresAt: data.data.e,
    nonce: data.data.n,
  };
}

/**
 * Owners and admins (people) start the install flow; the state names them and the organization.
 * Its nonce is recorded so the state works once; expired ones are cleaned up on the way.
 */
export async function createGithubInstallState(
  db: Db,
  ctx: ActorContext,
  {
    secret,
    userId,
    now = Date.now(),
  }: { secret: string; userId: string; now?: number },
): Promise<string> {
  assertRole(ctx, ["owner", "admin"], "connect GitHub");
  const nonce = newNonce();
  await db
    .delete(githubInstallStates)
    .where(lt(githubInstallStates.expiresAt, new Date(now)));
  await db.insert(githubInstallStates).values({
    nonce,
    orgId: ctx.orgId,
    userId,
    expiresAt: new Date(now + GITHUB_INSTALL_STATE_TTL_MS),
  });
  return signGithubInstallState(
    secret,
    { orgId: ctx.orgId, userId, nonce },
    now,
  );
}

const invalidState = () =>
  new DomainError(
    "validation",
    "The GitHub install link is invalid, expired or already used; start again from Settings → GitHub",
  );

/**
 * Checks the setup callback's `state` against the signed-in person: it must be theirs, unexpired
 * and unused (it is used up here), and they must still be an owner or admin of its organization.
 * Returns the context to connect the installation with, and the organization's slug (for the
 * redirect back).
 */
export async function resolveGithubSetup(
  db: Db,
  {
    secret,
    state,
    userId,
    now = Date.now(),
  }: { secret: string; state: string; userId: string; now?: number },
): Promise<{ ctx: ActorContext; orgSlug: string }> {
  const verified = verifyGithubInstallState(secret, state, now);
  if (!verified) throw invalidState();
  // Checked before using it up, so someone else's session can't spend the person's link.
  if (verified.userId !== userId)
    throw new DomainError(
      "forbidden",
      "This GitHub install was started by someone else",
    );
  // Atomic: of two callbacks with the same state, only one deletes the row.
  const [used] = await db
    .delete(githubInstallStates)
    .where(
      and(
        eq(githubInstallStates.nonce, verified.nonce),
        eq(githubInstallStates.orgId, verified.orgId),
        eq(githubInstallStates.userId, userId),
        gt(githubInstallStates.expiresAt, new Date(now)),
      ),
    )
    .returning({ nonce: githubInstallStates.nonce });
  if (!used) throw invalidState();
  const [row] = await db
    .select({ actorId: actors.id, role: actors.role, slug: organizations.slug })
    .from(actors)
    .innerJoin(organizations, eq(organizations.id, actors.orgId))
    .where(
      and(
        eq(actors.orgId, verified.orgId),
        eq(actors.userId, userId),
        isNull(actors.deactivatedAt),
      ),
    )
    .limit(1);
  if (!row) throw new DomainError("not_found", "Organization not found");
  const ctx: ActorContext = {
    orgId: verified.orgId,
    actorId: row.actorId,
    role: row.role,
    source: "ui",
  };
  assertRole(ctx, ["owner", "admin"], "connect GitHub");
  return { ctx, orgSlug: row.slug };
}

// --- The GitHub bot -----------------------------------------------------------------------------

/** The bot's handle; "github-bot" if an older actor already had "github" (it is reserved now). */
const BOT_HANDLES = ["github", "github-bot"];

/**
 * The organization's GitHub bot (an `integration` actor: no user, no API keys, hidden from
 * pickers), created on first use.
 */
export function ensureGithubBot(tx: Tx, orgId: string): Promise<string> {
  return ensureBot(tx, orgId, {
    name: "GitHub",
    handles: BOT_HANDLES,
    purpose: "connect GitHub",
  });
}

/** Context for changes made by GitHub events: the bot, with activity source "git". */
export async function githubBotContext(
  tx: Tx,
  orgId: string,
): Promise<ActorContext> {
  return {
    orgId,
    actorId: await ensureGithubBot(tx, orgId),
    role: "member",
    source: "git",
  };
}

// --- Installations ----------------------------------------------------------------------------

/** The installation is connected to another organization: a 409, and the setup callback's `other_organization`. */
export class GithubInstallationTakenError extends DomainError {
  constructor(account: string) {
    super(
      "conflict",
      `The GitHub installation on ${account} is connected to another organization`,
    );
    this.name = "GithubInstallationTakenError";
  }
}

type InstallationRow = typeof githubInstallations.$inferSelect;

export function githubInstallationSettingsUrl(row: {
  id: number;
  accountLogin: string;
  accountType: string;
}): string {
  return row.accountType === "Organization"
    ? `https://github.com/organizations/${encodeURIComponent(row.accountLogin)}/settings/installations/${row.id}`
    : `https://github.com/settings/installations/${row.id}`;
}

async function toInstallationDtos(
  db: Db | Tx,
  viewer: Viewer,
  rows: InstallationRow[],
): Promise<GithubInstallationDto[]> {
  if (rows.length === 0) return [];
  const scope = await projectScope(db, viewer);
  const granted = await db
    .select({
      installationId: repos.githubInstallationId,
      owner: repos.owner,
      name: repos.name,
    })
    .from(repos)
    .where(
      and(
        eq(repos.orgId, orgIdOf(viewer)),
        inArray(
          repos.githubInstallationId,
          rows.map((r) => r.id),
        ),
        repoVisibleIn(db, scope),
      ),
    )
    .orderBy(sql`lower(${repos.owner})`, sql`lower(${repos.name})`);
  return rows.map((row) => ({
    id: row.id,
    account: row.accountLogin,
    accountType: row.accountType,
    repositorySelection: row.repositorySelection,
    suspended: row.suspendedAt !== null,
    repos: granted.filter((r) => r.installationId === row.id).map(repoFullName),
    settingsUrl: githubInstallationSettingsUrl(row),
    connectedBy: row.connectedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

/** The organization's installations, by account; a scoped agent sees only its projects' repos in them. */
export async function listGithubInstallations(
  db: Db,
  viewer: Viewer,
): Promise<GithubInstallationDto[]> {
  const rows = await db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.orgId, orgIdOf(viewer)))
    .orderBy(
      sql`lower(${githubInstallations.accountLogin})`,
      asc(githubInstallations.id),
    );
  return toInstallationDtos(db, viewer, rows);
}

/** Owners, admins and their agents manage the connection, except agents limited to some projects. */
async function assertCanManageGithub(
  db: Db,
  ctx: ActorContext,
  action: string,
) {
  await assertCanManageProjects(db, ctx, action);
  if (await projectScope(db, ctx))
    throw new DomainError(
      "forbidden",
      `Agents limited to some projects can't ${action}`,
    );
}

/** A repository an installation grants; webhooks don't say the default branch ("main" then). */
export type GithubRepoGrant = Omit<GithubRepoData, "defaultBranch"> & {
  defaultBranch?: string;
};

/**
 * Gives the installation the repos it grants, inside the caller's transaction: repos the
 * organization already has (same owner/name, any case) get it; the others are added (attached
 * to no project). Returns their names, for the activity log.
 */
export async function grantGithubRepos(
  tx: Tx,
  ctx: ActorContext,
  installationId: number,
  repositories: GithubRepoGrant[],
): Promise<{ attached: string[]; added: string[] }> {
  // Unique by owner/name, case-insensitively.
  const wanted = new Map<string, GithubRepoGrant>();
  for (const repo of repositories)
    wanted.set(repoFullName(repo).toLowerCase(), repo);
  const attached: string[] = [];
  const added: string[] = [];
  if (wanted.size === 0) return { attached, added };

  const existing = await tx
    .select()
    .from(repos)
    .where(eq(repos.orgId, ctx.orgId))
    .for("update");
  const byName = new Map(
    existing.map((r) => [repoFullName(r).toLowerCase(), r]),
  );
  for (const [key, repo] of wanted) {
    const found = byName.get(key);
    if (found) {
      if (found.githubInstallationId !== installationId) {
        await tx
          .update(repos)
          .set({ githubInstallationId: installationId })
          .where(eq(repos.id, found.id));
        attached.push(repoFullName(found));
      }
      continue;
    }
    const created = await insertRepo(tx, ctx, {
      owner: repo.owner,
      name: repo.name,
      defaultBranch: repo.defaultBranch ?? "main",
      githubInstallationId: installationId,
    });
    if (created) added.push(repoFullName(created));
  }
  return { attached, added };
}

/**
 * Takes the installation off its repos whose lower-cased owner/name `released` accepts; they keep
 * their rows. Returns their names.
 */
export async function releaseGithubRepos(
  tx: Tx,
  orgId: string,
  installationId: number,
  released: (key: string) => boolean,
): Promise<string[]> {
  const granted = await tx
    .select()
    .from(repos)
    .where(
      and(
        eq(repos.orgId, orgId),
        eq(repos.githubInstallationId, installationId),
      ),
    )
    .for("update");
  const rows = granted.filter((r) => released(repoFullName(r).toLowerCase()));
  if (rows.length) {
    await tx
      .update(repos)
      .set({ githubInstallationId: null })
      .where(
        inArray(
          repos.id,
          rows.map((r) => r.id),
        ),
      );
  }
  return rows.map(repoFullName);
}

/** The non-empty lists of an access change, for an activity entry's `changes`. */
export function repoAccessChanges(lists: {
  attached?: string[];
  added?: string[];
  released?: string[];
}): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(lists).filter(
      ([, names]) => names !== undefined && names.length > 0,
    ),
  );
}

/**
 * Connects an installation to the organization, or refreshes it (a sync): its account, and which
 * repos it grants. Repos the organization already has (same owner/name, any case) get the
 * installation; the others are added (attached to no project). Repos it no longer grants keep
 * their row and lose the installation. Refused (GithubInstallationTakenError) when the installation
 * belongs to another organization.
 */
export async function saveGithubInstallation(
  db: Db,
  ctx: ActorContext,
  {
    installation,
    repositories,
  }: { installation: GithubInstallationData; repositories: GithubRepoData[] },
): Promise<GithubInstallationDto> {
  await assertCanManageGithub(db, ctx, "connect GitHub");
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.id, installation.id))
      .for("update")
      .limit(1);
    if (current && current.orgId !== ctx.orgId) {
      throw new GithubInstallationTakenError(installation.account);
    }
    const values = {
      accountLogin: installation.account,
      accountType: installation.accountType,
      repositorySelection: installation.repositorySelection,
      suspendedAt: installation.suspended
        ? (current?.suspendedAt ?? new Date())
        : null,
      updatedAt: new Date(),
    };
    const [row] = current
      ? await tx
          .update(githubInstallations)
          .set(values)
          .where(eq(githubInstallations.id, installation.id))
          .returning()
      : await tx
          .insert(githubInstallations)
          .values({
            id: installation.id,
            orgId: ctx.orgId,
            connectedBy: ctx.actorId,
            ...values,
          })
          .onConflictDoNothing()
          .returning();
    // Only when a concurrent request connected it first.
    if (!row)
      throw new DomainError(
        "conflict",
        `The GitHub installation on ${installation.account} was just connected; reload`,
      );
    await ensureGithubBot(tx, ctx.orgId);

    const access = await grantGithubRepos(tx, ctx, row.id, repositories);
    const wanted = new Set(
      repositories.map((r) => repoFullName(r).toLowerCase()),
    );
    const released = await releaseGithubRepos(
      tx,
      ctx.orgId,
      row.id,
      (key) => !wanted.has(key),
    );

    await recordActivity(tx, ctx, {
      entityType: "organization",
      entityId: ctx.orgId,
      action: current ? "github.synced" : "github.connected",
      changes: {
        installation: row.id,
        account: row.accountLogin,
        ...repoAccessChanges({ ...access, released }),
      },
    });
    await publish(tx, { type: "repos.changed", orgId: ctx.orgId });
    const [dto] = await toInstallationDtos(tx, ctx, [row]);
    if (!dto) throw new Error("Failed to load the GitHub installation");
    return dto;
  });
}

/** An installation of the organization, by GitHub's id; 404 for anything else. */
export async function getGithubInstallation(
  db: Db,
  viewer: Viewer,
  id: number,
): Promise<GithubInstallationDto> {
  const [row] = await db
    .select()
    .from(githubInstallations)
    .where(
      and(
        eq(githubInstallations.id, id),
        eq(githubInstallations.orgId, orgIdOf(viewer)),
      ),
    )
    .limit(1);
  if (!row)
    throw new DomainError("not_found", `GitHub installation ${id} not found`);
  const [dto] = await toInstallationDtos(db, viewer, [row]);
  if (!dto) throw new Error("Failed to load the GitHub installation");
  return dto;
}

/** Checks that the caller may sync `id` before the API asks GitHub about it. */
export async function assertCanSyncGithubInstallation(
  db: Db,
  ctx: ActorContext,
  id: number,
): Promise<void> {
  await assertCanManageGithub(db, ctx, "sync GitHub");
  await getGithubInstallation(db, ctx, id);
}

/**
 * Forgets an installation: its repos stay, without it. The App stays installed on GitHub until
 * someone uninstalls it there (`settingsUrl`).
 */
export async function disconnectGithubInstallation(
  db: Db,
  ctx: ActorContext,
  id: number,
): Promise<void> {
  await assertCanManageGithub(db, ctx, "disconnect GitHub");
  await db.transaction(async (tx) => {
    const [row] = await tx
      .delete(githubInstallations)
      .where(
        and(
          eq(githubInstallations.id, id),
          eq(githubInstallations.orgId, ctx.orgId),
        ),
      )
      .returning();
    if (!row)
      throw new DomainError("not_found", `GitHub installation ${id} not found`);
    await recordActivity(tx, ctx, {
      entityType: "organization",
      entityId: ctx.orgId,
      action: "github.disconnected",
      changes: { installation: row.id, account: row.accountLogin },
    });
    await publish(tx, { type: "repos.changed", orgId: ctx.orgId });
  });
}
