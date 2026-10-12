import { DocGraphCanvas } from "@/components/doc-graph-canvas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  buildDocumentGraph,
  DEFAULT_FILTERS,
  type GraphFilters,
  type GraphNode,
} from "@/lib/doc-graph";
import { documentGraphQuery } from "@/lib/work";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon, SearchIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

// The documents graph (ST-100), like Obsidian's: every document, the tasks and projects they
// sit in, and their [[links]].
export const Route = createFileRoute("/_authed/$orgSlug/docs/graph")({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(documentGraphQuery(params.orgSlug)),
  component: GraphPage,
});

const FILTERS_KEY = "spider:doc-graph-filters";

/** Filters are a per-viewer convenience; storage may be unavailable. */
function loadFilters(): GraphFilters {
  try {
    const raw = localStorage.getItem(FILTERS_KEY);
    if (!raw) return DEFAULT_FILTERS;
    const saved = JSON.parse(raw) as Partial<Record<keyof GraphFilters, unknown>>;
    const pick = (key: keyof GraphFilters) =>
      typeof saved[key] === "boolean" ? saved[key] : DEFAULT_FILTERS[key];
    return {
      showTasks: pick("showTasks"),
      showProjects: pick("showProjects"),
      showUnresolved: pick("showUnresolved"),
      showOrphans: pick("showOrphans"),
    };
  } catch {
    return DEFAULT_FILTERS;
  }
}

function saveFilters(filters: GraphFilters) {
  try {
    localStorage.setItem(FILTERS_KEY, JSON.stringify(filters));
  } catch {
    // Not remembered; the graph still works.
  }
}

const TOGGLES: { key: keyof GraphFilters; label: string }[] = [
  { key: "showTasks", label: "Tasks" },
  { key: "showProjects", label: "Projects" },
  { key: "showUnresolved", label: "Unresolved" },
  { key: "showOrphans", label: "Orphans" },
];

function GraphPage() {
  const { orgSlug } = Route.useParams();
  const { data } = useSuspenseQuery(documentGraphQuery(orgSlug));
  const navigate = useNavigate();
  const [filters, setFilters] = useState(loadFilters);
  const [search, setSearch] = useState("");
  const graph = useMemo(() => buildDocumentGraph(data, filters), [data, filters]);

  function toggle(key: keyof GraphFilters) {
    const next = { ...filters, [key]: !filters[key] };
    setFilters(next);
    saveFilters(next);
  }

  function open(node: GraphNode) {
    const [, ...rest] = node.id.split(":");
    const ref = rest.join(":");
    if (node.kind === "document")
      void navigate({ to: "/$orgSlug/docs/$documentId", params: { orgSlug, documentId: ref } });
    else if (node.kind === "task")
      void navigate({ to: "/$orgSlug/tasks/$taskKey", params: { orgSlug, taskKey: ref } });
    else if (node.kind === "project")
      void navigate({
        to: "/$orgSlug/projects/$projectKey",
        params: { orgSlug, projectKey: ref },
        search: { view: "docs" },
      });
    else toast.info(`No document is titled “${node.label}” yet. Open a link to it to create one.`);
  }

  const links = graph.edges.filter((e) => e.kind === "link").length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b px-4 py-3 md:px-6">
        <nav className="flex items-center gap-1 text-sm">
          <Link to="/$orgSlug/docs" params={{ orgSlug }} className="text-muted-foreground hover:text-foreground">
            Documents
          </Link>
          <ChevronRightIcon className="size-4 text-muted-foreground" />
          <h1 className="font-semibold">Graph</h1>
        </nav>
        <span className="text-xs text-muted-foreground">
          {data.documents.length} documents · {links} links
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-1">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Highlight…"
              aria-label="Highlight nodes"
              className="h-8 w-40 pl-7 text-sm"
            />
          </div>
          {TOGGLES.map((t) => (
            <Button
              key={t.key}
              size="sm"
              variant={filters[t.key] ? "secondary" : "ghost"}
              aria-pressed={filters[t.key]}
              onClick={() => toggle(t.key)}
            >
              {t.label}
            </Button>
          ))}
        </div>
      </header>
      {data.documents.length === 0 ? (
        <p className="p-6 text-sm text-muted-foreground">
          No documents yet. Link documents to each other with [[Title]] and to tasks with [[ST-12]].
        </p>
      ) : (
        <div className="relative min-h-[420px] flex-1">
          <DocGraphCanvas
            nodes={graph.nodes}
            edges={graph.edges}
            search={search}
            onOpen={open}
            className="absolute inset-0 overflow-hidden"
          />
          <Legend />
        </div>
      )}
    </div>
  );
}

function Legend() {
  return (
    <div className="pointer-events-none absolute bottom-3 left-3 flex flex-wrap gap-3 rounded-md bg-background/80 px-2.5 py-1.5 text-xs text-muted-foreground backdrop-blur">
      <span className="flex items-center gap-1.5">
        <span className="size-2.5 rounded-full bg-muted-foreground" /> Document
      </span>
      <span className="flex items-center gap-1.5">
        <span className="size-2.5 rounded-[3px] bg-muted-foreground" /> Task
      </span>
      <span className="flex items-center gap-1.5">
        <span className="size-3 rounded-full border-2 border-muted-foreground" /> Project
      </span>
      <span className="flex items-center gap-1.5">
        <span className="size-2.5 rounded-full border border-dashed border-muted-foreground" /> Unresolved
      </span>
      <span className="hidden sm:inline">Colour = project · drag, scroll to zoom, click to open</span>
    </div>
  );
}
