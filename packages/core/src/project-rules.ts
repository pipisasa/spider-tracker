import type { Db, Tx } from "@repo/db";
import { schema } from "@repo/db";
import {
  and,
  asc,
  eq,
  exists,
  inArray,
  isNull,
  ne,
  not,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import {
  inScope,
  orgIdOf,
  projectScope,
  type ActorContext,
  type Viewer,
} from "./access";
import type { ProjectRulesDto } from "./contracts";
import { DomainError } from "./errors";
import { notifyRulesChanged } from "./inbox";

// Project rules for agents (ST-111): a project points at one of its own project-level documents
// (`projects.rules_document_id`). Agents get the rules in the MCP server's instructions, in
// get_project and whoami, and an inbox item (kind `rules`) whenever they are set or saved.

const { actors, agentProjects, agents, documents, inboxItems, projects } =
  schema;

/** The project whose rules this document is, if any. */
export async function rulesProjectOf(db: Db | Tx, documentId: string) {
  const [row] = await db
    .select({ id: projects.id, key: projects.key })
    .from(projects)
    .where(eq(projects.rulesDocumentId, documentId))
    .limit(1);
  return row;
}

/** Only a live document of the project itself (not organization-wide, not a task's) can be its rules. */
export async function assertRulesDocument(
  tx: Tx,
  project: { id: string; orgId: string; key: string },
  documentId: string,
) {
  const [document] = await tx
    .select({ projectId: documents.projectId, taskId: documents.taskId })
    .from(documents)
    .where(
      and(
        eq(documents.id, documentId),
        eq(documents.orgId, project.orgId),
        isNull(documents.deletedAt),
      ),
    )
    .limit(1);
  if (!document) throw new DomainError("not_found", "Document not found");
  if (document.projectId !== project.id || document.taskId !== null) {
    throw new DomainError(
      "validation",
      `Project rules must be a document of ${project.key} itself, not an organization-wide or task document; move it to ${project.key} first`,
    );
  }
}

/**
 * Tells the agents working in a project that its rules were set or changed: every active agent that
 * can see the project (scoped to it, or unscoped), except the actor; nobody for an archived project.
 * An agent that still has an unread `rules` item for the document gets no second one.
 */
export async function announceRulesChange(
  tx: Tx,
  ctx: ActorContext,
  projectId: string,
  documentId: string,
) {
  // Archived projects' rules reach no agent (instructions, whoami), so nobody is told about them.
  const [project] = await tx
    .select({ archivedAt: projects.archivedAt })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project || project.archivedAt) return;
  const anyProjects = tx
    .select({ one: sql`1` })
    .from(agentProjects)
    .where(eq(agentProjects.agentId, actors.id));
  const recipients = await tx
    .select({ id: actors.id })
    .from(actors)
    .innerJoin(agents, eq(agents.actorId, actors.id))
    .where(
      and(
        eq(actors.orgId, ctx.orgId),
        isNull(actors.deactivatedAt),
        ne(actors.id, ctx.actorId),
        or(
          exists(
            tx
              .select({ one: sql`1` })
              .from(agentProjects)
              .where(
                and(
                  eq(agentProjects.agentId, actors.id),
                  eq(agentProjects.projectId, projectId),
                ),
              ),
          ),
          and(not(agents.scoped), notExists(anyProjects)),
        ),
        notExists(
          tx
            .select({ one: sql`1` })
            .from(inboxItems)
            .where(
              and(
                eq(inboxItems.recipientId, actors.id),
                eq(inboxItems.kind, "rules"),
                eq(inboxItems.documentId, documentId),
                isNull(inboxItems.readAt),
              ),
            ),
        ),
      ),
    );
  await notifyRulesChanged(
    tx,
    ctx,
    documentId,
    recipients.map((r) => r.id),
  );
}

/** The rules of the viewer's active projects that have them, by project key. */
export async function listProjectRules(
  db: Db,
  viewer: Viewer,
  projectKey?: string,
): Promise<ProjectRulesDto[]> {
  const scope = await projectScope(db, viewer);
  const rows = await db
    .select({
      project: { id: projects.id, key: projects.key, name: projects.name },
      document: documents,
    })
    .from(projects)
    .innerJoin(documents, eq(documents.id, projects.rulesDocumentId))
    .where(
      and(
        eq(projects.orgId, orgIdOf(viewer)),
        projectKey === undefined
          ? isNull(projects.archivedAt)
          : eq(projects.key, projectKey.trim().toUpperCase()),
        isNull(documents.deletedAt),
        scope ? inArray(projects.id, [...scope]) : undefined,
      ),
    )
    .orderBy(asc(projects.key));
  return rows
    .filter((r) => inScope(scope, r.project.id))
    .map(({ project, document }) => ({
      projectKey: project.key,
      projectName: project.name,
      documentId: document.id,
      title: document.title,
      format: document.format,
      version: document.version,
      updatedAt: document.updatedAt.toISOString(),
      content: document.content,
    }));
}

/** One project's rules, or null when it has none (or isn't visible). */
export async function getProjectRules(
  db: Db,
  viewer: Viewer,
  projectKey: string,
): Promise<ProjectRulesDto | null> {
  const [rules] = await listProjectRules(db, viewer, projectKey);
  return rules ?? null;
}
