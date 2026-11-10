import { NextRequest, NextResponse } from "next/server";
import { ingestTrace, listTraces } from "@/lib/traces";
import { inWorkspace, errorResponse, jsonBody, queryParams } from "@/lib/http";
export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  try {
    return await inWorkspace(request, async () =>
      NextResponse.json(listTraces(queryParams(request))),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
export async function POST(request: NextRequest) {
  try {
    return await inWorkspace(request, async () =>
      NextResponse.json(
        ingestTrace(await jsonBody(request, 10 * 1024 * 1024), "Local script"),
        { status: 201 },
      ),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
