// Only local, workspace-scoped artifact URLs may load media inside documents.
// Remote URLs, protocol-relative URLs, data URLs, and arbitrary app routes stay inert.
export function isLocalArtifactUrl(url: unknown): url is string {
  return (
    typeof url === "string" &&
    /^\/api\/artifacts\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\?workspaceId=(?:default|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(
      url,
    )
  );
}
