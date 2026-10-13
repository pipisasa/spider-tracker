import type { Tx } from "@repo/db";
import { schema } from "@repo/db";
import { and, eq, inArray } from "drizzle-orm";
import type { ActorContext } from "./access";
import { DomainError } from "./errors";

// Per-organization bots: `integration` actors (no user, no API keys, hidden from pickers) that
// automatic changes are attributed to. The GitHub bot (ST-82) records git-driven changes; the
// Spider Tracker bot (ST-96) records what the tracker does by itself, such as moving a finished
// milestone to Ready to close.

const { actors } = schema;

interface BotSpec {
  name: string;
  /** The preferred handle first; the next ones are used when an older actor already has it. */
  handles: string[];
  /** What the bot is needed for, ending the error when every handle is taken ("connect GitHub"). */
  purpose: string;
}

/** The organization's bot with one of `spec.handles`, created on first use. */
export async function ensureBot(
  tx: Tx,
  orgId: string,
  spec: BotSpec,
): Promise<string> {
  const find = async () => {
    const rows = await tx
      .select({ id: actors.id, handle: actors.handle })
      .from(actors)
      .where(
        and(
          eq(actors.orgId, orgId),
          eq(actors.type, "integration"),
          inArray(actors.handle, spec.handles),
        ),
      );
    return spec.handles
      .map((h) => rows.find((r) => r.handle === h))
      .find((r) => r !== undefined)?.id;
  };
  const existing = await find();
  if (existing) return existing;
  for (const handle of spec.handles) {
    const [row] = await tx
      .insert(actors)
      .values({
        orgId,
        type: "integration",
        name: spec.name,
        handle,
        role: "member",
      })
      .onConflictDoNothing()
      .returning({ id: actors.id });
    if (row) return row.id;
    // A concurrent request may have just created it.
    const raced = await find();
    if (raced) return raced;
  }
  throw new DomainError(
    "conflict",
    `The handles ${spec.handles.map((h) => `@${h}`).join(" and ")} are taken; rename one to ${spec.purpose}`,
  );
}

/** The Spider Tracker bot's handles: "spider", or "spider-bot" when an older actor has "spider". */
export const SYSTEM_BOT_HANDLES = ["spider", "spider-bot"];

/** Context for changes the tracker makes by itself: its bot, with activity source "system". */
export async function systemContext(
  tx: Tx,
  orgId: string,
): Promise<ActorContext> {
  const actorId = await ensureBot(tx, orgId, {
    name: "Spider Tracker",
    handles: SYSTEM_BOT_HANDLES,
    purpose: "let the tracker act",
  });
  return { orgId, actorId, role: "member", source: "system" };
}
