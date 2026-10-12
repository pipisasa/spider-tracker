import type { DocumentGraphDto, StatusCategory } from "@repo/core/contracts";

// The documents graph (ST-100): documents, the tasks and projects they sit in, and their [[links]].

export type GraphNodeKind = "document" | "task" | "project" | "unresolved";

export interface GraphNode {
  /** "doc:<id>", "task:<key>", "project:<key>" or "missing:<title>". */
  id: string;
  kind: GraphNodeKind;
  label: string;
  /** The project it belongs to, for colouring. */
  projectKey: string | null;
  statusCategory?: StatusCategory;
  /** Links and containment edges, after filtering. */
  degree: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  /** A [[link]] or task mention, or a document/task sitting in its task/project. */
  kind: "link" | "contains";
}

export interface GraphFilters {
  showTasks: boolean;
  showProjects: boolean;
  /** Titles no document has. */
  showUnresolved: boolean;
  /** Nodes without any edge. */
  showOrphans: boolean;
}

export const DEFAULT_FILTERS: GraphFilters = {
  showTasks: true,
  showProjects: false,
  showUnresolved: true,
  showOrphans: true,
};

export const docNode = (id: string) => `doc:${id}`;
export const taskNode = (key: string) => `task:${key}`;
export const projectNode = (key: string) => `project:${key}`;
/** One node per title however it is cased. */
export const missingNode = (title: string) => `missing:${title.toLowerCase()}`;

export function buildDocumentGraph(
  graph: DocumentGraphDto,
  filters: GraphFilters,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes = new Map<string, GraphNode>();
  const add = (node: Omit<GraphNode, "degree">) => {
    if (!nodes.has(node.id)) nodes.set(node.id, { ...node, degree: 0 });
  };

  for (const d of graph.documents)
    add({ id: docNode(d.id), kind: "document", label: d.title, projectKey: d.projectKey });
  if (filters.showTasks)
    for (const t of graph.tasks)
      add({
        id: taskNode(t.key),
        kind: "task",
        label: `${t.key} ${t.title}`,
        projectKey: t.projectKey,
        statusCategory: t.statusCategory,
      });
  if (filters.showProjects)
    for (const p of graph.projects)
      add({ id: projectNode(p.key), kind: "project", label: p.name, projectKey: p.key });

  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const connect = (source: string, target: string, kind: GraphEdge["kind"]) => {
    if (source === target || !nodes.has(source) || !nodes.has(target)) return;
    const key = source < target ? `${source}|${target}` : `${target}|${source}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ source, target, kind });
  };

  for (const link of graph.links) {
    const from = docNode(link.from);
    if (link.to.type === "document") connect(from, docNode(link.to.id), "link");
    else if (link.to.type === "task") connect(from, taskNode(link.to.key), "link");
    else if (filters.showUnresolved) {
      const id = missingNode(link.to.title);
      add({ id, kind: "unresolved", label: link.to.title, projectKey: null });
      connect(from, id, "link");
    }
  }

  // Containment: a task's document hangs off its task (or its project when tasks are hidden).
  for (const d of graph.documents) {
    const from = docNode(d.id);
    if (d.taskKey && filters.showTasks) connect(from, taskNode(d.taskKey), "contains");
    else if (d.projectKey && filters.showProjects) connect(from, projectNode(d.projectKey), "contains");
  }
  if (filters.showTasks && filters.showProjects)
    for (const t of graph.tasks) connect(taskNode(t.key), projectNode(t.projectKey), "contains");

  for (const e of edges) {
    const s = nodes.get(e.source);
    const t = nodes.get(e.target);
    if (s) s.degree += 1;
    if (t) t.degree += 1;
  }
  const kept = [...nodes.values()].filter((n) => filters.showOrphans || n.degree > 0);
  return { nodes: kept, edges };
}

/** Each node's neighbours, for hover highlighting. */
export function neighbours(edges: readonly GraphEdge[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    let set = out.get(a);
    if (!set) out.set(a, (set = new Set()));
    set.add(b);
  };
  for (const e of edges) {
    link(e.source, e.target);
    link(e.target, e.source);
  }
  return out;
}

/** Whether a node matches the search box (case-insensitive, on its label). */
export function matchesSearch(node: GraphNode, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || node.label.toLowerCase().includes(q);
}
