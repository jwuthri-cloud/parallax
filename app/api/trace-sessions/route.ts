import { NextRequest, NextResponse } from "next/server";
import { listSessions } from "@/lib/traces";
import { withSessionScores } from "@/lib/judge/store";
import { inWorkspace, errorResponse, queryParams } from "@/lib/http";
export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  try {
    return await inWorkspace(request, async () =>
      NextResponse.json(withSessionScores(listSessions(queryParams(request)))),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
