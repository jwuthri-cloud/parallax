// The knowledge graph helpers: edges, lines, card sizes, layout, and card and label placement.
// Pure functions, no store.
import { test } from "node:test";
import assert from "node:assert/strict";
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
  type CardInput,
  type LabelInput,
} from "../lib/graph";

type Fixture = Parameters<typeof graphEdges>[0];
const record = (id: string, linkedIds: string[] = []) =>
  ({ id, linkedIds }) as Fixture["records"][number];
const relation = (
  source: string,
  target: string,
  type: Fixture["relations"][number]["type"],
) => ({ id: `${source}-${target}-${type}`, source, target, type, label: "" });
const workspace = (parts: Partial<Fixture>): Fixture => ({
  records: [],
  relations: [],
  chartLinks: [],
  artifacts: [],
  ...parts,
});

test("graph edges: a pair that has a typed relation gets no implied edge", () => {
  const edges = graphEdges(
    workspace({
      // a and b reference each other, and a typed relation links them too.
      records: [
        record("a", ["b", "c", "gone", "a"]),
        record("b", ["a"]),
        record("c"),
        record("d"),
      ],
      relations: [
        relation("a", "b", "supports"),
        relation("a", "b", "supports"),
        relation("b", "a", "extends"),
        relation("a", "gone", "uses"),
      ],
      chartLinks: [
        { id: "chart", recordId: "d", experimentId: "c", metricName: "loss" },
      ],
      artifacts: [
        { id: "file", name: "plot.png", recordIds: ["c", "d", "b"] },
      ] as Fixture["artifacts"],
    }),
  );
  assert.deepEqual(
    edges.map((e) => [e.source, e.target, e.type, e.origin]),
    [
      ["a", "b", "supports", ""],
      ["b", "a", "extends", ""],
      ["d", "c", "uses", "chart loss"],
      // c-d already has the chart edge, so the shared file adds only c-b.
      ["c", "b", "relates", "shared file plot.png"],
      ["a", "c", "relates", "reference"],
    ],
  );
});

test("graph lines: one line per pair, with the strongest type and the directions", () => {
  const edges = graphEdges(
    workspace({
      records: [record("a"), record("b", ["c"]), record("c"), record("d")],
      relations: [
        relation("a", "b", "relates"),
        relation("b", "a", "contradicts"),
        relation("c", "d", "supports"),
      ],
    }),
  );
  const lines = graphLines(edges, new Set(["a", "b", "c"]));
  assert.deepEqual(
    lines.map((l) => [l.a, l.b, l.type, l.aToB, l.bToA]),
    [
      ["a", "b", "contradicts", true, true],
      // A reference is an implied edge: it has no direction. c-d is not drawn: d is hidden.
      ["b", "c", "relates", false, false],
    ],
  );
  const near = neighbours(lines);
  assert.deepEqual([...near.get("b")!].sort(), ["a", "c"]);
  assert.equal(near.get("d"), undefined);
});

test("card size: one line for a short title, up to three lines for a long one", () => {
  const short = cardSize("Baseline run");
  assert.equal(short.lines, 1);
  assert.equal(short.height, CARD.lineHeight + 2 * CARD.padY);
  assert.ok(short.width < CARD.maxWidth && short.width >= CARD.minWidth);
  assert.equal(cardSize("A").width, CARD.minWidth);

  const medium = cardSize("Fixture note 3: sources and checks");
  assert.deepEqual(
    [medium.width, medium.lines, medium.height],
    [CARD.maxWidth, 2, 2 * CARD.lineHeight + 2 * CARD.padY],
  );
  assert.equal(cardSize("x".repeat(400)).lines, CARD.maxLines);
});

// Two groups of five records (each a star around its first record) and two records with no link.
const size = { width: 160, height: 44 };
const sized = (ids: string[]) => ids.map((id) => ({ id, ...size }));
const ids = ["a0", "a1", "a2", "a3", "a4", "b0", "b1", "b2", "b3", "b4"];
const loose = ["x", "y"];
const lines = [1, 2, 3, 4].flatMap((i) => [
  { a: "a0", b: `a${i}` },
  { a: "b0", b: `b${i}` },
]);
type Layout = Map<string, { x: number; y: number }>;
const distance = (layout: Layout, a: string, b: string) =>
  Math.hypot(
    layout.get(a)!.x - layout.get(b)!.x,
    layout.get(a)!.y - layout.get(b)!.y,
  );
/** Pairs of cards that overlap or are nearer than the gap the layout promises. */
const tooClose = (layout: Layout, all: string[]) =>
  all.flatMap((a, i) =>
    all
      .slice(i + 1)
      .filter(
        (b) =>
          Math.abs(layout.get(a)!.x - layout.get(b)!.x) < size.width + 21.9 &&
          Math.abs(layout.get(a)!.y - layout.get(b)!.y) < size.height + 19.9,
      )
      .map((b) => `${a}-${b}`),
  );

test("layout: the same input gives the same positions", () => {
  assert.deepEqual(
    [...layoutGraph(sized([...ids, ...loose]), lines)],
    [...layoutGraph(sized([...ids, ...loose]), lines)],
  );
});

test("layout: linked records are close, groups are apart, no two cards overlap", () => {
  const layout = layoutGraph(sized(ids), lines);
  assert.equal(layout.size, ids.length);
  assert.deepEqual(tooClose(layout, ids), []);
  // Every record is nearer to the centre of its own star than to the other one.
  for (const group of ["a", "b"])
    for (let i = 1; i <= 4; i++) {
      const other = group === "a" ? "b0" : "a0";
      assert.ok(
        distance(layout, `${group}${i}`, `${group}0`) <
          distance(layout, `${group}${i}`, other),
      );
    }
});

test("layout: records with no link go in a grid under the graph", () => {
  const all = [...ids, ...loose];
  const layout = layoutGraph(sized(all), lines);
  const lowest = Math.max(...ids.map((id) => layout.get(id)!.y));
  for (const id of loose)
    assert.ok(layout.get(id)!.y - size.height / 2 > lowest + size.height / 2);
  assert.equal(layout.get("x")!.y, layout.get("y")!.y);
  assert.deepEqual(tooClose(layout, all), []);

  // Only unlinked records: a block that is wider than tall, with no graph above it.
  const five = ["p", "q", "r", "s", "t"];
  const only = layoutGraph(sized(five), []);
  assert.deepEqual(
    five.map((id) => only.get(id)!.y),
    [0, 0, 0, 64, 64],
  );
  assert.deepEqual(tooClose(only, five), []);
  assert.equal(layoutGraph([], []).size, 0);
});

const card = (id: string, x: number, y: number): CardInput => ({
  id,
  x,
  y,
  width: 100,
  height: 40,
});

test("cards: a record stays a dot when its card would cover an earlier card", () => {
  // b overlaps a. c is 104px from a: free with no gap, too near with a gap of 6.
  const wanted = [card("a", 0, 0), card("b", 60, 10), card("c", 104, 0)];
  assert.deepEqual([...placeCards(wanted)], ["a", "c"]);
  assert.deepEqual([...placeCards(wanted, { gap: 6 })], ["a"]);
  // The first records are always cards, and the next ones give way to them.
  assert.deepEqual([...placeCards(wanted, { forced: 2 })], ["a", "b"]);
});

const dot = (id: string, x: number, y: number, width = 60): LabelInput => ({
  id,
  x,
  y,
  r: 8,
  width,
});
const disc = (n: LabelInput) => ({
  id: n.id,
  box: cardBox({ ...n, width: 2 * n.r, height: 2 * n.r }),
});
const HEIGHT = 15;

test("labels: a label takes the first free side and never covers a node or a label", () => {
  // b sits right under a, so the label of a cannot go below it.
  const nodes = [dot("a", 0, 0), dot("b", 0, 24), dot("c", 300, 0)];
  const placed = placeLabels(nodes.map(disc), nodes, HEIGHT);
  assert.equal(placed.get("a")!.side, "above");
  assert.equal(placed.get("b")!.side, "below");
  assert.deepEqual(placed.get("c"), {
    side: "below",
    x: 300,
    y: 8 + 5 + HEIGHT / 2,
    anchor: "middle",
  });
});

test("labels: a card is an obstacle, and a label with no free side is dropped", () => {
  // A card under the dot blocks "below" and both lower diagonals: the label goes above.
  const node = dot("n", 0, 0);
  const under = { id: "card", box: cardBox(card("card", 0, 40)) };
  assert.equal(
    placeLabels([disc(node), under], [node], HEIGHT).get("n")!.side,
    "above",
  );

  // Eight nodes around the centre block every side of its label.
  const centre = dot("centre", 0, 0, 200);
  const ring = [
    [0, 26],
    [0, -26],
    [60, 0],
    [-60, 0],
    [60, 22],
    [60, -22],
    [-60, 22],
    [-60, -22],
  ].map(([x, y], i) => dot(`n${i}`, x, y));
  assert.equal(
    placeLabels([centre, ...ring].map(disc), [centre], HEIGHT).has("centre"),
    false,
  );
});

test("labels: labels stay inside the bounds", () => {
  // The canvas ends 10px under the nodes: "below" does not fit, and "above" fits. A node
  // outside the bounds gets no label.
  const nodes = [dot("a", 0, 0), dot("b", 200, 0), dot("far", 900, 0)];
  const bounds = { x0: -40, y0: -100, x1: 260, y1: 18 };
  const placed = placeLabels(nodes.map(disc), nodes, HEIGHT, bounds);
  assert.equal(placed.get("a")!.side, "above");
  assert.equal(placed.get("b")!.side, "above");
  assert.equal(placed.has("far"), false);
});
