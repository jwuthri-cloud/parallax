import { NextRequest, NextResponse } from "next/server";
import { loadDemoRuns, removeDemoRuns } from "@/lib/runs";
import { inWorkspace, errorResponse } from "@/lib/http";
export const runtime = "nodejs";
/** Load the synthetic demo runs from seeds/demo-runs.jsonl (replacing earlier demo runs). */
export async function POST(request: NextRequest) {
  try {
    return await inWorkspace(request, async () =>
      NextResponse.json(loadDemoRuns(), { status: 201 }),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
export async function DELETE(request: NextRequest) {
  try {
    return await inWorkspace(request, async () =>
      NextResponse.json(removeDemoRuns()),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
