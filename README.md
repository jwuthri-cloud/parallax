# Parallax

**[▶ Watch the 2-minute tour](docs/parallax-tour.mp4)**

**Research, in perspective.** A private Next.js research workspace for the Anthropic Fellows project. The interface and Claude Code MCP server share local SQLite storage, with a separate database for each workspace.

## Run it

Requires **Node.js 22.13+** (tested with 22.23.3). SQLite is built into this Node version; its experimental-feature warning is expected. No external database, API keys, Python environment, or rented compute is required.

```bash
npm install
npm run dev
```

Open **http://127.0.0.1:3000**. For a production build:

```bash
npm run build
npm start
```

Both commands bind to loopback. Stop the development server before starting production on the same port. Do not expose this app through a public tunnel: it deliberately has no multi-user authentication.

## What you can do

- **Workspaces:** click the workspace name at the top of the sidebar to create or switch projects. Each has its own records, files, graph, budget, imports, and activity. New workspaces start empty; an optional research folder can be imported from Settings. Selection persists across reloads.
- **Observatory:** pinned context, activity, next tasks, and a budget reserve based on recorded spend.
- **Mission board:** drag tasks between Backlog, Up next, In progress, Blocked, and Done. Agents can maintain the same board through MCP. Cards have priority, assignee, due date, and acceptance criteria.
- **Experiments:** record hypotheses, methods, decision gates, seeds, code commits, model/dataset revisions, configs, commands, estimates, actual costs, and measured metrics. Metrics become charts; supplied uncertainty bounds appear as error bars. Use **Link chart** to embed a particular metric in other entries, with a backlink to its source experiment. Linked charts follow the latest recorded metrics; their source revision is visible.
- **Findings:** separate unverified claims, observations, and replicated results. Connect findings to their evidence.
- **Notebook:** visual block editing for notes, journals, references, and other research entries. Insert headings, lists, checklists, quotes, code, tables, dividers, and saved local figures. Drag blocks or use the page structure controls to rearrange them. Markdown remains the saved format; executable HTML and remote images stay inert.
- **Knowledge graph:** explore records and persistent directed relationships: supports, contradicts, extends, uses, and relates. Pan, zoom, filter, and follow neighboring records. Shared files and linked charts also connect their entries in the graph. These connections do not automatically count as scientific support. SQLite stores graph edges; no separate graph service is needed.
- **Figures & files:** preserve images, PDFs, CSV/JSON, Jupyter notebooks, HTML, Markdown, and configuration files. Every artifact has a SHA-256 hash. Notebook cells are displayed without execution. Self-contained HTML/SVG opens in an expandable interactive sandbox. Inline scripts can render charts, but cannot read the app. External scripts, fonts, assets, fetches, nested frames, and navigation away from the local origin are blocked. For Plotly, export with the library included in the HTML rather than a CDN link. **Manage links** connects one preserved file to multiple entries; **Link existing file or chart** attaches saved evidence from inside any entry.
- **Runs:** live training telemetry (W&B-style): `clients/python/parallax_track.py` streams metrics, config and GPU/CPU use; the tab shows a pre-built dashboard (Loss, Metrics, Optimization, System), live refresh, NaN/Inf warnings and run comparison with config diffs. See `clients/python/README.md`.
- **Traces:** LLM traces, shown with Tracely's own trace UI (vendored in `components/traces/tracely`; Tracely's layout classes, coloured by the active Parallax theme). Conversations list with range, model, experiment, status and text filters and server-side sorting; rows open into conversation → message → step columns (C/M/S). Trace and conversation pages have a **Table** view and a **Timeline** view (span tree, idle gaps collapsed, zoom, resizable span panel with formatted chat input/output, raw JSON and attributes). Traces arrive through MCP (`log_trace`, `import_traces`), `POST /api/traces`, or OTLP/JSON at `/v1/traces`. A trace can belong to an experiment; the experiment page links to its traces. Cost appears only when the producer reported it. To look around first, **Load demo traces** (top right of the tab) opens synthetic traces from `fixtures/demo-traces.jsonl` in a temporary demo workspace; nothing is written to your workspace, and the demo is gone when the server restarts.
- **Manuscript:** draft a paper and review evidence coverage. Findings qualify for the evidence-linked list only when marked observed/replicated and connected to an experiment. This is a review aid, not independent validation.
- **Session handoff:** resume with active tasks, blockers, review counts, and the latest journal.
- **Search:** `⌘K` / `Ctrl+K` searches titles, content, tags, and provenance. Press `N` outside a field to create a note.

No results or example measurement series are seeded. Initial tasks are explicitly planned starter tasks. Imported research is labeled **unverified**. Parallax does not execute experiments or authorize paid compute.

## Writing and appearance

Open an entry and choose **Edit**, or create a new one. **Compose** is the visual editor: type `/` on a fresh paragraph or use **Insert** to choose a block. Format selected text with the toolbar; `⌘B` / `Ctrl+B`, `⌘I` / `Ctrl+I`, and `⌘K` / `Ctrl+K` work inside the document. Hover beside a block for its drag grip, or use **Page structure** to move, duplicate, or delete whole blocks. Changes are undoable during an editing session.

**Markdown** edits the source directly; **Read** previews the saved format. Import a `.md` file at the cursor, copy or download Markdown, expand the page, and hide the outline for more writing space. The source is unchanged until you edit it. HTML, footnotes, reference-style links, and any syntax that cannot round-trip without structural changes stay in Markdown mode. Compose supports GFM tables, tasks, nested lists, fenced code, and standard inline formatting; it is not a full Notion replacement or a collaborative editor. Use **Save entry / Save revision** to persist changes. Closing a dirty editor asks before discarding; journal text remains immutable after its first save.

Use **Insert saved figure or file** to place an uploaded PNG/JPEG/WebP/GIF inside the text, or insert a link to another stored file. New inline artifact references are linked to the entry in the same save transaction, including through MCP. Evidence associations remain after a figure is removed from the body so older revisions keep their provenance; remove an association explicitly through **Manage links** when appropriate. Remote images remain placeholders. Live metric charts remain available through **Link existing file or chart**.

Choose **Moss**, **Glacier**, **Iris**, or **Paper** in the sidebar or **Workspace settings → Make yourself at home**. The choice persists in this browser across workspaces and reloads. A short window scrolls the sidebar without squeezing its cards.

## Your data

By default:

- Workspace catalog: `Helper/data/catalog.sqlite`
- Original workspace (`default`): `Helper/data/parallax.sqlite`
- Additional workspace stores: `Helper/data/workspaces/<workspace ID>/parallax.sqlite`
- Original artifact bytes: `Helper/data/artifacts/<sha256>`; additional workspaces have their own `artifacts/` folder beside their database
- Source repo: sibling `EvalGamingUnderPressureTraining`

Set `PARALLAX_DATA_DIR` to the shared storage root. `PARALLAX_RESEARCH_ROOT` chooses the original workspace’s source folder when its catalog entry is first created; new workspaces save their own optional source folder. Next.js reads `.env.local`; the MCP process needs matching environment values in its configuration. The MCP launcher resolves its working directory to this project, so it shares the correct database when launched from the Python repo.

The API answers only requests addressed to `localhost` or `127.0.0.1`. To serve a deployed copy that sits behind its own login (Cloudflare Access, basic auth), list its public hostnames in `PARALLAX_ALLOWED_HOSTS` (comma-separated, e.g. `parallax.example.com`); same-origin and cross-site checks still apply.

At first launch of the original workspace, the app snapshots `README.md` and `.md`, `.html`, and `.ipynb` files under `docs/` (up to 150 files, 5 MB per documentation file). The importer skips symlinks, hidden files, unchanged hashes, and other formats. Changed sources create **new linked snapshots**, preserving existing records and journals. Import again from Settings, or run `PARALLAX_WORKSPACE_ID=<id> npm run import` for a particular workspace (`default` is the original). Research source files are never edited or executed.

Record writes use SQLite transactions, WAL, revision checks, and retained historical payloads. Journal text cannot be changed after saving. Journal pin metadata can change without changing its text. Add a linked follow-up for corrections. The activity log includes the authoring source (UI, repository import, or Claude Code).

The data directory is restricted to the local user. Data is **not encrypted at rest**; use your system's disk encryption. It is excluded from Git. There is no cloud sync or telemetry integration. Local access checks reject hostile hosts and cross-origin browser requests. Any process already running as your OS user can access the store.

### Back up and recover

Use **Settings → Export full workspace** for a portable JSON snapshot containing records, revisions, graph edges, chart links, workspace identity, settings, the full activity log, and base64-encoded file bytes. This exports only the selected workspace; back up the entire data folder to preserve all workspaces and their catalog. Keep backups private. Exports are assembled in memory, so for a large artifact collection prefer a file-system backup.

To restore the native database, stop the app **and MCP processes**, then restore the entire `data/` folder from backup. Include `parallax.sqlite-wal` and `parallax.sqlite-shm` if present; copying only the SQLite file while a writer is active can lose recent changes. The JSON export is an archival/interchange format; there is no in-app JSON restore yet.

## Claude Code integration

See [MCP guide](docs/MCP.md). Settings also shows a copyable `.mcp.json` entry with the current paths. The server uses the official MCP TypeScript SDK and **stdio**; it needs no port, HTTP token, or running Next.js process.

```bash
npm run mcp
```

For actual MCP clients, invoke `node node_modules/tsx/dist/cli.mjs mcp/server.ts` directly rather than `npm run mcp`, because npm may print a banner to stdout. The server itself writes only protocol messages to stdout.

## Verify

```bash
npm test
npm run typecheck
npm run build
npm run test:production
```

Tests run in temporary databases and never write synthetic measurements to the real workspace. They exercise revisions, stale writers, immutable journals, atomic metrics, file hashes and path restrictions, graph integrity, Kanban updates, import idempotence, exports, origin checks, workspace isolation across concurrent requests, legacy file links, chart links, full HTML preview policy, and a real MCP stdio client.

## Project map

```text
app/                    Next.js App Router and local API routes
components/             Workspace UI, editor, record views, charts, graph, board
lib/schema.ts           Shared record validation and types
lib/store.ts            SQLite transactions, revisions, artifacts, graph
lib/traces.ts           LLM trace spans: ingest, trace/session queries
lib/otlp.ts             OTLP/JSON → spans (GenAI, OpenInference, OpenLLMetry, Vercel AI SDK)
lib/workspaces.ts       Persistent catalog and request-scoped workspace selection
lib/importer.ts         Read-only documentation snapshots
lib/http.ts             Loopback / origin checks and API errors
mcp/server.ts           Claude Code tools and research-contract resource
tests/                  Isolated storage, HTTP, and protocol tests
docs/BUILD_LOG.md       Implementation and verification log
data/                   Private runtime storage; ignored by Git
```

## Current limits

This is a single-researcher app with multiple local workspaces. Workspaces organize projects; they are not a security boundary between OS users or trusted local agents. It has no cloud deployment, multi-user auth, automatic GPU billing, automatic literature verification, scheduled agent execution, or model inference. Polling refreshes shared state every 15 seconds and when the window regains focus. Agents can use the tools, but nothing makes them run autonomously.

Budget totals are manually recorded experiment costs. Pilot spend is lifetime; fellowship spend groups experiments by creation month. Use separate run records for separately billed jobs. Blank costs mean **unknown**, not free. No raw model weights are accepted; keep those in private research storage and reference their paths or hashes.

The graph uses explicit connections rather than inferred embeddings. Search is local, case-insensitive, and matches all words. The app loads the current record collection in memory; paging and a full-text index are future improvements if the corpus becomes large.

Framework references: [Next.js App Router](https://nextjs.org/docs/app/getting-started), [official MCP server SDK guide](https://ts.sdk.modelcontextprotocol.io/server).
