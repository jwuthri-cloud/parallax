// The knowledge graph as the Graph view draws it: one edge per real connection, a force layout
// that puts linked records near each other, and cards and labels that never overlap.
// Pure: no I/O and no randomness, so the same workspace always draws the same picture.
import type { Relation, Workspace } from "./schema";

export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  type: Relation["type"];
  /** Where an implied edge comes from (a linked chart, a shared file, a reference); "" for a
   *  typed relation. An implied edge has no direction. */
  origin: string;
};

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** Every connection between two existing records. Typed relations come first; a chart link, a
 *  shared file or a `linkedIds` reference adds an edge only when the pair has no edge yet. */
export function graphEdges(
  workspace: Pick<
    Workspace,
    "records" | "relations" | "chartLinks" | "artifacts"
  >,
): GraphEdge[] {
  const ids = new Set(workspace.records.map((r) => r.id));
  const edges: GraphEdge[] = [];
  const typed = new Set<string>();
  const pairs = new Set<string>();
  const valid = (a: string, b: string) => a !== b && ids.has(a) && ids.has(b);

  for (const r of workspace.relations) {
    const key = `${r.source}>${r.target}>${r.type}`;
    if (!valid(r.source, r.target) || typed.has(key)) continue;
    typed.add(key);
    pairs.add(pairKey(r.source, r.target));
    edges.push({
      id: r.id,
      source: r.source,
      target: r.target,
      type: r.type,
      origin: "",
    });
  }
  const implied = (
    id: string,
    source: string,
    target: string,
    type: Relation["type"],
    origin: string,
  ) => {
    const key = pairKey(source, target);
    if (!valid(source, target) || pairs.has(key)) return;
    pairs.add(key);
    edges.push({ id, source, target, type, origin });
  };
  for (const l of workspace.chartLinks)
    implied(l.id, l.recordId, l.experimentId, "uses", `chart ${l.metricName}`);
  for (const a of workspace.artifacts)
    for (const target of a.recordIds.slice(1))
      implied(
        `${a.id}-${target}`,
        a.recordIds[0],
        target,
        "relates",
        `shared file ${a.name}`,
      );
  for (const r of workspace.records)
    for (const target of r.linkedIds)
      implied(`${r.id}-${target}`, r.id, target, "relates", "reference");
  return edges;
}

// The edge type a line takes when two records have more than one relation.
const TYPE_RANK: Relation["type"][] = [
  "contradicts",
  "supports",
  "extends",
  "uses",
  "relates",
];

export type GraphLine = {
  key: string;
  a: string;
  b: string;
  type: Relation["type"];
  /** True when a typed relation goes from `a` to `b` (or from `b` to `a`). */
  aToB: boolean;
  bToA: boolean;
};

/** One line per connected pair, among the records in `visible`. */
export function graphLines(
  edges: GraphEdge[],
  visible: Set<string>,
): GraphLine[] {
  const lines = new Map<string, GraphLine>();
  for (const e of edges) {
    if (!visible.has(e.source) || !visible.has(e.target)) continue;
    const key = pairKey(e.source, e.target);
    let line = lines.get(key);
    if (!line) {
      line = {
        key,
        a: e.source,
        b: e.target,
        type: e.type,
        aToB: false,
        bToA: false,
      };
      lines.set(key, line);
    }
    if (TYPE_RANK.indexOf(e.type) < TYPE_RANK.indexOf(line.type))
      line.type = e.type;
    if (!e.origin) {
      if (e.source === line.a) line.aToB = true;
      else line.bToA = true;
    }
  }
  return [...lines.values()];
}

/** Each record's neighbours. */
export function neighbours(lines: GraphLine[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const add = (from: string, to: string) => {
    const set = map.get(from);
    if (set) set.add(to);
    else map.set(from, new Set([to]));
  };
  for (const l of lines) {
    add(l.a, l.b);
    add(l.b, l.a);
  }
  return map;
}

export type Point = { x: number; y: number };
export type Box = { x0: number; y0: number; x1: number; y1: number };
const overlaps = (a: Box, b: Box) =>
  a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

// A record is drawn as a card: an icon and the title on 1 to 3 lines. Sizes in CSS pixels at
// zoom 100%. The view sets the same numbers on the element, so the layout knows the real box.
export const CARD = {
  maxWidth: 168,
  minWidth: 72,
  padX: 10,
  padY: 7,
  icon: 13,
  gap: 6,
  lineHeight: 15,
  maxLines: 3,
  /** Average glyph width of the 11.5px title font. */
  charWidth: 6.3,
};
export type Size = { width: number; height: number };

/** The box of the card for `title`, and the number of text lines it shows. */
export function cardSize(title: string): Size & { lines: number } {
  const chrome = 2 * CARD.padX + CARD.icon + CARD.gap;
  const textMax = CARD.maxWidth - chrome;
  const textWidth = title.length * CARD.charWidth;
  if (textWidth <= textMax)
    return {
      width: Math.max(CARD.minWidth, Math.ceil(textWidth) + chrome + 2),
      height: CARD.lineHeight + 2 * CARD.padY,
      lines: 1,
    };
  // Word wrap leaves the end of each line empty, so a line holds less than its width.
  const lines = Math.min(
    CARD.maxLines,
    Math.ceil(textWidth / (textMax * 0.88)),
  );
  return {
    width: CARD.maxWidth,
    height: lines * CARD.lineHeight + 2 * CARD.padY,
    lines,
  };
}

// Layout constants. The forces run in a space where x is divided by ASPECT, because cards are
// wide: the result is stretched back, and then cards that still overlap are moved apart.
const ASPECT = 2.2;
const LINK_DISTANCE = 64;
const CHARGE = 260;
const CHARGE_RANGE = 380;
const GRAVITY_X = 0.11;
const GRAVITY_Y = 0.09;
const FRICTION = 0.6;
// Cards that overlap after the forces move apart sideways unless that move is more than SPREAD
// times the vertical move: cards are wide, and the canvas is wider than tall.
const SPREAD = 2;
// Free room between two cards.
const CARD_GAP_X = 22;
const CARD_GAP_Y = 20;
// Groups with no link between them: the free room between two groups, and the shape of the
// block that they make together.
const GROUP_GAP = 44;
const GROUPS_ASPECT = 1.8;
// Records with no link: a grid under the graph.
const LOOSE_OFFSET_Y = 34;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export type LayoutNode = Size & { id: string };

/** Each group of linked records gets its own force layout (see `forceLayout`), and the groups
 *  sit side by side, the largest first. Records with no link go in a grid under them, in their
 *  given order. No two cards overlap. Deterministic. */
export function layoutGraph(
  nodes: LayoutNode[],
  lines: Pick<GraphLine, "a" | "b">[],
): Map<string, Point> {
  const layout = new Map<string, Point>();
  const sizes = new Map(nodes.map((n) => [n.id, n]));
  /** The box around the cards of `ids`, from their positions in `at`. */
  const extent = (ids: string[], at: Map<string, Point>): Box => {
    const boxes = ids.map((id) =>
      cardBox({ ...sizes.get(id)!, ...at.get(id)! }),
    );
    return {
      x0: Math.min(...boxes.map((b) => b.x0)),
      x1: Math.max(...boxes.map((b) => b.x1)),
      y0: Math.min(...boxes.map((b) => b.y0)),
      y1: Math.max(...boxes.map((b) => b.y1)),
    };
  };

  const groups = components(nodes, lines)
    .map((group) => {
      const at = forceLayout(group, lines);
      const ids = group.map((n) => n.id);
      return { ids, at, box: extent(ids, at) };
    })
    .sort(
      (a, b) =>
        (b.box.x1 - b.box.x0) * (b.box.y1 - b.box.y0) -
        (a.box.x1 - a.box.x0) * (a.box.y1 - a.box.y0),
    );
  // Rows of groups. A row is as wide as the widest group, or as a block of all groups that is
  // GROUPS_ASPECT times wider than tall.
  const area = groups.reduce(
    (sum, g) =>
      sum +
      (g.box.x1 - g.box.x0 + GROUP_GAP) * (g.box.y1 - g.box.y0 + GROUP_GAP),
    0,
  );
  const rowWidth = Math.max(
    Math.sqrt(area * GROUPS_ASPECT),
    ...groups.map((g) => g.box.x1 - g.box.x0),
  );
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  for (const group of groups) {
    const width = group.box.x1 - group.box.x0;
    const height = group.box.y1 - group.box.y0;
    if (x > 0 && x + width > rowWidth) {
      x = 0;
      y += rowHeight + GROUP_GAP;
      rowHeight = 0;
    }
    for (const id of group.ids) {
      const p = group.at.get(id)!;
      layout.set(id, { x: x + p.x - group.box.x0, y: y + p.y - group.box.y0 });
    }
    x += width + GROUP_GAP;
    rowHeight = Math.max(rowHeight, height);
  }

  const linked = [...layout.keys()];
  const loose = nodes.filter((n) => !layout.has(n.id));
  if (!loose.length) return layout;
  const box = linked.length
    ? extent(linked, layout)
    : { x0: 0, x1: 0, y0: 0, y1: 0 };
  const stepX = Math.max(...loose.map((n) => n.width)) + CARD_GAP_X;
  const stepY = Math.max(...loose.map((n) => n.height)) + CARD_GAP_Y;
  // As many per row as the graph is wide; with a narrow graph, a block that is wider than tall.
  const perRow = Math.max(
    Math.floor((box.x1 - box.x0) / stepX),
    Math.ceil(Math.sqrt(loose.length * 0.9)),
  );
  const top = linked.length ? box.y1 + LOOSE_OFFSET_Y + stepY / 2 : 0;
  loose.forEach((node, i) => {
    const row = Math.floor(i / perRow);
    const inRow = Math.min(perRow, loose.length - row * perRow);
    layout.set(node.id, {
      x: (box.x0 + box.x1) / 2 + ((i % perRow) - (inRow - 1) / 2) * stepX,
      y: top + row * stepY,
    });
  });
  return layout;
}

/** The groups of records that links join, each in the given order. A record with no link is in
 *  no group. */
function components(
  nodes: LayoutNode[],
  lines: Pick<GraphLine, "a" | "b">[],
): LayoutNode[][] {
  const known = new Set(nodes.map((n) => n.id));
  const near = new Map<string, string[]>();
  for (const l of lines) {
    if (l.a === l.b || !known.has(l.a) || !known.has(l.b)) continue;
    near.set(l.a, [...(near.get(l.a) ?? []), l.b]);
    near.set(l.b, [...(near.get(l.b) ?? []), l.a]);
  }
  const group = new Map<string, number>();
  let count = 0;
  for (const node of nodes) {
    if (group.has(node.id) || !near.has(node.id)) continue;
    const queue = [node.id];
    group.set(node.id, count);
    for (const id of queue)
      for (const next of near.get(id)!)
        if (!group.has(next)) {
          group.set(next, count);
          queue.push(next);
        }
    count++;
  }
  const groups: LayoutNode[][] = Array.from({ length: count }, () => []);
  for (const node of nodes) {
    const index = group.get(node.id);
    if (index !== undefined) groups[index].push(node);
  }
  return groups;
}

/** One group of linked records: links pull records together, every record pushes the others
 *  away, and a weak pull to the centre keeps the group compact. */
function forceLayout(
  nodes: LayoutNode[],
  lines: Pick<GraphLine, "a" | "b">[],
): Map<string, Point> {
  const n = nodes.length;
  const index = new Map(nodes.map((node, i) => [node.id, i]));
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const vx = new Float64Array(n);
  const vy = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const radius = 14 * Math.sqrt(i + 0.5);
    x[i] = radius * Math.cos(i * GOLDEN_ANGLE);
    y[i] = radius * Math.sin(i * GOLDEN_ANGLE);
  }
  const links: [number, number][] = [];
  const degree = new Float64Array(n);
  for (const l of lines) {
    const a = index.get(l.a);
    const b = index.get(l.b);
    if (a === undefined || b === undefined || a === b) continue;
    links.push([a, b]);
    degree[a]++;
    degree[b]++;
  }

  // Fewer steps for a very large graph: the pair loop is n² per step.
  const ticks = Math.max(60, Math.min(300, Math.round(150_000 / (n || 1))));
  const decay = 1 - Math.pow(0.001, 1 / ticks);
  let alpha = 1;
  for (let tick = 0; tick < ticks; tick++) {
    alpha -= alpha * decay;
    for (const [a, b] of links) {
      let dx = x[b] + vx[b] - x[a] - vx[a];
      let dy = y[b] + vy[b] - y[a] - vy[a];
      const length = Math.hypot(dx, dy) || 1e-6;
      // A hub with many links pulls each neighbour less, so its neighbours can spread out.
      const strength = 1 / Math.min(degree[a], degree[b]);
      const pull = ((length - LINK_DISTANCE) / length) * alpha * strength;
      dx *= pull;
      dy *= pull;
      const bias = degree[a] / (degree[a] + degree[b]);
      vx[b] -= dx * bias;
      vy[b] -= dy * bias;
      vx[a] += dx * (1 - bias);
      vy[a] += dy * (1 - bias);
    }
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        let dx = x[j] - x[i];
        let dy = y[j] - y[i];
        let d2 = dx * dx + dy * dy;
        if (d2 > CHARGE_RANGE * CHARGE_RANGE) continue;
        if (d2 < 1) {
          // Two records on the same point: push them apart along a fixed direction.
          dx = Math.cos(i + j);
          dy = Math.sin(i + j);
          d2 = 1;
        }
        const push = (CHARGE * alpha) / d2;
        vx[i] -= dx * push;
        vy[i] -= dy * push;
        vx[j] += dx * push;
        vy[j] += dy * push;
      }
    for (let i = 0; i < n; i++) {
      vx[i] = (vx[i] - x[i] * GRAVITY_X * alpha) * FRICTION;
      vy[i] = (vy[i] - y[i] * GRAVITY_Y * alpha) * FRICTION;
      x[i] += vx[i];
      y[i] += vy[i];
    }
  }
  for (let i = 0; i < n; i++) x[i] *= ASPECT;

  // Move apart every pair of cards that overlap (see SPREAD for the axis).
  for (let pass = 0; pass < 120; pass++) {
    let moved = false;
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        const dx = x[j] - x[i];
        const dy = y[j] - y[i];
        const overX =
          (nodes[i].width + nodes[j].width) / 2 + CARD_GAP_X - Math.abs(dx);
        const overY =
          (nodes[i].height + nodes[j].height) / 2 + CARD_GAP_Y - Math.abs(dy);
        if (overX <= 0 || overY <= 0) continue;
        // Two cards on the same line or column: a fixed direction, so the result is stable.
        const side = (d: number) =>
          d > 0 || (d === 0 && (i + j) % 2) ? 1 : -1;
        if (overX < overY * SPREAD) {
          x[i] -= (side(dx) * overX) / 2;
          x[j] += (side(dx) * overX) / 2;
        } else {
          y[i] -= (side(dy) * overY) / 2;
          y[j] += (side(dy) * overY) / 2;
        }
        moved = true;
      }
    if (!moved) break;
  }
  return new Map(nodes.map((node, i) => [node.id, { x: x[i], y: y[i] }]));
}

export type CardInput = Point & Size & { id: string };

/** The box of a card centred on its point, with `gap` free room around it. */
export const cardBox = (c: CardInput, gap = 0): Box => ({
  x0: c.x - c.width / 2 - gap,
  x1: c.x + c.width / 2 + gap,
  y0: c.y - c.height / 2 - gap,
  y1: c.y + c.height / 2 + gap,
});

/** The records that are drawn as cards: `wanted` is in priority order, and a record stays a dot
 *  when its card would cover an earlier card. The first `forced` records are always cards. */
export function placeCards(
  wanted: CardInput[],
  { forced = 0, gap = 0 }: { forced?: number; gap?: number } = {},
): Set<string> {
  const taken: Box[] = [];
  const cards = new Set<string>();
  wanted.forEach((card, i) => {
    const box = cardBox(card, gap / 2);
    if (i >= forced && taken.some((b) => overlaps(b, box))) return;
    taken.push(box);
    cards.add(card.id);
  });
  return cards;
}

export type LabelInput = {
  id: string;
  /** Node centre and radius, in screen pixels. */
  x: number;
  y: number;
  r: number;
  /** Label width in screen pixels. */
  width: number;
};
export type LabelSide =
  | "below"
  | "above"
  | "right"
  | "left"
  | "below-right"
  | "above-right"
  | "below-left"
  | "above-left";
export type PlacedLabel = {
  side: LabelSide;
  /** The text anchor point: `y` is the vertical centre of the text. */
  x: number;
  y: number;
  anchor: "start" | "middle" | "end";
};

// The sides a label can take, in order of preference, as a direction from the node centre.
const SIDES: [LabelSide, number, number][] = [
  ["below", 0, 1],
  ["above", 0, -1],
  ["right", 1, 0],
  ["left", -1, 0],
  ["below-right", 1, 1],
  ["above-right", 1, -1],
  ["below-left", -1, 1],
  ["above-left", -1, -1],
];
const LABEL_GAP = 5;

/** The label of `node` in direction (`sx`, `sy`): its anchor point and the box it covers. */
function labelAt(node: LabelInput, sx: number, sy: number, height: number) {
  // On a diagonal the label starts at the edge of the dot, not at its bounding square.
  const out = sx && sy ? node.r * Math.SQRT1_2 + 2 : node.r + LABEL_GAP;
  const x = node.x + sx * out;
  const y = node.y + sy * (out + height / 2);
  const x0 = sx === 0 ? x - node.width / 2 : sx > 0 ? x : x - node.width;
  return {
    x,
    y,
    anchor: (sx === 0 ? "middle" : sx > 0 ? "start" : "end") as
      "start" | "middle" | "end",
    box: { x0, x1: x0 + node.width, y0: y - height / 2, y1: y + height / 2 },
  };
}

/** Labels of the records that are drawn as dots. `wanted` is in priority order, and a label is
 *  dropped when all 8 sides would cover an obstacle (the box of another dot or card) or an
 *  earlier label, or leave `bounds` (the visible area). A node outside `bounds` gets no label. */
export function placeLabels(
  obstacles: { id: string; box: Box }[],
  wanted: LabelInput[],
  height: number,
  bounds?: Box,
): Map<string, PlacedLabel> {
  const inView = (box: Box) =>
    !bounds ||
    (box.x0 >= bounds.x0 &&
      box.x1 <= bounds.x1 &&
      box.y0 >= bounds.y0 &&
      box.y1 <= bounds.y1);
  const taken: Box[] = [];
  const placed = new Map<string, PlacedLabel>();
  for (const node of wanted) {
    if (!inView({ x0: node.x, x1: node.x, y0: node.y, y1: node.y })) continue;
    const fit = SIDES.map(([side, sx, sy]) => ({
      side,
      ...labelAt(node, sx, sy, height),
    })).find(
      ({ box }) =>
        inView(box) &&
        !taken.some((b) => overlaps(b, box)) &&
        !obstacles.some((o) => o.id !== node.id && overlaps(o.box, box)),
    );
    if (!fit) continue;
    taken.push(fit.box);
    placed.set(node.id, {
      side: fit.side,
      x: fit.x,
      y: fit.y,
      anchor: fit.anchor,
    });
  }
  return placed;
}
