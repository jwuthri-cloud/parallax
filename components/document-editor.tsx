"use client";
import { useMemo, useRef, useState, useEffect, type ReactNode } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import Placeholder from "@tiptap/extension-placeholder";
import { TextSelection } from "@tiptap/pm/state";
import {
  ArrowDown,
  ArrowUp,
  Bold,
  Check,
  CheckSquare,
  ChevronDown,
  Code2,
  Copy,
  Download,
  GripVertical,
  FileImage,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link2,
  List,
  ListOrdered,
  Maximize2,
  Minimize2,
  Minus,
  PanelLeft,
  Plus,
  Quote,
  Redo2,
  Search,
  Strikethrough,
  Table2,
  Trash2,
  Type,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import {
  documentExtensions,
  inspectMarkdown,
  markdownManager,
  parseDocumentMarkdown,
  moveBlock,
  topLevelBlocks,
} from "@/lib/document";
import { Markdown } from "./document-reader";
import { useWorkspaceApi } from "./ui";
import type { Artifact } from "@/lib/schema";
import { isLocalArtifactUrl } from "@/lib/document-media";

type BlockCommand = {
  id: string;
  title: string;
  description: string;
  icon: typeof Type;
  run: (editor: Editor) => void;
};
const commands: BlockCommand[] = [
  {
    id: "text",
    title: "Text",
    description: "A clean paragraph",
    icon: Type,
    run: (e) => {
      e.chain().focus().setParagraph().run();
    },
  },
  ...([1, 2, 3] as const).map((level) => ({
    id: `h${level}`,
    title: `Heading ${level}`,
    description: [
      "",
      "A new chapter",
      "A section of your story",
      "A little more detail",
    ][level],
    icon: [Type, Heading1, Heading2, Heading3][level],
    run: (e: Editor) => {
      e.chain().focus().toggleHeading({ level }).run();
    },
  })),
  {
    id: "bullet",
    title: "Bullet list",
    description: "Ideas, one at a time",
    icon: List,
    run: (e) => {
      e.chain().focus().toggleBulletList().run();
    },
  },
  {
    id: "number",
    title: "Numbered list",
    description: "A sequence of steps",
    icon: ListOrdered,
    run: (e) => {
      e.chain().focus().toggleOrderedList().run();
    },
  },
  {
    id: "todo",
    title: "Checklist",
    description: "Small steps toward an answer",
    icon: CheckSquare,
    run: (e) => {
      e.chain().focus().toggleTaskList().run();
    },
  },
  {
    id: "quote",
    title: "Quote / callout",
    description: "Give an idea some space",
    icon: Quote,
    run: (e) => {
      e.chain().focus().toggleBlockquote().run();
    },
  },
  {
    id: "code",
    title: "Code block",
    description: "Commands, configs, snippets",
    icon: Code2,
    run: (e) => {
      e.chain().focus().toggleCodeBlock().run();
    },
  },
  {
    id: "table",
    title: "Table",
    description: "Compare and organize",
    icon: Table2,
    run: (e) => {
      if (!e.isActive("table"))
        e.chain()
          .focus()
          .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
          .run();
    },
  },
  {
    id: "divider",
    title: "Divider",
    description: "A pause between ideas",
    icon: Minus,
    run: (e) => {
      e.chain().focus().setHorizontalRule().run();
    },
  },
];

function Tool({
  title,
  active,
  disabled,
  onClick,
  children,
}: {
  title: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      className={`document-tool ${active ? "active" : ""}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function DocumentEditor({
  value,
  onChange,
  title,
  artifacts,
}: {
  value: string;
  onChange: (value: string) => void;
  title: string;
  artifacts: Artifact[];
}) {
  const { url: workspaceUrl } = useWorkspaceApi();
  const [fileMenu, setFileMenu] = useState(false);
  const [fileQuery, setFileQuery] = useState("");
  const [initial] = useState(() => inspectMarkdown(value));
  const [initialContent] = useState(() =>
    initial.supported ? parseDocumentMarkdown(value) : "",
  );
  const [mode, setMode] = useState<"blocks" | "markdown" | "preview">(
    initial.supported ? "blocks" : "markdown",
  );
  const [notice, setNotice] = useState(initial.supported ? "" : initial.reason);
  const [outline, setOutline] = useState(true);
  const [wide, setWide] = useState(false);
  const [menu, setMenu] = useState(false);
  const [query, setQuery] = useState("");
  const [choice, setChoice] = useState(0);
  const [link, setLink] = useState<string | null>(null);
  const drag = useRef<{
    from: number;
    to: number;
    startY: number;
    moved: boolean;
  } | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [status, setStatus] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const sourceInput = useRef<HTMLTextAreaElement>(null);
  const callbacks = useRef({ onChange, mode });
  callbacks.current = { onChange, mode };
  const keyHandler = useRef<(event: KeyboardEvent) => boolean>(() => false);
  const extensions = useMemo(
    () => [
      ...documentExtensions(),
      Placeholder.configure({
        placeholder: ({ node }) =>
          node.type.name === "heading"
            ? "A heading for your idea…"
            : "Write something, or type / for blocks…",
      }),
    ],
    [],
  );
  const editor = useEditor({
    immediatelyRender: false,
    shouldRerenderOnTransaction: true,
    extensions,
    content: initialContent,
    editorProps: {
      attributes: {
        class: "document-prose",
        role: "textbox",
        "aria-label": "Document body",
        "aria-multiline": "true",
        spellcheck: "true",
        tabindex: "0",
      },
      handleKeyDown: (_view, event) => keyHandler.current(event),
      handlePaste: (_view, event) => {
        const text = event.clipboardData?.getData("text/plain");
        if (!text) return false;
        event.preventDefault();
        const e = editorRef.current;
        if (!e) return true;
        if (e.isActive("codeBlock") || !inspectMarkdown(text).supported) {
          e.view.dispatch(e.state.tr.insertText(text));
        } else {
          const content = parseDocumentMarkdown(text).content || [];
          // Inline paste should keep the current heading/list item and marks.
          if (content.length === 1 && content[0].type === "paragraph") {
            const inline = content[0].content || [];
            if (
              inline.every(
                (node) => node.type === "text" && !node.marks?.length,
              )
            )
              e.view.dispatch(e.state.tr.insertText(text));
            else e.commands.insertContent(inline);
          } else e.commands.insertContent(content);
        }
        return true;
      },
      clipboardTextSerializer: (slice) =>
        markdownManager().serialize({
          type: "doc",
          content: slice.content.toJSON(),
        }),
    },
    onUpdate: ({ editor: e }) => {
      if (callbacks.current.mode === "blocks")
        callbacks.current.onChange(e.getMarkdown());
    },
  });
  const editorRef = useRef(editor);
  editorRef.current = editor;
  // The Markdown textarea owns state while source mode is open. Synchronize only
  // on an explicit mode switch, never on every keystroke (which moves the caret).
  const slash =
    editor &&
    mode === "blocks" &&
    editor.state.selection.empty &&
    editor.state.selection.$from.parent.type.name === "paragraph"
      ? /^\/([^\n]*)$/.exec(editor.state.selection.$from.parent.textContent)
      : null;
  const menuQuery = slash ? slash[1] : query;
  const matching = commands.filter((c) =>
    `${c.title} ${c.description}`
      .toLowerCase()
      .includes(menuQuery.toLowerCase()),
  );
  const [dismissedSlash, setDismissedSlash] = useState<string | null>(null);
  const slashKey =
    slash && editor ? `${editor.state.selection.from}:${slash[0]}` : null;
  const menuVisible =
    mode === "blocks" && (menu || (!!slash && dismissedSlash !== slashKey));
  useEffect(() => {
    setChoice(0);
  }, [menuQuery]);

  function runCommand(command: BlockCommand) {
    if (!editor) return;
    if (slash) {
      const from = editor.state.selection.$from.start();
      editor.commands.deleteRange({ from, to: from + slash[0].length });
    }
    command.run(editor);
    setMenu(false);
    setQuery("");
    setDismissedSlash(null);
  }
  keyHandler.current = (event) => {
    if (
      menuVisible &&
      ["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(event.key)
    ) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setMenu(false);
        setDismissedSlash(slashKey);
      } else if (event.key === "Enter" && matching.length)
        runCommand(matching[Math.min(choice, matching.length - 1)]);
      else if (event.key !== "Enter")
        setChoice(
          (c) =>
            (c +
              (event.key === "ArrowDown" ? 1 : -1) +
              Math.max(1, matching.length)) %
            Math.max(1, matching.length),
        );
      return true;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      event.stopPropagation();
      setLink(editor?.getAttributes("link").href || "");
      return true;
    }
    return false;
  };
  function changeMode(next: typeof mode) {
    if (next === "blocks" && editor) {
      const check = inspectMarkdown(value);
      if (!check.supported) {
        setNotice(check.reason);
        setMode("markdown");
        return;
      }
      if (mode !== "blocks")
        editor.commands.setContent(parseDocumentMarkdown(value), {
          emitUpdate: false,
        });
      setNotice("");
    }
    setMode(next);
    setFileMenu(false);
    setMenu(false);
    setLink(null);
  }
  const blocks = editor ? topLevelBlocks(editor.state.doc) : [];
  const selectedIndex = editor
    ? blocks.findIndex(
        (b) =>
          editor.state.selection.from >= b.pos &&
          editor.state.selection.from < b.pos + b.node.nodeSize,
      )
    : -1;
  function focusBlock(index: number) {
    if (!editor || !blocks[index]) return;
    const pos = blocks[index].pos;
    editor.view.dispatch(
      editor.state.tr
        .setSelection(TextSelection.near(editor.state.doc.resolve(pos + 1)))
        .scrollIntoView(),
    );
    editor.view.focus();
  }
  function reorder(from: number, to: number) {
    if (!editor) return;
    const tr = moveBlock(editor.state, from, to);
    if (tr) {
      editor.view.dispatch(tr);
      setStatus(`Block moved to position ${to + 1}.`);
    }
  }
  function duplicateBlock() {
    if (!editor || !blocks[selectedIndex]) return;
    const b = blocks[selectedIndex];
    editor
      .chain()
      .focus()
      .insertContentAt(b.pos + b.node.nodeSize, b.node.toJSON())
      .run();
  }
  function deleteBlock() {
    if (!editor || !blocks[selectedIndex]) return;
    const b = blocks[selectedIndex];
    editor
      .chain()
      .focus()
      .deleteRange({ from: b.pos, to: b.pos + b.node.nodeSize })
      .run();
  }
  function exportMarkdown() {
    const url = URL.createObjectURL(
      new Blob([value], { type: "text/markdown;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(title || "Untitled").replace(/[^\p{L}\p{N}\-_ ]/gu, "").slice(0, 100) || "document"}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const words = value.trim() ? value.trim().split(/\s+/).length : 0;
  return (
    <section
      className={`document-editor ${wide ? "is-wide" : ""}`}
      aria-label="Document editor"
    >
      <div className="document-topline">
        <div className="document-mode" role="group" aria-label="Editing mode">
          {(["blocks", "markdown", "preview"] as const).map((m) => (
            <button
              type="button"
              key={m}
              aria-pressed={mode === m}
              className={mode === m ? "active" : ""}
              onClick={() => changeMode(m)}
            >
              {m === "blocks"
                ? "Compose"
                : m === "markdown"
                  ? "Markdown"
                  : "Read"}
            </button>
          ))}
        </div>
        <div className="document-tools">
          <Tool
            title="Import Markdown at cursor"
            onClick={() => fileInput.current?.click()}
          >
            <Upload size={15} />
          </Tool>
          <Tool
            title="Copy Markdown"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(value);
                setStatus("Markdown copied");
              } catch {
                setStatus(
                  "Clipboard unavailable. Use Markdown mode to select and copy.",
                );
              }
            }}
          >
            <Copy size={15} />
          </Tool>
          <Tool title="Download Markdown" onClick={exportMarkdown}>
            <Download size={15} />
          </Tool>
          <Tool
            title={wide ? "Compact page" : "Expand page"}
            active={wide}
            onClick={() => setWide(!wide)}
          >
            {wide ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </Tool>
        </div>
      </div>
      <input
        hidden
        ref={fileInput}
        type="file"
        accept=".md,.markdown,.txt,text/markdown,text/plain"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          if (file.size > 300000) {
            setStatus("Choose a Markdown file smaller than 300 KB.");
            return;
          }
          try {
            const text = await file.text();
            const check = inspectMarkdown(text);
            if (mode === "blocks" && editor && check.supported)
              editor
                .chain()
                .focus()
                .insertContent(parseDocumentMarkdown(text))
                .run();
            else {
              const start =
                mode === "markdown"
                  ? (sourceInput.current?.selectionStart ?? value.length)
                  : value.length;
              const end =
                mode === "markdown"
                  ? (sourceInput.current?.selectionEnd ?? start)
                  : start;
              onChange(
                value.slice(0, start) +
                  "\n\n" +
                  text +
                  "\n\n" +
                  value.slice(end),
              );
              setMode("markdown");
              if (!check.supported) setNotice(check.reason);
            }
            setStatus(`Inserted ${file.name}. Save the entry to keep it.`);
          } catch {
            setStatus("Could not read that file.");
          }
        }}
      />
      {notice && <p className="document-notice">{notice}</p>}
      {mode === "blocks" && editor && (
        <>
          <div
            className="document-toolbar"
            role="toolbar"
            aria-label="Text formatting"
          >
            <button
              type="button"
              className={`insert-block ${menuVisible ? "active" : ""}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setMenu(!menuVisible);
                setQuery("");
                setDismissedSlash(menuVisible ? slashKey : null);
              }}
            >
              <Plus size={15} /> Insert <ChevronDown size={12} />
            </button>
            <Tool
              title="Insert saved figure or file"
              active={fileMenu}
              onClick={() => {
                setFileMenu(!fileMenu);
                setMenu(false);
              }}
            >
              <FileImage size={16} />
            </Tool>
            <span className="toolbar-divider" />
            <Tool
              title="Bold (⌘B)"
              active={editor.isActive("bold")}
              onClick={() => editor.chain().focus().toggleBold().run()}
            >
              <Bold size={16} />
            </Tool>
            <Tool
              title="Italic (⌘I)"
              active={editor.isActive("italic")}
              onClick={() => editor.chain().focus().toggleItalic().run()}
            >
              <Italic size={16} />
            </Tool>
            <Tool
              title="Strikethrough"
              active={editor.isActive("strike")}
              onClick={() => editor.chain().focus().toggleStrike().run()}
            >
              <Strikethrough size={16} />
            </Tool>
            <Tool
              title="Inline code"
              active={editor.isActive("code")}
              onClick={() => editor.chain().focus().toggleCode().run()}
            >
              <Code2 size={16} />
            </Tool>
            <Tool
              title="Add link (⌘K)"
              active={editor.isActive("link")}
              onClick={() => setLink(editor.getAttributes("link").href || "")}
            >
              <Link2 size={16} />
            </Tool>
            <span className="toolbar-divider" />
            <Tool
              title="Undo"
              disabled={!editor.can().undo()}
              onClick={() => editor.chain().focus().undo().run()}
            >
              <Undo2 size={16} />
            </Tool>
            <Tool
              title="Redo"
              disabled={!editor.can().redo()}
              onClick={() => editor.chain().focus().redo().run()}
            >
              <Redo2 size={16} />
            </Tool>
            <Tool
              title="Page structure"
              active={outline}
              onClick={() => setOutline(!outline)}
            >
              <PanelLeft size={16} />
            </Tool>
          </div>
          {menuVisible && (
            <div
              className="block-menu"
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setMenu(false);
                  setDismissedSlash(slashKey);
                  editor.commands.focus();
                }
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  setChoice(
                    (c) =>
                      (c +
                        (e.key === "ArrowDown" ? 1 : -1) +
                        Math.max(1, matching.length)) %
                      Math.max(1, matching.length),
                  );
                }
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (matching.length)
                    runCommand(matching[Math.min(choice, matching.length - 1)]);
                }
              }}
            >
              <div className="block-menu-search">
                <Search size={14} />
                {slash ? (
                  <span>/{menuQuery || " Choose a block"}</span>
                ) : (
                  <input
                    autoFocus
                    aria-label="Search blocks"
                    placeholder="Find a block…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                )}
                <kbd>esc</kbd>
              </div>
              <div
                className="block-menu-items"
                role="listbox"
                aria-label="Insert a block"
              >
                {matching.map((c, i) => (
                  <button
                    type="button"
                    key={c.id}
                    role="option"
                    aria-selected={i === Math.min(choice, matching.length - 1)}
                    className={
                      i === Math.min(choice, matching.length - 1)
                        ? "active"
                        : ""
                    }
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => runCommand(c)}
                  >
                    <c.icon size={19} />
                    <span>
                      <strong>{c.title}</strong>
                      <small>{c.description}</small>
                    </span>
                  </button>
                ))}
                {!matching.length && (
                  <p>No blocks match. Try “table” or “code”.</p>
                )}
              </div>
            </div>
          )}
          {fileMenu && (
            <div
              className="document-file-picker"
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setFileMenu(false);
                  editor.commands.focus();
                }
              }}
            >
              <div className="block-menu-search">
                <Search size={14} />
                <input
                  autoFocus
                  aria-label="Find a saved figure or file"
                  placeholder="Find a saved figure or file…"
                  value={fileQuery}
                  onChange={(e) => setFileQuery(e.target.value)}
                />
                <Tool
                  title="Close file picker"
                  onClick={() => setFileMenu(false)}
                >
                  <X size={14} />
                </Tool>
              </div>
              <div className="document-file-results">
                {artifacts
                  .filter((a) =>
                    `${a.name} ${a.caption}`
                      .toLowerCase()
                      .includes(fileQuery.toLowerCase()),
                  )
                  .map((a) => (
                    <button
                      type="button"
                      key={a.id}
                      onClick={() => {
                        const src = workspaceUrl(`/api/artifacts/${a.id}`);
                        if (/^image\/(png|jpeg|webp|gif)$/.test(a.mime))
                          editor
                            .chain()
                            .focus()
                            .setImage({ src, alt: a.caption || a.name })
                            .run();
                        else
                          editor
                            .chain()
                            .focus()
                            .insertContent({
                              type: "text",
                              text: a.name,
                              marks: [{ type: "link", attrs: { href: src } }],
                            })
                            .run();
                        setFileMenu(false);
                      }}
                    >
                      <FileImage size={17} />
                      <span>
                        <strong>{a.name}</strong>
                        <small>
                          {/^image\/(png|jpeg|webp|gif)$/.test(a.mime)
                            ? "Insert figure"
                            : "Insert file link"}
                        </small>
                      </span>
                      <Plus size={14} />
                    </button>
                  ))}
                {!artifacts.length && (
                  <p>
                    Upload a figure in Figures & files first. Saved images can
                    be placed anywhere in your page.
                  </p>
                )}
                {artifacts.length > 0 &&
                  !artifacts.some((a) =>
                    `${a.name} ${a.caption}`
                      .toLowerCase()
                      .includes(fileQuery.toLowerCase()),
                  ) && <p>No saved files match.</p>}
              </div>
            </div>
          )}
          {link !== null && (
            <div
              className="document-link-form"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  e.currentTarget
                    .querySelector<HTMLButtonElement>("[data-apply]")
                    ?.click();
                }
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setLink(null);
                  editor.commands.focus();
                }
              }}
            >
              <Link2 size={15} />
              <input
                autoFocus
                aria-label="Link URL"
                placeholder="https://…"
                value={link}
                onChange={(e) => setLink(e.target.value)}
              />
              <button
                type="button"
                data-apply
                onClick={() => {
                  if (!link.trim())
                    editor
                      .chain()
                      .focus()
                      .extendMarkRange("link")
                      .unsetLink()
                      .run();
                  else if (
                    /^(https?:\/\/|mailto:|#)/i.test(link.trim()) ||
                    isLocalArtifactUrl(link.trim())
                  )
                    editor
                      .chain()
                      .focus()
                      .extendMarkRange("link")
                      .setLink({ href: link.trim() })
                      .run();
                  else {
                    setStatus("Use an https://, http://, mailto:, or # link.");
                    return;
                  }
                  setLink(null);
                }}
              >
                <Check size={16} /> Apply
              </button>
              <Tool title="Close link editor" onClick={() => setLink(null)}>
                <X size={15} />
              </Tool>
            </div>
          )}
          {editor.isActive("table") && (
            <div className="document-context-tools">
              <span>TABLE</span>
              <button
                type="button"
                onClick={() => editor.chain().focus().addRowAfter().run()}
              >
                + Row
              </button>
              <button
                type="button"
                onClick={() => editor.chain().focus().addColumnAfter().run()}
              >
                + Column
              </button>
              <button
                type="button"
                onClick={() => editor.chain().focus().deleteRow().run()}
              >
                Remove row
              </button>
              <button
                type="button"
                onClick={() => editor.chain().focus().deleteColumn().run()}
              >
                Remove column
              </button>
              <button
                type="button"
                onClick={() => editor.chain().focus().deleteTable().run()}
              >
                Remove table
              </button>
            </div>
          )}
          {editor.isActive("codeBlock") && (
            <div className="document-context-tools">
              <label>
                LANGUAGE{" "}
                <input
                  aria-label="Code language"
                  placeholder="python, bash, json…"
                  value={editor.getAttributes("codeBlock").language || ""}
                  onChange={(e) =>
                    editor.commands.updateAttributes("codeBlock", {
                      language:
                        e.target.value.replace(/[^a-zA-Z0-9_+-]/g, "") || null,
                    })
                  }
                />
              </label>
            </div>
          )}
          <div
            className={`document-workbench ${outline ? "with-outline" : ""}`}
          >
            {outline && (
              <aside className="document-outline" aria-label="Page structure">
                <div className="document-outline-title">
                  <span>ON THIS PAGE</span>
                  <small>{blocks.length} blocks</small>
                </div>
                <div className="outline-blocks">
                  {blocks.map((b, i) => (
                    <button
                      type="button"
                      key={i}
                      data-block-index={i}
                      className={`${selectedIndex === i ? "selected" : ""} ${overIndex === i ? "drop-target" : ""}`}
                      title={b.label}
                      onClick={() => focusBlock(i)}
                    >
                      <span
                        className="outline-grip"
                        aria-hidden="true"
                        onPointerDown={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          e.currentTarget.setPointerCapture(e.pointerId);
                          drag.current = {
                            from: i,
                            to: i,
                            startY: e.clientY,
                            moved: false,
                          };
                        }}
                        onPointerMove={(e) => {
                          if (!drag.current) return;
                          if (
                            Math.abs(e.clientY - drag.current.startY) < 5 &&
                            !drag.current.moved
                          )
                            return;
                          drag.current.moved = true;
                          const rows = e.currentTarget
                            .closest(".outline-blocks")
                            ?.querySelectorAll<HTMLElement>(
                              "[data-block-index]",
                            );
                          rows?.forEach((row) => {
                            const rect = row.getBoundingClientRect();
                            if (
                              e.clientY >= rect.top &&
                              e.clientY <= rect.bottom
                            ) {
                              const index = Number(row.dataset.blockIndex);
                              drag.current!.to = index;
                              setOverIndex(index);
                            }
                          });
                        }}
                        onPointerUp={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          const current = drag.current;
                          drag.current = null;
                          setOverIndex(null);
                          e.currentTarget.releasePointerCapture(e.pointerId);
                          if (current?.moved) reorder(current.from, current.to);
                          else focusBlock(i);
                        }}
                        onPointerCancel={() => {
                          drag.current = null;
                          setOverIndex(null);
                        }}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                        }}
                      >
                        <GripVertical size={12} />
                      </span>
                      <span className="outline-kind">
                        {b.node.type.name === "heading"
                          ? `H${b.node.attrs.level}`
                          : b.node.type.name === "table"
                            ? "▦"
                            : b.node.type.name === "codeBlock"
                              ? "{}"
                              : b.node.type.name.endsWith("List")
                                ? "☷"
                                : "·"}
                      </span>
                      <span>{b.label}</span>
                    </button>
                  ))}
                </div>
                <div className="block-actions">
                  <Tool
                    title="Move block up"
                    disabled={selectedIndex <= 0}
                    onClick={() => reorder(selectedIndex, selectedIndex - 1)}
                  >
                    <ArrowUp size={14} />
                  </Tool>
                  <Tool
                    title="Move block down"
                    disabled={
                      selectedIndex < 0 || selectedIndex >= blocks.length - 1
                    }
                    onClick={() => reorder(selectedIndex, selectedIndex + 1)}
                  >
                    <ArrowDown size={14} />
                  </Tool>
                  <Tool
                    title="Duplicate block"
                    disabled={selectedIndex < 0}
                    onClick={duplicateBlock}
                  >
                    <Copy size={14} />
                  </Tool>
                  <Tool
                    title="Delete block"
                    disabled={selectedIndex < 0}
                    onClick={deleteBlock}
                  >
                    <Trash2 size={14} />
                  </Tool>
                </div>
                <p>
                  Drag to rearrange.
                  <br />
                  Select a block to move or duplicate it.
                </p>
              </aside>
            )}
            <div className="document-canvas">
              <EditorContent editor={editor} />
              <button
                type="button"
                className="document-add-bottom"
                onClick={() => {
                  editor
                    .chain()
                    .focus("end")
                    .insertContentAt(editor.state.doc.content.size, {
                      type: "paragraph",
                    })
                    .focus("end")
                    .run();
                  setMenu(true);
                  setQuery("");
                }}
              >
                <Plus size={14} /> Add a block
              </button>
            </div>
          </div>
        </>
      )}
      {mode === "blocks" && !editor && (
        <div className="document-loading">Preparing your page…</div>
      )}
      {mode === "markdown" && (
        <textarea
          ref={sourceInput}
          className="document-source"
          aria-label="Entry content"
          spellCheck={false}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="# An idea worth exploring…"
        />
      )}
      {mode === "preview" && (
        <div className="document-reading">
          <Markdown>{value || "*An empty page. A place to begin.*"}</Markdown>
        </div>
      )}
      <footer className="document-status">
        <span>
          {words.toLocaleString()} words <i>·</i>{" "}
          {Math.max(1, Math.ceil(words / 220))} min read
        </span>
        <span>
          {mode === "blocks"
            ? "Type / for blocks"
            : "Plain Markdown · portable by design"}
        </span>
        <span>Saved with entry</span>
      </footer>
      {status && (
        <div className="document-feedback" role="status">
          {status}
          <button
            type="button"
            aria-label="Dismiss editor message"
            onClick={() => setStatus("")}
          >
            <X size={13} />
          </button>
        </div>
      )}
    </section>
  );
}
