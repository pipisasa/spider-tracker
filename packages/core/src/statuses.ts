import type { ProjectDetailDto, StatusDto } from "./contracts";

// Status lookup shared by the MCP server and the CLI (no database imports).

const byPosition = (a: StatusDto, b: StatusDto) => a.position - b.position;

/** Statuses matching a name or a category ("In Progress", "in progress", "in_progress"), case-insensitively. */
export function matchStatuses(project: ProjectDetailDto, query: string): StatusDto[] {
  const q = query.trim().toLowerCase();
  const byName = project.statuses.filter((s) => s.name.toLowerCase() === q);
  if (byName.length > 0) return byName;
  const category = q.replace(/[\s-]+/g, "_");
  return project.statuses.filter((s) => s.category === category).sort(byPosition);
}
