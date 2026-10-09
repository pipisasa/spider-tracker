import type { Db } from "@repo/db";
import { schema } from "@repo/db";
import { and, eq, isNull } from "drizzle-orm";
import type { ActorRole } from "./contracts";
import { DomainError } from "./errors";

const { actors, organizations } = schema;

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
