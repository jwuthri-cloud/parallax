import { unified } from "unified";
import remarkParse from "remark-parse";
import { isLocalArtifactUrl } from "./document-media";

const parser = unified().use(remarkParse);
/** Find actual Markdown image/link destinations, excluding code and prose examples. */
export function documentArtifactReferences(source: string) {
  const tree = parser.parse(source);
  const definitions = new Map<string, string>();
  for (const node of tree.children)
    if (node.type === "definition") definitions.set(node.identifier, node.url);
  const urls = new Set<string>();
  function visit(node: {
    type: string;
    url?: string;
    identifier?: string;
    children?: unknown[];
  }) {
    const url =
      node.type === "image" || node.type === "link"
        ? node.url
        : node.type === "imageReference" || node.type === "linkReference"
          ? definitions.get(node.identifier || "")
          : undefined;
    if (isLocalArtifactUrl(url)) urls.add(url);
    node.children?.forEach((child) => visit(child as typeof node));
  }
  visit(tree);
  return [...urls].map((url) => {
    const parsed = new URL(url, "http://localhost");
    return {
      id: parsed.pathname.split("/").at(-1)!,
      workspaceId: parsed.searchParams.get("workspaceId")!,
    };
  });
}
