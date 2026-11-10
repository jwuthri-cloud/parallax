# Parallax development

- This directory is the app. Python research lives in the sibling `EvalGamingUnderPressureTraining` repository.
- Do not run research experiments or paid jobs as part of app work. Estimate costs and obtain explicit approval before paid compute.
- Keep data local and private. Never commit `data/`, backups, credentials, or sensitive research artifacts.
- Do not create fake research results to populate the interface. Fixtures belong only in temporary test databases.
- Share validation and persistence between HTTP and MCP via `lib/schema.ts` and `lib/store.ts`.
- Keep journal content immutable, record edits revisioned, and artifact bytes content-addressed. Respect stale revision errors.
- Prefer small, readable changes. Run relevant tests and type checking; run the production build for app changes.
- Keep `docs/BUILD_LOG.md` concise and factual. Distinguish checks actually run from planned checks.
- Browser QA uses the existing local server when available. Do not expose it externally.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
