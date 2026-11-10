import { readdirSync, readFileSync, existsSync, lstatSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  db,
  createRecord,
  sha256,
  attachLocalFile,
  transaction,
} from "./store";

import { activeWorkspace, getResearchRoot } from "./workspaces";

/** Snapshot only documentation; never execute research code or overwrite source files. */
export function importRepository() {
  return transaction(importRepositoryWithinTransaction);
}
function importRepositoryWithinTransaction() {
  const researchRoot = getResearchRoot();
  if (!existsSync(researchRoot))
    return {
      imported: 0,
      skipped: 0,
      message: "Research folder is not available. Set PARALLAX_RESEARCH_ROOT.",
    };
  const files: string[] = [];
  function walk(folder: string, depth = 0) {
    if (depth > 5 || !existsSync(folder)) return;
    for (const name of readdirSync(folder)) {
      if (name.startsWith(".")) continue;
      const p = path.join(folder, name);
      const stat = lstatSync(p);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) walk(p, depth + 1);
      else if (/\.(md|html|ipynb)$/i.test(name) && stat.size <= 5 * 1024 * 1024)
        files.push(p);
    }
  }
  const readme = path.join(researchRoot, "README.md");
  if (existsSync(readme) && !lstatSync(readme).isSymbolicLink())
    files.push(readme);
  walk(path.join(researchRoot, "docs"));
  let commit = "";
  try {
    commit = execFileSync("git", ["-C", researchRoot, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    /* Uncommitted repositories still have content hashes. */
  }
  let imported = 0;
  let skipped = 0;
  for (const file of files.slice(0, 150)) {
    const bytes = readFileSync(file);
    const hash = sha256(bytes);
    const prev = db()
      .prepare("SELECT hash, record_id FROM imports WHERE source = ?")
      .get(file) as { hash: string; record_id: string } | undefined;
    if (prev?.hash === hash) {
      skipped++;
      continue;
    }
    const relative = path.relative(researchRoot, file);
    const markdown = file.endsWith(".md");
    const journal = /journal\/\d{4}-\d{2}-\d{2}\.md$/.test(relative);
    const text = bytes.toString("utf8");
    const firstHeading = text.match(/^#\s+(.+)$/m)?.[1];
    const title = journal
      ? `Lab journal · ${path.basename(file, ".md")}`
      : markdown
        ? firstHeading || path.basename(file)
        : path.basename(file).replace(/[-_]/g, " ");
    const projectImport = db()
      .prepare("SELECT record_id FROM imports WHERE source = ?")
      .get(readme) as { record_id: string } | undefined;
    const record = createRecord(
      {
        kind: journal ? "journal" : "reference",
        title: `${title}${prev ? " · updated source" : ""}`,
        content: markdown
          ? text.slice(0, 290000)
          : `Source snapshot of **${path.basename(file)}**. Open the attached file below.`,
        tags: ["imported", journal ? "lab-notes" : "project-context"],
        evidence: "unverified",
        pinned: relative === "README.md",
        linkedIds: [
          ...(prev ? [prev.record_id] : []),
          ...(file !== readme && projectImport
            ? [projectImport.record_id]
            : []),
        ],
        provenance: {
          repository: researchRoot,
          commit,
          sourcePath: relative,
          sourceHash: hash,
        },
      },
      "Repository import",
    );
    if (!markdown)
      attachLocalFile(file, {
        recordId: record.id,
        caption:
          "Imported source document. Claims have not been independently verified.",
        actor: "Repository import",
      });
    db()
      .prepare(
        "INSERT INTO imports(source,hash,record_id) VALUES (?,?,?) ON CONFLICT(source) DO UPDATE SET hash=excluded.hash, record_id=excluded.record_id",
      )
      .run(file, hash, record.id);
    imported++;
  }
  return {
    imported,
    skipped,
    message: `${imported} new snapshots · ${skipped} unchanged`,
  };
}

export function initializeWorkspace() {
  return transaction(initializeWorkspaceWithinTransaction);
}
function initializeWorkspaceWithinTransaction() {
  const row = db()
    .prepare("SELECT value FROM settings WHERE key = 'initialized'")
    .get();
  if (row) return;
  if (activeWorkspace().id !== "default") {
    db()
      .prepare(
        "INSERT OR IGNORE INTO settings(key,value) VALUES ('initialized','true')",
      )
      .run();
    return;
  }
  createRecord(
    {
      kind: "note",
      title: "A lab notebook for the long game",
      pinned: true,
      tags: ["start-here", "research-practice"],
      content: `## Welcome to Parallax\n\nA home for the questions, experiments, and small discoveries that become your paper.\n\n### Your research contract\n\n- Start small. Define a go/no-go check before committing compute.\n- Pilot budget: **$500 total**. Fellowship compute: **about $15,000 per month**.\n- Estimate GPU time and cost; get explicit approval before any paid job.\n- Record seeds, exact code commits, model and dataset revisions, configs, and commands.\n- Distinguish a hypothesis from an observation and a replicated result.\n- Keep models and datasets related to evaluator evasion private until explicitly cleared.\n- Never invent results or citations. Imported documents remain marked unverified.\n\n### Make the next session easier\n\n1. Create an **experiment** with a question and a decision gate.\n2. Attach configs, notebooks, data, and figures.\n3. Add **findings** linked to the experiment that supports them.\n4. Close the session with a **journal entry**: goal, work, results, decisions, and next steps.\n\nJournal text is immutable. A later correction belongs in a new, linked entry. Record edits retain a revision history.\n\nParallax records your research; it never launches compute.`,
    },
    "Workspace setup",
  );
  importRepository();
  createRecord(
    {
      kind: "task",
      title: "Define the first pilot’s go/no-go gate",
      status: "planned",
      priority: "high",
      tags: ["pilot", "setup"],
      content:
        "Write the smallest empirical check, success and stopping criteria, and what a negative result would change. Starter task based on your research brief; no experiment has been run by Parallax.",
    },
    "Workspace setup",
  );
  createRecord(
    {
      kind: "task",
      title: "Estimate pilot compute before booking a GPU",
      status: "draft",
      priority: "high",
      tags: ["compute", "pilot"],
      content:
        "Record GPU type, estimated hours, hourly price, and total cost. The pre-fellowship budget is about $500. Get Julien’s explicit approval before any paid job.",
    },
    "Workspace setup",
  );
  createRecord(
    {
      kind: "task",
      title: "Capture a reproducible baseline run",
      status: "draft",
      tags: ["reproducibility"],
      content:
        "After the pilot is approved, save the exact commit, config, random seeds, dataset revision, command, measured metrics and artifacts. This is a planned task, not a completed run.",
    },
    "Workspace setup",
  );
  db()
    .prepare(
      "INSERT OR IGNORE INTO settings(key,value) VALUES ('initialized','true')",
    )
    .run();
}
