import { AsyncLocalStorage } from "node:async_hooks";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, chmodSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { WorkspaceInfo } from "./schema";

export const dataDir = path.resolve(
  /* turbopackIgnore: true */ process.env.PARALLAX_DATA_DIR ||
    path.join(process.cwd(), "data"),
);
export const researchRoot = path.resolve(
  /* turbopackIgnore: true */ process.env.PARALLAX_RESEARCH_ROOT ||
    path.join(process.cwd(), "../EvalGamingUnderPressureTraining"),
);

export class StoreError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

let catalog: DatabaseSync | undefined;
const context = new AsyncLocalStorage<WorkspaceInfo>();

function registry() {
  if (catalog) return catalog;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  catalog = new DatabaseSync(path.join(dataDir, "catalog.sqlite"));
  chmodSync(path.join(dataDir, "catalog.sqlite"), 0o600);
  catalog.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, payload TEXT NOT NULL);`);
  catalog
    .prepare("INSERT OR IGNORE INTO workspaces(id,payload) VALUES (?,?)")
    .run(
      "default",
      JSON.stringify({
        id: "default",
        name: "Anthropic Fellows",
        description: "AI safety research",
        researchRoot,
        createdAt: new Date().toISOString(),
      }),
    );
  return catalog;
}

export function listWorkspaces(): WorkspaceInfo[] {
  return (
    registry()
      .prepare("SELECT payload FROM workspaces ORDER BY rowid")
      .all() as { payload: string }[]
  ).map((row) => JSON.parse(row.payload));
}

/** Synthetic demo data lives here: never in the catalog, never in the data folder. */
export const demoWorkspaceId = "demo";
const demoDataDir = path.join(os.tmpdir(), `parallax-demo-${process.pid}`);
const demoWorkspace: WorkspaceInfo = {
  id: demoWorkspaceId,
  name: "Demo traces",
  description: "Synthetic traces in a temporary folder",
  researchRoot: demoDataDir,
  createdAt: new Date().toISOString(),
};

export function getWorkspaceInfo(
  id = process.env.PARALLAX_WORKSPACE_ID || "default",
): WorkspaceInfo {
  if (id === demoWorkspaceId) return demoWorkspace;
  const row = registry()
    .prepare("SELECT payload FROM workspaces WHERE id = ?")
    .get(id) as { payload: string } | undefined;
  if (!row) throw new StoreError("Workspace not found", 404);
  return JSON.parse(row.payload);
}

export function activeWorkspace() {
  return context.getStore() || getWorkspaceInfo();
}
export function workspaceDataDir() {
  const { id } = activeWorkspace();
  if (id === demoWorkspaceId) return demoDataDir;
  return id === "default" ? dataDir : path.join(dataDir, "workspaces", id);
}
export function getResearchRoot() {
  return activeWorkspace().researchRoot;
}

/** A request-scoped context, never a process-wide mutable selection. */
export function runInWorkspace<T>(id: string | undefined, fn: () => T): T {
  return context.run(getWorkspaceInfo(id), fn);
}

export const workspaceInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(400).default(""),
  researchRoot: z.string().trim().max(2000).default(""),
});

export function createWorkspace(input: unknown): WorkspaceInfo {
  const value = workspaceInputSchema.parse(input);
  if (value.researchRoot) {
    if (!path.isAbsolute(value.researchRoot))
      throw new StoreError("Use an absolute research folder path");
    try {
      value.researchRoot = realpathSync(value.researchRoot);
      if (!statSync(value.researchRoot).isDirectory()) throw new Error();
    } catch {
      throw new StoreError(
        "Research folder does not exist or is not a directory",
      );
    }
  }
  const workspace = {
    ...value,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  registry()
    .prepare("INSERT INTO workspaces(id,payload) VALUES (?,?)")
    .run(workspace.id, JSON.stringify(workspace));
  return workspace;
}

export function closeCatalog() {
  catalog?.close();
  catalog = undefined;
}
