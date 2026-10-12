import {
  type GraphEdge,
  type GraphNode,
  matchesSearch,
  neighbours,
} from "@/lib/doc-graph";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { useEffect, useMemo, useRef } from "react";

// An Obsidian-style force-directed graph on a canvas (ST-100): drag the background to pan,
// scroll or pinch to zoom, drag nodes, hover to light up neighbours, click to open.

type SimNode = GraphNode & SimulationNodeDatum;
type SimLink = SimulationLinkDatum<SimNode> & { kind: GraphEdge["kind"] };
type View = { x: number; y: number; k: number };

const MIN_ZOOM = 0.15;
const MAX_ZOOM = 4;

/** Distinct, theme-neutral hues per project. */
const PALETTE = ["#6366f1", "#22c55e", "#eab308", "#ec4899", "#06b6d4", "#f97316", "#a855f7", "#14b8a6"];

function hueFor(projectKey: string | null, projects: string[]): string | null {
  if (!projectKey) return null;
  const i = projects.indexOf(projectKey);
  return PALETTE[(i < 0 ? 0 : i) % PALETTE.length] ?? null;
}

export function radiusOf(node: GraphNode): number {
  const base = node.kind === "project" ? 9 : node.kind === "task" ? 4.5 : 5;
  return base + Math.min(10, Math.sqrt(node.degree) * 1.8);
}

/** The app's colours, read from CSS variables so the graph follows light and dark themes. */
function themeColors() {
  const style = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    background: v("--background", "#fff"),
    foreground: v("--foreground", "#111"),
    muted: v("--muted-foreground", "#888"),
    border: v("--border", "#ddd"),
    primary: v("--primary", "#6366f1"),
  };
}

export function DocGraphCanvas({
  nodes,
  edges,
  search,
  onOpen,
  className,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  search: string;
  onOpen: (node: GraphNode) => void;
  className?: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null);
  const simNodes = useRef<SimNode[]>([]);
  const simLinks = useRef<SimLink[]>([]);
  // Positions survive filter changes, so toggling a filter doesn't reshuffle the graph.
  const positions = useRef(new Map<string, { x: number; y: number }>());
  const view = useRef<View>({ x: 0, y: 0, k: 1 });
  const size = useRef({ w: 0, h: 0 });
  const hover = useRef<SimNode | null>(null);
  const frame = useRef(0);
  const searchRef = useRef(search);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  const adjacency = useMemo(() => neighbours(edges), [edges]);
  const projects = useMemo(
    () => [...new Set(nodes.flatMap((n) => (n.projectKey ? [n.projectKey] : [])))].sort(),
    [nodes],
  );

  const draw = useRef(() => {});
  draw.current = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const { w, h } = size.current;
    const dpr = window.devicePixelRatio || 1;
    const colors = themeColors();
    const { x, y, k } = view.current;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.translate(w / 2 + x, h / 2 + y);
    ctx.scale(k, k);

    const focus = hover.current;
    const near = focus ? adjacency.get(focus.id) : undefined;
    const query = searchRef.current.trim();
    const lit = (n: SimNode) =>
      focus ? n.id === focus.id || (near?.has(n.id) ?? false) : !query || matchesSearch(n, query);

    for (const l of simLinks.current) {
      const s = l.source as SimNode;
      const t = l.target as SimNode;
      const active = focus && (s.id === focus.id || t.id === focus.id);
      const dim = (focus && !active) || (!focus && query && !(lit(s) && lit(t)));
      ctx.globalAlpha = dim ? 0.12 : active ? 0.9 : 0.45;
      ctx.strokeStyle = active ? colors.primary : colors.muted;
      ctx.lineWidth = (active ? 1.6 : 1) / Math.sqrt(k);
      ctx.setLineDash(l.kind === "contains" ? [3 / k, 3 / k] : []);
      ctx.beginPath();
      ctx.moveTo(s.x ?? 0, s.y ?? 0);
      ctx.lineTo(t.x ?? 0, t.y ?? 0);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    for (const n of simNodes.current) {
      const r = radiusOf(n);
      const on = lit(n);
      ctx.globalAlpha = on ? 1 : 0.18;
      const hue = hueFor(n.projectKey, projects) ?? colors.muted;
      const nx = n.x ?? 0;
      const ny = n.y ?? 0;
      ctx.beginPath();
      if (n.kind === "task") {
        ctx.roundRect(nx - r, ny - r, r * 2, r * 2, r * 0.4);
      } else {
        ctx.arc(nx, ny, r, 0, Math.PI * 2);
      }
      if (n.kind === "unresolved") {
        ctx.fillStyle = colors.background;
        ctx.fill();
        ctx.setLineDash([2, 2]);
        ctx.strokeStyle = colors.muted;
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.setLineDash([]);
      } else if (n.kind === "project") {
        ctx.fillStyle = colors.background;
        ctx.fill();
        ctx.strokeStyle = hue;
        ctx.lineWidth = 3;
        ctx.stroke();
      } else {
        ctx.fillStyle = n.kind === "task" && (n.statusCategory === "done" || n.statusCategory === "canceled") ? colors.muted : hue;
        ctx.fill();
      }
      if (focus?.id === n.id) {
        ctx.strokeStyle = colors.primary;
        ctx.lineWidth = 2.5 / k;
        ctx.stroke();
      }
    }

    // Labels: everything when zoomed in, otherwise what's highlighted and the bigger nodes.
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const fontSize = 11 / Math.max(k, 0.6);
    ctx.font = `${fontSize}px ui-sans-serif, system-ui, sans-serif`;
    for (const n of simNodes.current) {
      const on = lit(n);
      const highlighted = focus ? on : Boolean(query) && on;
      const crowded = simNodes.current.length > 40 && k < 1.1;
      if (!highlighted && crowded && n.degree < 4 && n.kind !== "project") continue;
      ctx.globalAlpha = on ? (highlighted || !crowded ? 1 : 0.75) : 0.15;
      ctx.fillStyle = n.kind === "unresolved" ? colors.muted : colors.foreground;
      const text = n.label.length > 40 ? `${n.label.slice(0, 39)}…` : n.label;
      ctx.fillText(text, n.x ?? 0, (n.y ?? 0) + radiusOf(n) + 3 / k);
    }
    ctx.globalAlpha = 1;
  };

  const requestDraw = () => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      draw.current();
    });
  };

  // Rebuild the simulation when the graph changes, keeping known positions.
  useEffect(() => {
    const ns: SimNode[] = nodes.map((n) => ({ ...n, ...positions.current.get(n.id) }));
    const byId = new Map(ns.map((n) => [n.id, n]));
    const ls: SimLink[] = edges.flatMap((e) => {
      const source = byId.get(e.source);
      const target = byId.get(e.target);
      return source && target ? [{ source, target, kind: e.kind }] : [];
    });
    simNodes.current = ns;
    simLinks.current = ls;
    const sim = forceSimulation<SimNode, SimLink>(ns)
      .force(
        "link",
        forceLink<SimNode, SimLink>(ls)
          .id((n) => n.id)
          .distance((l) => (l.kind === "contains" ? 50 : 95))
          .strength((l) => (l.kind === "contains" ? 0.6 : 0.35)),
      )
      .force("charge", forceManyBody<SimNode>().strength(-260).distanceMax(600))
      .force("collide", forceCollide<SimNode>((n) => radiusOf(n) + 14))
      .force("center", forceCenter(0, 0))
      // Keeps orphans and separate clusters from drifting off.
      .force("x", forceX<SimNode>(0).strength(0.04))
      .force("y", forceY<SimNode>(0).strength(0.04))
      .on("tick", () => {
        for (const n of ns) positions.current.set(n.id, { x: n.x ?? 0, y: n.y ?? 0 });
        requestDraw();
      });
    if (positions.current.size) sim.alpha(0.5);
    simRef.current = sim;
    return () => {
      sim.stop();
    };
  }, [nodes, edges]);

  useEffect(() => {
    searchRef.current = search;
    requestDraw();
  }, [search, adjacency, projects]);

  // Canvas size follows its container; redraw on theme changes.
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const { width, height } = wrap.getBoundingClientRect();
      size.current = { w: width, h: height };
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      requestDraw();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(wrap);
    const theme = new MutationObserver(requestDraw);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
    return () => {
      observer.disconnect();
      theme.disconnect();
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
  }, []);

  // Pointer interaction: pan, zoom, drag a node, hover, click.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const toGraph = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      const { x, y, k } = view.current;
      return {
        x: (clientX - rect.left - size.current.w / 2 - x) / k,
        y: (clientY - rect.top - size.current.h / 2 - y) / k,
      };
    };
    const nodeAt = (clientX: number, clientY: number): SimNode | null => {
      const p = toGraph(clientX, clientY);
      let best: SimNode | null = null;
      let bestDist = Infinity;
      for (const n of simNodes.current) {
        const d = Math.hypot((n.x ?? 0) - p.x, (n.y ?? 0) - p.y);
        const reach = radiusOf(n) + 4 / view.current.k;
        if (d <= reach && d < bestDist) {
          best = n;
          bestDist = d;
        }
      }
      return best;
    };
    const zoomAt = (clientX: number, clientY: number, factor: number) => {
      const rect = canvas.getBoundingClientRect();
      const v = view.current;
      const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.k * factor));
      const px = clientX - rect.left - size.current.w / 2;
      const py = clientY - rect.top - size.current.h / 2;
      view.current = { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k };
      requestDraw();
    };

    // Active pointers, for pinch zoom on touch screens.
    const pointers = new Map<number, { x: number; y: number }>();
    let drag: { node: SimNode | null; startX: number; startY: number; moved: boolean; viewX: number; viewY: number } | null = null;
    let pinch: number | null = null;

    const onDown = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = a && b ? Math.hypot(a.x - b.x, a.y - b.y) : null;
        drag = null;
        return;
      }
      const node = nodeAt(e.clientX, e.clientY);
      drag = { node, startX: e.clientX, startY: e.clientY, moved: false, viewX: view.current.x, viewY: view.current.y };
      if (node) {
        node.fx = node.x;
        node.fy = node.y;
      }
    };
    const onMove = (e: PointerEvent) => {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch !== null && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        if (!a || !b) return;
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, dist / pinch);
        pinch = dist;
        return;
      }
      if (!drag) {
        const node = nodeAt(e.clientX, e.clientY);
        if (node !== hover.current) {
          hover.current = node;
          canvas.style.cursor = node ? "pointer" : "grab";
          requestDraw();
        }
        return;
      }
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      if (drag.node) {
        const p = toGraph(e.clientX, e.clientY);
        drag.node.fx = p.x;
        drag.node.fy = p.y;
        simRef.current?.alphaTarget(0.25).restart();
      } else {
        view.current = { ...view.current, x: drag.viewX + dx, y: drag.viewY + dy };
        canvas.style.cursor = "grabbing";
        requestDraw();
      }
    };
    const onUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (!drag) return;
      const { node, moved } = drag;
      drag = null;
      canvas.style.cursor = hover.current ? "pointer" : "grab";
      if (node) {
        node.fx = null;
        node.fy = null;
        simRef.current?.alphaTarget(0);
        if (!moved) onOpenRef.current(node);
      }
    };
    const onLeave = () => {
      if (drag) return;
      hover.current = null;
      requestDraw();
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      // Trackpad pinch arrives as ctrl+wheel with small deltas.
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
      zoomAt(e.clientX, e.clientY, factor);
    };

    canvas.style.cursor = "grab";
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("wheel", onWheel);
    };
  }, []);

  return (
    <div ref={wrapRef} className={className}>
      <canvas
        ref={canvasRef}
        className="block touch-none select-none"
        role="img"
        aria-label={`Graph of ${nodes.length} documents, tasks and links`}
      />
    </div>
  );
}

