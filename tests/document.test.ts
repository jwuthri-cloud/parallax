import { isLocalArtifactUrl } from "../lib/document-media";
import { test } from "node:test";
import assert from "node:assert/strict";
import { getSchema } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import { history, undo } from "@tiptap/pm/history";
import {
  documentExtensions,
  inspectMarkdown,
  markdownManager,
  parseDocumentMarkdown,
  moveBlock,
  topLevelBlocks,
} from "../lib/document";

const codec = markdownManager();
const schema = getSchema(documentExtensions());
function stateFor(source: string) {
  return EditorState.create({
    schema,
    doc: schema.nodeFromJSON(parseDocumentMarkdown(source)),
    plugins: [history()],
  });
}

test("rich documents round-trip GFM headings, nested lists, tasks, quotes, links and code", () => {
  const source =
    '# Question\n\nAn **important** and *uncertain* idea with ~~old text~~, `x < 3`, and [source](https://example.com "Reference").\n\n## Steps\n\n1. Prepare\n   - Nested point\n2. Compare\n\n- [ ] Pending\n- [x] Complete\n\n> Keep uncertainty explicit.\n>\n> Another paragraph.\n\n```python\nvalue = "**literal**"\nprint(value)\n```\n\n---';
  assert.deepEqual(inspectMarkdown(source), { supported: true });
  const saved = codec.serialize(stateFor(source).doc.toJSON());
  assert.deepEqual(inspectMarkdown(saved), { supported: true });
  assert.match(saved, /value = "\*\*literal\*\*"/);
  assert.match(saved, /- \[x\] Complete/);
  assert.match(saved, /https:\/\/example.com/);
  assert.equal(
    stateFor(saved).doc.textContent,
    stateFor(source).doc.textContent,
  );
});

test("table alignment, escaped pipes and inline marks survive edit serialization", () => {
  const source =
    "| Measure | Meaning |\n| :--- | ---: |\n| **x** | `a\\|b` |\n| y | left \\| right |";
  assert.deepEqual(inspectMarkdown(source), { supported: true });
  const state = stateFor(source);
  const saved = codec.serialize(state.doc.toJSON());
  const reopened = stateFor(saved);
  assert.deepEqual(reopened.doc.toJSON(), state.doc.toJSON());
});

test("unsupported Markdown stays in source mode, including footnotes, HTML and reference definitions", () => {
  for (const source of [
    "Text[^1]\n\n[^1]: A citation.",
    "<details><summary>Hidden</summary>Text</details>",
    "[source][id]\n\n[id]: https://example.com",
  ]) {
    assert.equal(inspectMarkdown(source).supported, false, source);
  }
});

test("image references retain their original location while the visual node never renders an img", () => {
  const source =
    'A ![chart](https://example.com/private.png "Chart") reference.';
  assert.deepEqual(inspectMarkdown(source), { supported: true });
  const doc = stateFor(source).doc;
  assert.equal(codec.serialize(doc.toJSON()), source);
  let imageNode;
  doc.descendants((node) => {
    if (node.type.name === "image") imageNode = node;
  });
  assert.ok(imageNode);
  const output = schema.nodes.image.spec.toDOM!(imageNode);
  assert.ok(Array.isArray(output));
  assert.equal(output[0], "span");
  assert.doesNotMatch(JSON.stringify(output), /https:\/\//);
});

test("reordering whole blocks preserves nested content and is undoable", () => {
  const source = "# First\n\n- one\n- two\n\n```python\nprint(42)\n```\n\nLast";
  let state = stateFor(source);
  const original = state.doc.toJSON();
  const tr = moveBlock(state, 1, 3);
  assert.ok(tr);
  state = state.apply(tr);
  assert.deepEqual(
    topLevelBlocks(state.doc).map((b) => b.node.type.name),
    ["heading", "codeBlock", "paragraph", "bulletList"],
  );
  assert.equal(topLevelBlocks(state.doc)[3].node.textContent, "onetwo");
  assert.ok(
    undo(state, (transaction) => {
      state = state.apply(transaction);
    }),
  );
  assert.deepEqual(state.doc.toJSON(), original);
  const reverse = moveBlock(state, 3, 0);
  assert.ok(reverse);
  state = state.apply(reverse);
  assert.equal(state.doc.firstChild?.textContent, "Last");
  assert.equal(moveBlock(state, -1, 2), null);
  assert.equal(moveBlock(state, 2, 2), null);
});

test("literal Markdown punctuation typed into a rich paragraph is escaped, not reinterpreted", () => {
  const state = stateFor("Initial");
  const changed = state.apply(
    state.tr.insertText(" **literal** [not a link] #hash", 8),
  );
  const saved = codec.serialize(changed.doc.toJSON());
  assert.equal(stateFor(saved).doc.textContent, changed.doc.textContent);
  assert.deepEqual(stateFor(saved).doc.toJSON(), changed.doc.toJSON());
});

test("blank pages can enter visual composition without changing the saved source", () => {
  for (const source of ["", "\n\n", " "])
    assert.deepEqual(inspectMarkdown(source), { supported: true });
});

test("only workspace-scoped local artifact URLs can render as document images", () => {
  const url =
    "/api/artifacts/11111111-1111-4111-8111-111111111111?workspaceId=default";
  assert.ok(isLocalArtifactUrl(url));
  for (const bad of [
    "https://example.com/x.png",
    "//example.com/x.png",
    "data:image/png;base64,AA",
    "/api/export",
    url + "&other=1",
    undefined,
    {},
  ])
    assert.equal(isLocalArtifactUrl(bad), false);
  const json = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "image",
            attrs: { src: url, alt: "Figure [A]", title: 'A "caption"' },
          },
        ],
      },
    ],
  };
  const saved = codec.serialize(json);
  assert.deepEqual(inspectMarkdown(saved), { supported: true });
  assert.equal(
    stateFor(saved).doc.firstChild?.firstChild?.attrs.alt,
    "Figure [A]",
  );
  const img = stateFor(saved).doc.firstChild!.firstChild!;
  const dom = schema.nodes.image.spec.toDOM!(img);
  assert.ok(Array.isArray(dom));
  assert.equal(dom[0], "img");
});
