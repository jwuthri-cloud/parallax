"use client";
import { useState, type ReactNode } from "react";
import { isLocalArtifactUrl } from "@/lib/document-media";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";

function CodeBlock({ children, text }: { children: ReactNode; text: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  return (
    <div className="document-code">
      <button
        type="button"
        aria-label="Copy code"
        title={error ? "Clipboard unavailable" : "Copy code"}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          } catch {
            setError(true);
          }
        }}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
        {copied ? "Copied" : error ? "Select to copy" : "Copy"}
      </button>
      <pre>{children}</pre>
    </div>
  );
}
export function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, href }) => (
            <a
              href={href}
              target={href?.startsWith("#") ? undefined : "_blank"}
              rel="noopener noreferrer"
            >
              {children}
            </a>
          ),
          img: ({ alt, src, title }) =>
            isLocalArtifactUrl(src) ? (
              <img
                className="document-local-image"
                src={src}
                alt={alt || "Local research figure"}
                title={title}
                loading="lazy"
              />
            ) : (
              <span className="external-image-note">
                [Image: {alt || "attach this image locally to preview"}]
              </span>
            ),
          pre: ({ children, node }) => {
            const text =
              node?.children
                .flatMap((child) =>
                  child.type === "element"
                    ? child.children.flatMap((n) =>
                        n.type === "text" ? n.value : [],
                      )
                    : child.type === "text"
                      ? child.value
                      : [],
                )
                .join("") || "";
            return <CodeBlock text={text}>{children}</CodeBlock>;
          },
          table: ({ children }) => (
            <div className="document-table">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
