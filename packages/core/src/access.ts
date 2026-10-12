import type { Db, Tx } from "@repo/db";
import { schema } from "@repo/db";
import { and, eq, isNull } from "drizzle-orm";
import type { ActorRole } from "./contracts";
import { DomainError } from "./errors";

const { actors, agentProjects, agents, organizations } = schema;

export type ActivitySource = "ui" | "api" | "mcp" | "cli" | "git" | "agent_run";

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
    scope = Promise.all([
      db.select({ scoped: agents.scoped }).from(agents).where(eq(agents.actorId, viewer.actorId)).limit(1),
      db
        .select({ projectId: agentProjects.projectId })
        .from(agentProjects)
        .where(eq(agentProjects.agentId, viewer.actorId)),
    ]).then(([[agent], rows]) =>
      agent?.scoped || rows.length > 0 ? new Set(rows.map((r) => r.projectId)) : null,
    );
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
