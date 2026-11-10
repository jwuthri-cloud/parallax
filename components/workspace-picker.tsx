"use client";
import { useEffect, useState } from "react";
import { Check, Plus, ArrowRight, FolderOpen, Layers3 } from "lucide-react";
import type { WorkspaceInfo } from "@/lib/schema";
import { api, jsonOptions, Modal } from "./ui";

export function WorkspacePicker({
  activeId,
  onSelect,
  onClose,
}: {
  activeId: string;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [researchRoot, setResearchRoot] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<WorkspaceInfo[]>("/api/workspaces")
      .then(setWorkspaces)
      .catch((e) => setError(e.message));
  }, []);
  return (
    <Modal title="Your workspaces" onClose={onClose}>
      <div className="workspace-picker">
        <span className="eyebrow">
          <Layers3 size={13} /> RESEARCH CONSTELLATIONS
        </span>
        <h2>{creating ? "Room for a new question." : "Your workspaces."}</h2>
        <p className="muted">
          A separate home for every research direction. Notes, figures, memories
          and budgets stay together.
        </p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {creating ? (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              try {
                const created = await api<WorkspaceInfo>(
                  "/api/workspaces",
                  jsonOptions("POST", { name, description, researchRoot }),
                );
                onSelect(created.id);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              Workspace name
              <input
                required
                maxLength={80}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="A new research direction"
                autoFocus
              />
            </label>
            <label>
              Focus <span className="muted">optional</span>
              <input
                maxLength={400}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What are you trying to understand?"
              />
            </label>
            <label>
              Research folder <span className="muted">optional</span>
              <input
                value={researchRoot}
                onChange={(e) => setResearchRoot(e.target.value)}
                placeholder="/Users/julien/Documents/Repos/…"
              />
            </label>
            <p className="form-hint">
              Starts empty. If you connect a folder, import its documentation
              later in Settings. No code is executed.
            </p>
            <div className="workspace-form-actions">
              <button
                type="button"
                className="button secondary"
                onClick={() => setCreating(false)}
              >
                Back
              </button>
              <button disabled={busy} className="button primary">
                {busy ? "Creating…" : "Create workspace"}
                <ArrowRight size={15} />
              </button>
            </div>
          </form>
        ) : (
          <>
            <div className="workspace-options">
              {workspaces.map((w, i) => (
                <button
                  className={w.id === activeId ? "selected" : ""}
                  key={w.id}
                  onClick={() => onSelect(w.id)}
                >
                  <span className="workspace-number">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span>
                    <strong>{w.name}</strong>
                    <small>
                      {w.description || "Private research workspace"}
                    </small>
                    {w.researchRoot && (
                      <small className="workspace-folder">
                        <FolderOpen size={11} />
                        {w.researchRoot.split("/").at(-1)}
                      </small>
                    )}
                  </span>
                  {w.id === activeId ? (
                    <Check size={16} />
                  ) : (
                    <ArrowRight size={16} />
                  )}
                </button>
              ))}
            </div>
            <button
              className="button primary workspace-create"
              onClick={() => setCreating(true)}
            >
              <Plus size={16} />
              New workspace
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
