"use client";
import { createContext, useContext, useMemo } from "react";
import {
  BookOpen,
  FlaskConical,
  Lightbulb,
  FileText,
  Library,
  CheckSquare,
  ScrollText,
  ArrowUpRight,
  LockKeyhole,
  X,
} from "lucide-react";
import type { ResearchRecord } from "@/lib/schema";
export const kindMeta = {
  note: { label: "Note", icon: FileText, color: "blue" },
  journal: { label: "Journal", icon: BookOpen, color: "orange" },
  experiment: { label: "Experiment", icon: FlaskConical, color: "lime" },
  finding: { label: "Finding", icon: Lightbulb, color: "pink" },
  reference: { label: "Reference", icon: Library, color: "purple" },
  task: { label: "Task", icon: CheckSquare, color: "lime" },
  paper: { label: "Manuscript", icon: ScrollText, color: "blue" },
};
export function dateLabel(value: string, full = false) {
  return new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(full ? { year: "numeric" as const } : {}),
  });
}
export function timeAgo(value: string) {
  const m = Math.max(
    0,
    Math.floor((Date.now() - new Date(value).getTime()) / 60000),
  );
  return m < 1
    ? "just now"
    : m < 60
      ? `${m}m ago`
      : m < 1440
        ? `${Math.floor(m / 60)}h ago`
        : dateLabel(value);
}
export function excerpt(value: string, length = 140) {
  return value
    .replace(/```[\s\S]*?```/g, "")
    .replace(/[#*`>|]/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, length);
}
export function Money({ value }: { value: number }) {
  return (
    <>
      {new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: value % 1 ? 2 : 0,
      }).format(value)}
    </>
  );
}
export function KindBadge({ kind }: { kind: ResearchRecord["kind"] }) {
  const meta = kindMeta[kind];
  const Icon = meta.icon;
  return (
    <span className={`kind-badge ${meta.color}`}>
      <Icon size={12} />
      {meta.label}
    </span>
  );
}
export function RecordCard({
  record,
  onOpen,
}: {
  record: ResearchRecord;
  onOpen: (r: ResearchRecord) => void;
}) {
  return (
    <button className="record-card" onClick={() => onOpen(record)}>
      <div className="card-top">
        <KindBadge kind={record.kind} />
        <ArrowUpRight size={16} />
      </div>
      <h3>{record.title}</h3>
      <p>{excerpt(record.content)}</p>
      <div className="card-bottom">
        <span className="tag">{record.tags[0] || record.status}</span>
        <span>{dateLabel(record.updatedAt)}</span>
      </div>
    </button>
  );
}
export function EmptyState({
  icon: Icon = FileText,
  title,
  description,
  action,
  onAction,
}: {
  icon?: typeof FileText;
  title: string;
  description: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <Icon size={25} strokeWidth={1.3} />
      </div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action && (
        <button className="button secondary" onClick={onAction}>
          {action}
          <ArrowUpRight size={15} />
        </button>
      )}
    </div>
  );
}
export function PrivacyBadge() {
  return (
    <span className="privacy">
      <LockKeyhole size={11} /> PRIVATE BY DEFAULT
    </span>
  );
}
export function Modal({
  children,
  onClose,
  wide = false,
  full = false,
  title,
}: {
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
  full?: boolean;
  title: string;
}) {
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        className={`modal ${wide ? "wide" : ""} ${full ? "full" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
          if (e.key === "Tab") {
            const elements = [
              ...e.currentTarget.querySelectorAll<HTMLElement>(
                'button:not(:disabled), input, select, textarea, a[href], [tabindex="0"], [contenteditable="true"]',
              ),
            ].filter((n) => n.offsetParent !== null);
            const first = elements[0],
              last = elements.at(-1);
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault();
              last?.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <button
          autoFocus
          className="icon-button close-modal"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <X size={20} />
        </button>
        {children}
      </section>
    </div>
  );
}
export async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Request failed");
  return result;
}

export const WorkspaceContext = createContext("default");
export function useWorkspaceApi() {
  const id = useContext(WorkspaceContext);
  return useMemo(() => {
    const url = (value: string) => {
      const [pathname, query = ""] = value.split("?");
      const params = new URLSearchParams(query);
      params.set("workspaceId", id);
      return `${pathname}?${params}`;
    };
    return {
      id,
      url,
      api: <T,>(value: string, options?: RequestInit) =>
        api<T>(url(value), options),
    };
  }, [id]);
}
export function jsonOptions(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
