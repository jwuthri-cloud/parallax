import { NextRequest, NextResponse } from "next/server";
import { applyRunEvents, listRuns } from "@/lib/runs";
import { inWorkspace, errorResponse, jsonBody, queryParams } from "@/lib/http";
export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  try {
    return await inWorkspace(request, async () =>
      NextResponse.json(listRuns(queryParams(request))),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
/** Telemetry ingest: {"events": [...]}, as sent by clients/python/parallax_track.py. */
export async function POST(request: NextRequest) {
  try {
    return await inWorkspace(request, async () => {
      const body = await jsonBody(request, 10 * 1024 * 1024);
      return NextResponse.json(applyRunEvents(body.events, "Run client"), {
        status: 201,
      });
    });
  } catch (e) {
    return errorResponse(e);
  }
}
