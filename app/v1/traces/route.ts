import { NextRequest, NextResponse } from "next/server";
import { ingestOtlp } from "@/lib/traces";
import { StoreError } from "@/lib/store";
import { runInWorkspace } from "@/lib/workspaces";
import { guard, errorResponse, jsonBody } from "@/lib/http";
export const runtime = "nodejs";

/** OTLP/HTTP trace export, JSON encoding. Point an exporter at
 *  http://127.0.0.1:3000/v1/traces?workspaceId=<id> with OTEL_EXPORTER_OTLP_PROTOCOL=http/json. */
export async function POST(request: NextRequest) {
  try {
    guard(request);
    if (!request.headers.get("content-type")?.startsWith("application/json"))
      throw new StoreError(
        "Parallax accepts OTLP as JSON only. Set OTEL_EXPORTER_OTLP_PROTOCOL=http/json.",
        415,
      );
    const workspace =
      request.nextUrl.searchParams.get("workspaceId") ||
      request.headers.get("x-parallax-workspace") ||
      undefined;
    if (request.headers.get("content-length") !== "0") {
      const body = await jsonBody(request, 10 * 1024 * 1024);
      runInWorkspace(workspace, () => ingestOtlp(body));
    }
    return NextResponse.json({});
  } catch (e) {
    return errorResponse(e);
  }
}
