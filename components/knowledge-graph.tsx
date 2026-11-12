"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  Focus,
  Link2,
  Network,
  Plus,
  Search,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { Relation, ResearchRecord, Workspace } from "@/lib/schema";
import {
  CARD,
  cardBox,
  cardSize,
  graphEdges,
  graphLines,
  layoutGraph,
  neighbours,
  placeCards,
  placeLabels,
  type Box,
  type CardInput,
  type LabelInput,
  type Point,
  type Size,
} from "@/lib/graph";
import {
  EmptyState,
  KindBadge,
  Modal,
  excerpt,
  jsonOptions,
  kindMeta,
  useWorkspaceApi,
} from "./ui";
import { Select } from "./select";

type Kind = ResearchRecord["kind"];
type View = { k: number; x: number; y: number };

// Knowledge records keep their badge colour. Tasks are work items, not knowledge: they are
// grey (a hollow ring as a dot). A manuscript is the text colour.
const KIND_COLOR: Record<Kind, string> = {
  note: "var(--blue)",
  journal: "var(--orange)",
  finding: "var(--pink)",
  experiment: "var(--lime)",
  reference: "var(--purple)",
  task: "var(--muted)",
  paper: "var(--text)",
};
const KINDS = Object.keys(kindMeta) as Kind[];

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2.5;
// "Fit" does not zoom out further than this: on a small canvas a large graph is centred and
// the user moves it, because smaller gaps cannot be read or clicked.
const FIT_MIN_ZOOM = 0.4;
// Free border around the fitted graph. The bottom also holds the zoom controls and the hint.
const FIT_PADDING = 18;
const FIT_PADDING_BOTTOM = 52;
// A card follows the zoom between 80% and 100%, so its text stays readable. Under 80% the cards
// that would overlap become dots.
const CARD_MIN_SCALE = 0.8;
const CARD_GAP = 6;
// Labels (the titles of dots) stay this far inside the canvas edge.
const LABEL_INSET = 6;
const LABEL_HEIGHT = 15;
// Average glyph width of the 11px label font, used to reserve room for a label.
const LABEL_CHAR_WIDTH = 6.2;
const LABEL_MAX_CHARS = 28;
// How far a line bends away from the straight line, as a part of its length.
const CURVE = 0.12;
const TOP_CONNECTED = 8;

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));
const labelText = (title: string) =>
  title.length > LABEL_MAX_CHARS
    ? title.slice(0, LABEL_MAX_CHARS - 1).trimEnd() + "…"
    : title;
const dotRadius = (degree: number) => Math.min(13, 5 + 1.8 * Math.sqrt(degree));

type Node = {
  record: ResearchRecord;
  id: string;
  degree: number;
  /** Centre, in screen pixels before the pan offset. */
  x: number;
  y: number;
  /** The card at zoom 100%, and the number of title lines. */
  size: Size & { lines: number };
  /** The card and the dot at this zoom. */
  card: CardInput;
  label: LabelInput;
};

/** The nodes at zoom `k`. Positions follow the zoom fully; cards follow it only from 80% to 100%,
 *  and labels keep their size. */
function nodesAt(
  records: ResearchRecord[],
  layout: Map<string, Point>,
  near: Map<string, Set<string>>,
  k: number,
): Node[] {
  const scale = clamp(k, CARD_MIN_SCALE, 1);
  return records.map((record) => {
    const p = layout.get(record.id)!;
    const degree = near.get(record.id)?.size ?? 0;
    const size = cardSize(record.title);
    const at = { id: record.id, x: p.x * k, y: p.y * k };
    return {
      record,
      degree,
      size,
      ...at,
      card: { ...at, width: size.width * scale, height: size.height * scale },
      label: {
        ...at,
        r: dotRadius(degree),
        width: labelText(record.title).length * LABEL_CHAR_WIDTH,
      },
    };
  });
}

// The most connected records first, knowledge before tasks.
const rank = (n: Node) => n.degree + (n.record.kind === "task" ? 0 : 2);
const byRank = (nodes: Node[]) => [...nodes].sort((a, b) => rank(b) - rank(a));

/** The zoom and offset that centre the graph in a `width` x `height` canvas, and show all of it
 *  when that does not need a zoom under FIT_MIN_ZOOM. `nodes` are the nodes at zoom 100%. */
function fitView(nodes: Node[], width: number, height: number): View {
  if (!nodes.length) return { k: 1, x: width / 2, y: height / 2 };
  const boxes = nodes.map((n) => cardBox(n.card));
  const [x0, x1, y0, y1] = [
    Math.min(...boxes.map((b) => b.x0)),
    Math.max(...boxes.map((b) => b.x1)),
    Math.min(...boxes.map((b) => b.y0)),
    Math.max(...boxes.map((b) => b.y1)),
  ];
  const free = {
    width: width - 2 * FIT_PADDING,
    height: height - FIT_PADDING - FIT_PADDING_BOTTOM,
  };
  const k = clamp(
    Math.min(free.width / (x1 - x0), free.height / (y1 - y0)),
    FIT_MIN_ZOOM,
    1,
  );
  return {
    k,
    x: FIT_PADDING + free.width / 2 - ((x0 + x1) / 2) * k,
    y: FIT_PADDING + free.height / 2 - ((y0 + y1) / 2) * k,
  };
}

/** A line from `a` to `b` as a curve: the SVG path and its control point. */
function curve(a: Point, b: Point) {
  const control = {
    x: (a.x + b.x) / 2 - (b.y - a.y) * CURVE,
    y: (a.y + b.y) / 2 + (b.x - a.x) * CURVE,
  };
  return {
    control,
    path: `M${a.x},${a.y}Q${control.x},${control.y} ${b.x},${b.y}`,
  };
}

/** An arrow head where a curve with control point `from` meets the edge of the node `to`. */
function arrowHead(from: Point, to: Node, isCard: boolean) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const d = Math.hypot(dx, dy) || 1;
  const [ux, uy] = [dx / d, dy / d];
  // The distance from the centre of the node to its edge, in the direction of the line.
  const reach = isCard
    ? Math.min(
        to.card.width / 2 / Math.abs(ux || 1e-6),
        to.card.height / 2 / Math.abs(uy || 1e-6),
      )
    : to.label.r;
  const tipX = to.x - ux * (reach + 3);
  const tipY = to.y - uy * (reach + 3);
  const baseX = tipX - ux * 8;
  const baseY = tipY - uy * 8;
  return `${tipX},${tipY} ${baseX - uy * 3.5},${baseY + ux * 3.5} ${baseX + uy * 3.5},${baseY - ux * 3.5}`;
}

export function KnowledgeGraph({
  workspace,
  onOpen,
  onChange,
  notify,
}: {
  workspace: Workspace;
  onOpen: (r: ResearchRecord) => void;
  onChange: () => Promise<void>;
  notify: (s: string) => void;
}) {
  const { api } = useWorkspaceApi();
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  // Tasks start hidden: they are most of the records and most of the links, and they hide the
  // knowledge records. A workspace with tasks only shows them.
  const [hidden, setHidden] = useState<Set<Kind>>(
    () =>
      new Set<Kind>(
        workspace.records.some((r) => r.kind !== "task") ? ["task"] : [],
      ),
  );
  const [query, setQuery] = useState("");
  const [view, setView] = useState<View>({ k: 1, x: 0, y: 0 });
  const [size, setSize] = useState({ width: 0, height: 0 });
  const canvas = useRef<HTMLDivElement>(null);
  // A drag of the canvas: where it started, and how far it went. The offset is added to the
  // view when the drag ends.
  const pan = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const [drag, setDrag] = useState({ dx: 0, dy: 0 });
  // True once the user moved or zoomed the view; a resize then keeps the view.
  const touched = useRef(false);
  const fitted = useRef<Map<string, Point> | null>(null);

  const [linkOpen, setLinkOpen] = useState(false);
  const [source, setSource] = useState("");
  const [target, setTarget] = useState("");
  const [type, setType] = useState<Relation["type"]>("relates");
  const [busy, setBusy] = useState(false);

  const edges = useMemo(() => graphEdges(workspace), [workspace]);
  const counts = useMemo(() => {
    const counts = new Map<Kind, number>();
    for (const r of workspace.records)
      counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
    return counts;
  }, [workspace.records]);
  const visible = useMemo(
    () => workspace.records.filter((r) => !hidden.has(r.kind)),
    [workspace.records, hidden],
  );
  const lines = useMemo(
    () => graphLines(edges, new Set(visible.map((r) => r.id))),
    [edges, visible],
  );
  const near = useMemo(() => neighbours(lines), [lines]);
  // The layout depends on `layoutKey` only: it changes when the visible records, their titles
  // (the card sizes) or the links change, not when the workspace object is loaded again.
  const layoutKey =
    visible.map((r) => `${r.id}:${r.title.length}`).join(",") +
    "#" +
    lines.map((l) => l.key).join(",");
  const layout = useMemo(
    () =>
      layoutGraph(
        visible.map((r) => ({ id: r.id, ...cardSize(r.title) })),
        lines,
      ),
    [layoutKey],
  );

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      }),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const fit = () =>
    fitView(nodesAt(visible, layout, near, 1), size.width, size.height);
  useEffect(() => {
    if (!size.width || !size.height) return;
    if (fitted.current === layout && touched.current) return;
    fitted.current = layout;
    touched.current = false;
    setView(fit());
  }, [layout, size]);

  const zoomAt = (factor: number, cx: number, cy: number) => {
    touched.current = true;
    setView((v) => {
      const k = clamp(v.k * factor, MIN_ZOOM, MAX_ZOOM);
      const f = k / v.k;
      return { k, x: cx - (cx - v.x) * f, y: cy - (cy - v.y) * f };
    });
  };

  // Pinch or Ctrl/Cmd + scroll zooms at the pointer. A plain scroll still scrolls the page.
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const box = element.getBoundingClientRect();
      zoomAt(
        Math.exp(-e.deltaY * 0.01),
        e.clientX - box.left,
        e.clientY - box.top,
      );
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, []);

  const nodes = useMemo(
    () => nodesAt(visible, layout, near, view.k),
    [visible, layout, near, view.k],
  );
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const active = selected ? byId.get(selected)?.record : undefined;

  const needle = query.trim().toLowerCase();
  const matches = useMemo(
    () =>
      needle
        ? nodes
            .filter((n) =>
              `${n.record.title} ${n.record.tags.join(" ")}`
                .toLowerCase()
                .includes(needle),
            )
            .sort((a, b) => b.degree - a.degree)
        : null,
    [nodes, needle],
  );

  // What is lit: the hovered or selected record with its neighbours, else the search matches.
  const focusId = hovered && byId.has(hovered) ? hovered : (active?.id ?? null);
  const lit = useMemo(() => {
    if (focusId) return new Set([focusId, ...(near.get(focusId) ?? [])]);
    return matches ? new Set(matches.map((n) => n.id)) : null;
  }, [focusId, near, matches]);

  // Which records are cards. With nothing lit: the highest ranks that do not overlap. With lit
  // records: the same cards for the faded records, and among the lit ones the record in focus
  // first, then the ones that are cards already (so they do not change), then the rest.
  const baseCards = useMemo(
    () =>
      placeCards(
        byRank(nodes).map((n) => n.card),
        { gap: CARD_GAP },
      ),
    [nodes],
  );
  const cards = useMemo(() => {
    if (!lit) return baseCards;
    const first = [focusId, active?.id].filter(
      (id, i, list): id is string => !!id && list.indexOf(id) === i,
    );
    const order = (n: Node) =>
      first.includes(n.id) ? 0 : baseCards.has(n.id) ? 1 : 2;
    const wanted = byRank([...lit].map((id) => byId.get(id)!)).sort(
      (a, b) => order(a) - order(b),
    );
    const litCards = placeCards(
      wanted.map((n) => n.card),
      { forced: first.filter((id) => lit.has(id)).length, gap: CARD_GAP },
    );
    return new Set([
      ...[...baseCards].filter((id) => !lit.has(id)),
      ...litCards,
    ]);
  }, [lit, focusId, active, baseCards, byId]);

  // The visible area, in the coordinates of the nodes. It follows the view that the last zoom
  // or finished drag left, so labels do not move while a drag is in progress.
  const bounds = useMemo<Box>(
    () => ({
      x0: LABEL_INSET - view.x,
      y0: LABEL_INSET - view.y,
      x1: size.width - LABEL_INSET - view.x,
      y1: size.height - FIT_PADDING_BOTTOM - view.y,
    }),
    [view.x, view.y, size],
  );
  // Titles of the dots. A faded record gets no title and does not block one.
  const labels = useMemo(() => {
    const shown = lit ? nodes.filter((n) => lit.has(n.id)) : nodes;
    return placeLabels(
      shown.map((n) => ({
        id: n.id,
        box: cards.has(n.id)
          ? cardBox(n.card)
          : cardBox({
              ...n.label,
              width: 2 * n.label.r,
              height: 2 * n.label.r,
            }),
      })),
      byRank(shown.filter((n) => !cards.has(n.id))).map((n) => n.label),
      LABEL_HEIGHT,
      bounds,
    );
  }, [nodes, lit, cards, bounds]);

  const scene = useMemo(() => {
    return {
      lines: (
        <>
          <g>
            {lines.map((line) => {
              const a = byId.get(line.a)!;
              const b = byId.get(line.b)!;
              const onFocus =
                !!focusId && (line.a === focusId || line.b === focusId);
              const { control, path } = curve(a, b);
              return (
                <g
                  key={line.key}
                  className={`kg-edge ${line.type} ${onFocus ? "lit" : ""} ${lit && !onFocus ? "dim" : ""}`}
                >
                  <path d={path} />
                  {onFocus && line.aToB && (
                    <polygon points={arrowHead(control, b, cards.has(b.id))} />
                  )}
                  {onFocus && line.bToA && (
                    <polygon points={arrowHead(control, a, cards.has(a.id))} />
                  )}
                </g>
              );
            })}
          </g>
          <g>
            {nodes.map((node) => {
              const label = labels.get(node.id);
              return label ? (
                <text
                  key={node.id}
                  className="kg-label"
                  x={label.x}
                  y={label.y}
                  textAnchor={label.anchor}
                  dominantBaseline="central"
                >
                  {labelText(node.record.title)}
                </text>
              ) : null;
            })}
          </g>
        </>
      ),
      nodes: nodes.map((node) => {
        const { record } = node;
        const Icon = kindMeta[record.kind].icon;
        const isCard = cards.has(record.id);
        const picked = record.id === selected;
        const state = !lit ? "" : lit.has(record.id) ? "lit" : "dim";
        const box = isCard
          ? node.size
          : { width: 2 * node.label.r, height: 2 * node.label.r };
        return (
          <button
            key={record.id}
            type="button"
            data-node={record.id}
            aria-pressed={picked}
            aria-label={`${record.title}, ${kindMeta[record.kind].label}, ${node.degree} connections`}
            title={record.title}
            className={`kg-node ${record.kind} ${isCard ? "card" : "dot"} ${node.size.lines === 1 ? "one" : ""} ${picked ? "picked" : ""} ${state}`}
            style={{
              left: node.x,
              top: node.y,
              width: box.width,
              height: box.height,
              ["--kg" as string]: KIND_COLOR[record.kind],
              ["--kg-scale" as string]: isCard
                ? node.card.width / node.size.width
                : 1,
              ["--kg-lines" as string]: node.size.lines,
            }}
            onClick={() => setSelected(record.id)}
            onPointerEnter={() => {
              if (!pan.current) setHovered(record.id);
            }}
            onPointerLeave={() => setHovered(null)}
          >
            <Icon size={CARD.icon} />
            <span>{record.title}</span>
          </button>
        );
      }),
    };
  }, [lines, nodes, byId, labels, cards, lit, focusId, selected]);

  /** Select a record and bring it into view when it is outside the canvas. */
  const reveal = (id: string) => {
    const record = workspace.records.find((r) => r.id === id);
    if (!record) return;
    if (hidden.has(record.kind)) {
      // The layout changes, and the new layout is fitted to the canvas.
      setHidden((h) => new Set([...h].filter((kind) => kind !== record.kind)));
    } else {
      const node = byId.get(id);
      const margin = 60;
      if (
        node &&
        (node.x + view.x < margin ||
          node.x + view.x > size.width - margin ||
          node.y + view.y < margin ||
          node.y + view.y > size.height - margin)
      ) {
        touched.current = true;
        setView((v) => ({
          ...v,
          x: size.width / 2 - node.x,
          y: size.height / 2 - node.y,
        }));
      }
    }
    setSelected(id);
  };

  const endPan = () => {
    const start = pan.current;
    pan.current = null;
    if (!start) return;
    if (!start.moved) {
      // A click on the empty canvas (no drag) clears the selection.
      setSelected(null);
      return;
    }
    touched.current = true;
    setView((v) => ({ ...v, x: v.x + drag.dx, y: v.y + drag.dy }));
    setDrag({ dx: 0, dy: 0 });
  };

  const toggleKind = (kind: Kind) =>
    setHidden((h) => {
      const next = new Set(h);
      if (!next.delete(kind)) next.add(kind);
      return next;
    });

  const addLink = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api(
        "/api/relations",
        jsonOptions("POST", { source, target, type }),
      );
      await onChange();
      setLinkOpen(false);
      notify("Connection added to your knowledge graph");
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const topConnected = useMemo(
    () =>
      [...nodes]
        .filter((n) => n.degree > 0)
        .sort((a, b) => b.degree - a.degree)
        .slice(0, TOP_CONNECTED),
    [nodes],
  );
  const unlinked = nodes.filter((n) => n.degree === 0).length;
  const activeEdges = active
    ? edges.filter((e) => e.source === active.id || e.target === active.id)
    : [];

  return (
    <div className="kg">
      <p className="page-description">
        Follow the connections. See what your research is trying to tell you.
      </p>
      <div className="kg-toolbar">
        <div className="kg-search">
          <Search size={14} />
          <input
            aria-label="Search graph"
            placeholder="Find an entry…"
            value={query}
            onChange={(e) => {
              // A selection has priority over the matches, so a new search clears it.
              setQuery(e.target.value);
              setSelected(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && matches?.length) reveal(matches[0].id);
            }}
          />
          {matches && (
            <span className="kg-search-count">{matches.length} found</span>
          )}
        </div>
        <span className="kg-count">
          {nodes.length === workspace.records.length
            ? `${nodes.length} entries`
            : `${nodes.length} of ${workspace.records.length} entries`}{" "}
          · {lines.length} connections
        </span>
        <button
          className="button secondary"
          onClick={() => {
            setSource(selected || "");
            setLinkOpen(true);
          }}
        >
          <Link2 size={14} />
          Connect entries
        </button>
      </div>
      <div className="kg-kinds" role="group" aria-label="Record types shown">
        {KINDS.filter((kind) => counts.has(kind)).map((kind) => (
          <button
            key={kind}
            className={`kg-kind ${kind}`}
            style={{ ["--kg" as string]: KIND_COLOR[kind] }}
            aria-pressed={!hidden.has(kind)}
            title={
              hidden.has(kind)
                ? `Show ${kindMeta[kind].label.toLowerCase()} entries`
                : `Hide ${kindMeta[kind].label.toLowerCase()} entries`
            }
            onClick={() => toggleKind(kind)}
          >
            <span className={`kg-swatch ${kind}`} />
            {kindMeta[kind].label}
            <b>{counts.get(kind)}</b>
          </button>
        ))}
        <span className="kg-edge-key">
          <i className="supports" />
          supports
          <i className="contradicts" />
          contradicts
        </span>
      </div>
      <div className="kg-layout">
        <div
          className="kg-canvas"
          ref={canvas}
          role="group"
          aria-label="Knowledge graph. Select an entry to see its connections."
          onKeyDown={(e) => {
            if (e.key === "Escape") setSelected(null);
          }}
        >
          <svg
            width={size.width}
            height={size.height}
            aria-hidden
            onPointerDown={(e) => {
              pan.current = { x: e.clientX, y: e.clientY, moved: false };
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              const start = pan.current;
              if (!start) return;
              const dx = e.clientX - start.x;
              const dy = e.clientY - start.y;
              if (!start.moved && Math.hypot(dx, dy) < 4) return;
              start.moved = true;
              setDrag({ dx, dy });
            }}
            onPointerUp={endPan}
            onPointerCancel={() => {
              pan.current = null;
              setDrag({ dx: 0, dy: 0 });
            }}
          >
            <g transform={`translate(${view.x + drag.dx} ${view.y + drag.dy})`}>
              {scene.lines}
            </g>
          </svg>
          <div
            className="kg-nodes"
            style={{
              transform: `translate(${view.x + drag.dx}px, ${view.y + drag.dy}px)`,
            }}
          >
            {scene.nodes}
          </div>
          {!nodes.length && (
            <div className="kg-empty">
              <EmptyState
                icon={Network}
                title={
                  workspace.records.length
                    ? "Every record type is hidden"
                    : "No entries yet"
                }
                description={
                  workspace.records.length
                    ? "Select a record type above to show its entries."
                    : "Create notes, experiments and findings. Their links appear here."
                }
              />
            </div>
          )}
          <div className="kg-controls">
            <button
              aria-label="Zoom out"
              onClick={() => zoomAt(1 / 1.25, size.width / 2, size.height / 2)}
            >
              <ZoomOut size={16} />
            </button>
            <span>{Math.round(view.k * 100)}%</span>
            <button
              aria-label="Zoom in"
              onClick={() => zoomAt(1.25, size.width / 2, size.height / 2)}
            >
              <ZoomIn size={16} />
            </button>
            <button
              aria-label="Fit the graph to the view"
              title="Fit the graph to the view"
              onClick={() => {
                touched.current = false;
                setView(fit());
              }}
            >
              <Focus size={16} />
            </button>
          </div>
          <span className="kg-hint">
            Drag to move · pinch or Ctrl/⌘ + scroll to zoom
          </span>
        </div>
        <aside className="kg-inspector">
          {active ? (
            <>
              <div className="kg-inspector-top">
                <KindBadge kind={active.kind} />
                <button
                  className="icon-button"
                  aria-label="Clear selection"
                  onClick={() => setSelected(null)}
                >
                  <X size={14} />
                </button>
              </div>
              <h2>{active.title}</h2>
              {excerpt(active.content, 220) && (
                <p>{excerpt(active.content, 220)}</p>
              )}
              <div className="kg-actions">
                <button
                  className="button secondary"
                  onClick={() => onOpen(active)}
                >
                  Open entry
                  <ArrowUpRight size={15} />
                </button>
                <button
                  className="text-button"
                  onClick={() => {
                    setSource(active.id);
                    setLinkOpen(true);
                  }}
                >
                  <Plus size={14} />
                  Add connection
                </button>
              </div>
              <h3>
                Connections <b>{activeEdges.length}</b>
              </h3>
              <div className="kg-list">
                {activeEdges.map((edge) => {
                  const outgoing = edge.source === active.id;
                  const other = workspace.records.find(
                    (r) => r.id === (outgoing ? edge.target : edge.source),
                  )!;
                  return (
                    <button
                      key={edge.id}
                      onClick={() => reveal(other.id)}
                      onPointerEnter={() => setHovered(other.id)}
                      onPointerLeave={() => setHovered(null)}
                    >
                      <small className={edge.origin ? "" : edge.type}>
                        {edge.origin || `${outgoing ? "→" : "←"} ${edge.type}`}
                      </small>
                      <span
                        className={`kg-swatch ${other.kind}`}
                        style={{ ["--kg" as string]: KIND_COLOR[other.kind] }}
                      />
                      <span>{other.title}</span>
                    </button>
                  );
                })}
                {!activeEdges.length && (
                  <p>No connections yet. Add one to give this entry context.</p>
                )}
              </div>
            </>
          ) : (
            <>
              <h3>Most connected</h3>
              <div className="kg-list">
                {topConnected.map((node) => (
                  <button
                    key={node.id}
                    onClick={() => reveal(node.id)}
                    onPointerEnter={() => setHovered(node.id)}
                    onPointerLeave={() => setHovered(null)}
                  >
                    <span
                      className={`kg-swatch ${node.record.kind}`}
                      style={{
                        ["--kg" as string]: KIND_COLOR[node.record.kind],
                      }}
                    />
                    <span>{node.record.title}</span>
                    <b>{node.degree}</b>
                  </button>
                ))}
                {!topConnected.length && (
                  <p>No connections yet. Use “Connect entries” to add one.</p>
                )}
              </div>
              <p className="kg-note">
                {unlinked > 0 &&
                  `${unlinked} ${unlinked === 1 ? "entry has" : "entries have"} no connection. `}
                {hidden.has("task") &&
                  counts.has("task") &&
                  "Tasks are hidden: select “Task” above to show them. "}
                Select an entry to see its connections. Zoom in to turn dots
                into cards.
              </p>
            </>
          )}
        </aside>
      </div>
      {linkOpen && (
        <Modal
          title="Connect research entries"
          onClose={() => setLinkOpen(false)}
        >
          <form className="connection-form" onSubmit={addLink}>
            <span className="eyebrow">MAKE A CONNECTION</span>
            <h2>One idea leads to another.</h2>
            <label>
              Source entry
              <Select
                label="Source entry"
                value={source}
                onValueChange={(value) => {
                  setSource(value);
                  if (target === value) setTarget("");
                }}
                options={[
                  { value: "", label: "Choose an entry" },
                  ...workspace.records.map((r) => ({
                    value: r.id,
                    label: r.title,
                  })),
                ]}
              />
            </label>
            <label>
              Relationship
              <Select
                label="Relationship"
                value={type}
                onValueChange={(value) => setType(value as Relation["type"])}
                options={[
                  "relates",
                  "supports",
                  "contradicts",
                  "extends",
                  "uses",
                ].map((value) => ({
                  value,
                  label: value === "relates" ? "relates to" : value,
                }))}
              />
            </label>
            <label>
              Target entry
              <Select
                label="Target entry"
                value={target}
                onValueChange={setTarget}
                options={[
                  { value: "", label: "Choose an entry" },
                  ...workspace.records
                    .filter((r) => r.id !== source)
                    .map((r) => ({ value: r.id, label: r.title })),
                ]}
              />
            </label>
            <p className="field-help">
              “Supports” and “contradicts” describe evidence, not just
              similarity. Direction goes from source to target.
            </p>
            <button
              className="button primary"
              disabled={busy || !source || !target || source === target}
            >
              <Link2 size={15} />
              {busy ? "Connecting…" : "Save connection"}
            </button>
          </form>
        </Modal>
      )}
    </div>
  );
}
