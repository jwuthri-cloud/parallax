import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { StoreError } from "./store";
import { runInWorkspace } from "./workspaces";

export function inWorkspace<T>(request: NextRequest, fn: () => T): T {
  guard(request);
  return runInWorkspace(
    request.nextUrl.searchParams.get("workspaceId") || undefined,
    fn,
  );
}

// Local-only by default. A deployment that puts its own login in front of the app
// (Cloudflare Access, basic auth) opts in to its public hostnames with
// PARALLAX_ALLOWED_HOSTS=parallax.example.com[,other.example.com].
function extraHosts() {
  return (process.env.PARALLAX_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

export function guard(request: NextRequest) {
  const extra = extraHosts();
  const allowed = new Set(["localhost", "127.0.0.1", ...extra]);
  // nextUrl's hostname is the address `next start` listens on, not the request's:
  // a deployment behind a proxy has to listen on every interface.
  const bound = request.nextUrl.hostname;
  const boundOk =
    allowed.has(bound) ||
    (extra.length > 0 && ["0.0.0.0", "[::]"].includes(bound));
  const hostHeader = request.headers.get("host");
  const host = hostHeader?.split(":")[0].toLowerCase();
  if (!boundOk || !host || !allowed.has(host))
    throw new StoreError("Parallax is local-only", 403);
  const origin = request.headers.get("origin");
  // Behind a TLS-terminating proxy the server sees http while the browser sends https.
  if (
    origin &&
    origin !== request.nextUrl.origin &&
    origin !== `http://${hostHeader}` &&
    origin !== `https://${hostHeader}`
  )
    throw new StoreError("Cross-origin requests are not allowed", 403);
  if (request.headers.get("sec-fetch-site") === "cross-site")
    throw new StoreError("Cross-site requests are not allowed", 403);
}
export function errorResponse(error: unknown) {
  if (error instanceof ZodError)
    return NextResponse.json(
      {
        error: error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      },
      { status: 400 },
    );
  if (error instanceof StoreError)
    return NextResponse.json(
      { error: error.message },
      { status: error.status },
    );
  if (error instanceof SyntaxError)
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  console.error(error);
  return NextResponse.json(
    { error: "Could not complete this operation. Check the local server log." },
    { status: 500 },
  );
}
export async function jsonBody(
  request: NextRequest,
  maxBytes = 2 * 1024 * 1024,
) {
  const raw = await request.text();
  if (Buffer.byteLength(raw) > maxBytes)
    throw new StoreError("Request is too large", 413);
  return JSON.parse(raw);
}
/** URL search parameters as a plain object, without the workspace and empty values. */
export function queryParams(request: NextRequest) {
  return Object.fromEntries(
    [...request.nextUrl.searchParams].filter(
      ([key, value]) => key !== "workspaceId" && value !== "",
    ),
  );
}
