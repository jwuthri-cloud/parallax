import { NextRequest, NextResponse } from "next/server";
import { traceFacets } from "@/lib/traces";
import { inWorkspace, errorResponse } from "@/lib/http";
export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  try {
    return await inWorkspace(request, async () =>
      NextResponse.json(traceFacets()),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
