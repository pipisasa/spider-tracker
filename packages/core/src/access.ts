import type { Db, Tx } from "@repo/db";
import { schema } from "@repo/db";
import { and, eq, isNull } from "drizzle-orm";
import type { ActorRole } from "./contracts";
import { DomainError } from "./errors";

const { actors, agentProjects, agents, organizations } = schema;

export type ActivitySource = "ui" | "api" | "mcp" | "cli" | "git" | "agent_run" | "system";

/** Who is acting, in which organization: passed to every domain write. */
export interface ActorContext {
  orgId: string;
  actorId: string;
  role: ActorRole;
  source: ActivitySource;
}

/** Resolves the user's actor in an organization; members only. */
export async function resolveMembership(db: Db, userId: string, orgSlug: string) {
  const [row] = await db
    .select({ organization: organizations, actor: actors })
    .from(actors)
    .innerJoin(organizations, eq(actors.orgId, organizations.id))
    .where(and(eq(organizations.slug, orgSlug), eq(actors.userId, userId), isNull(actors.deactivatedAt)))
    .limit(1);
  // Same error for "missing" and "not a member", so slugs can't be probed.
  if (!row) throw new DomainError("not_found", "Organization not found");
  return row;
}

export function assertRole(ctx: ActorContext, allowed: ActorRole[], action: string) {
  if (!allowed.includes(ctx.role)) throw new DomainError("forbidden", `Your role can't ${action}`);
}

/**
 * Projects are created, changed and archived by owners and admins, and by agents whose owner is an
 * active owner or admin: such an agent acts with its owner's rights here (ST-61). Agents of members don't.
 */
export async function assertCanManageProjects(db: Db | Tx, ctx: ActorContext, action: string) {
  if (ctx.role === "owner" || ctx.role === "admin") return;
  if (ctx.role === "member") {
    const [owner] = await db
      .select({ role: actors.role })
      .from(agents)
      .innerJoin(actors, eq(actors.id, agents.ownerId))
      .where(and(eq(agents.actorId, ctx.actorId), eq(actors.orgId, ctx.orgId), isNull(actors.deactivatedAt)))
      .limit(1);
    if (owner?.role === "owner" || owner?.role === "admin") return;
  }
  throw new DomainError("forbidden", `Your role can't ${action}`);
}

/** Guests can read; everyone else can work on tasks. */
export function assertCanWrite(ctx: ActorContext) {
  assertRole(ctx, ["owner", "admin", "member"], "make changes");
}

/**
 * Who is reading: an actor (whose project scope applies) or a bare organization id
 * (internal callers and people-only paths, which see every project).
 */
export type Viewer = string | ActorContext;

/** Project ids a scoped agent may see, or null when the viewer sees every project. */
export type ProjectScope = Set<string> | null;

// One lookup per context object, i.e. per request.
const scopeCache = new WeakMap<ActorContext, Promise<ProjectScope>>();

/**
 * Scoped agents see only their agent_projects rows (none left once those projects are deleted);
 * everyone else sees every project. Rows alone also scope an agent, so this fails closed.
 */
export function projectScope(db: Db | Tx, viewer: Viewer): Promise<ProjectScope> {
  if (typeof viewer === "string") return Promise.resolve(null);
  let scope = scopeCache.get(viewer);
  if (!scope) {
    // One query: people get a single row with no agent and no projects.
    scope = db
      .select({ scoped: agents.scoped, projectId: agentProjects.projectId })
      .from(actors)
      .leftJoin(agents, eq(agents.actorId, actors.id))
      .leftJoin(agentProjects, eq(agentProjects.agentId, actors.id))
      .where(eq(actors.id, viewer.actorId))
      .then((rows) => {
        const projectIds = rows.flatMap((r) => (r.projectId ? [r.projectId] : []));
        return rows.some((r) => r.scoped) || projectIds.length > 0 ? new Set(projectIds) : null;
      });
    scopeCache.set(viewer, scope);
  }
  return scope;
}

export function orgIdOf(viewer: Viewer): string {
  return typeof viewer === "string" ? viewer : viewer.orgId;
}

/** Whether a project is visible in a scope; out-of-scope data is reported as "not found". */
export function inScope(scope: ProjectScope, projectId: string | null): boolean {
  return !scope || (projectId !== null && scope.has(projectId));
}
