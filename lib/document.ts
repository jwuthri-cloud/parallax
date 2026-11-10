import { isLocalArtifactUrl } from "./document-media";
import { getSchema, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown, MarkdownManager } from "@tiptap/markdown";
import { TableKit } from "@tiptap/extension-table";
import { TaskList, TaskItem } from "@tiptap/extension-list";
import Image from "@tiptap/extension-image";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { Node as ProseNode } from "@tiptap/pm/model";
import { TextSelection, type EditorState } from "@tiptap/pm/state";

// Keep image references in Markdown without fetching remote research resources.
const PrivateImage = Image.extend({
  renderMarkdown(node) {
    const alt = String(node.attrs?.alt || "").replace(/[\\[\]]/g, "\\$&");
    const src = String(node.attrs?.src || "");
    const title = String(node.attrs?.title || "").replace(/[\\"]/g, "\\$&");
    return `![${alt}](${src}${title ? ` "${title}"` : ""})`;
  },
  renderHTML({ node }) {
    if (isLocalArtifactUrl(node.attrs.src))
      return [
        "img",
        {
          src: node.attrs.src,
          alt: node.attrs.alt || "",
          title: node.attrs.title || "",
          loading: "lazy",
          class: "document-local-image",
        },
      ];
    return [
      "span",
      { class: "document-image-placeholder", contenteditable: "false" },
      `Image · ${node.attrs.alt || "attach locally to preview"}`,
    ];
  },
}).configure({ inline: true });

export function documentExtensions() {
  return [
    StarterKit.configure({
      underline: false,
      link: {
        openOnClick: false,
        autolink: false,
        HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" },
      },
      dropcursor: { color: "var(--lime)", width: 2 },
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: false } }),
    PrivateImage,
    Markdown.configure({
      markedOptions: { gfm: true },
      indentation: { style: "space", size: 2 },
    }),
  ];
}

const parser = unified().use(remarkParse).use(remarkGfm);
let manager: MarkdownManager | undefined;
let documentSchema: ReturnType<typeof getSchema> | undefined;
export function markdownManager() {
  return (manager ??= new MarkdownManager({
    extensions: documentExtensions(),
    markedOptions: { gfm: true },
    indentation: { style: "space", size: 2 },
  }));
}

export function parseDocumentMarkdown(source: string) {
  const document = markdownManager().parse(source);
  const normalize = (node: JSONContent): JSONContent => ({
    ...node,
    ...(node.content
      ? {
          content: node.content.map((child) => {
            const normalized = normalize(child);
            // Marked emits a bare image for a standalone image paragraph. Our images
            // are inline so they also work mid-sentence; restore the paragraph wrapper.
            return child.type === "image" &&
              !["paragraph", "heading"].includes(node.type || "")
              ? { type: "paragraph", content: [normalized] }
              : normalized;
          }),
        }
      : {}),
  });
  const normalized = normalize(document);
  if (!normalized.content?.length) normalized.content = [{ type: "paragraph" }];
  return normalized;
}

// Compare semantic Markdown trees before allowing a source -> blocks conversion.
// Unsupported syntax stays editable, byte-for-byte, in source mode.
function semanticTree(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(semanticTree).filter(Boolean);
  if (!value || typeof value !== "object") return value;
  const node = value as Record<string, unknown>;
  if (
    node.type === "paragraph" &&
    Array.isArray(node.children) &&
    node.children.every(
      (child) =>
        (child as { type: string; value: string }).type === "text" &&
        !(child as { value: string }).value.trim(),
    )
  )
    return null;
  return Object.fromEntries(
    Object.entries(node)
      .filter(([key]) => !["position", "spread"].includes(key))
      .map(([key, val]) => [key, semanticTree(val)]),
  );
}

export function inspectMarkdown(
  source: string,
): { supported: true } | { supported: false; reason: string } {
  const tree = parser.parse(source);
  const unsupported = new Set([
    "html",
    "footnoteDefinition",
    "footnoteReference",
    "definition",
    "linkReference",
    "imageReference",
  ]);
  const visit = (node: { type: string; children?: unknown[] }): boolean =>
    unsupported.has(node.type) ||
    !!node.children?.some((child) => visit(child as typeof node));
  if (visit(tree))
    return {
      supported: false,
      reason:
        "This page uses HTML, footnotes, or reference-style links. Markdown mode preserves that syntax exactly; the reading preview still works.",
    };
  try {
    const codec = markdownManager();
    const schema = (documentSchema ??= getSchema(documentExtensions()));
    const document = schema.nodeFromJSON(parseDocumentMarkdown(source));
    document.check();
    const roundTrip = codec.serialize(document.toJSON());
    if (
      JSON.stringify(semanticTree(tree)) !==
      JSON.stringify(semanticTree(parser.parse(roundTrip)))
    )
      return {
        supported: false,
        reason:
          "This page contains Markdown that cannot round-trip through blocks without changing its structure. Edit it in Markdown mode to preserve the original.",
      };
    return { supported: true };
  } catch {
    return {
      supported: false,
      reason:
        "This Markdown needs source mode. Your original text is preserved.",
    };
  }
}

export function topLevelBlocks(doc: ProseNode) {
  const blocks: {
    node: ProseNode;
    pos: number;
    index: number;
    label: string;
  }[] = [];
  doc.forEach((node, pos, index) =>
    blocks.push({
      node,
      pos,
      index,
      label:
        node.textBetween(0, node.content.size, " ", (child) =>
          child.type.name === "image"
            ? String(child.attrs.alt || "Figure")
            : "",
        ) ||
        ({
          horizontalRule: "Divider",
          table: "Table",
          paragraph: "Empty paragraph",
          codeBlock: "Code block",
        }[node.type.name] ??
          node.type.name),
    }),
  );
  return blocks;
}

export function moveBlock(state: EditorState, from: number, to: number) {
  const blocks = topLevelBlocks(state.doc);
  if (from === to || !blocks[from] || !blocks[to]) return null;
  const source = blocks[from];
  const target = blocks[to];
  const insertAt =
    from < to
      ? target.pos + target.node.nodeSize - source.node.nodeSize
      : target.pos;
  const tr = state.tr
    .delete(source.pos, source.pos + source.node.nodeSize)
    .insert(insertAt, source.node);
  tr.setSelection(TextSelection.near(tr.doc.resolve(insertAt + 1)));
  return tr.scrollIntoView();
}
