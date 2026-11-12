import { NextRequest, NextResponse } from "next/server";
import { listTemplates } from "@/lib/judge/store";
import { inWorkspace, errorResponse } from "@/lib/http";
export const runtime = "nodejs";
/** The template library, with a flag on the templates this workspace already has. */
export async function GET(request: NextRequest) {
  try {
    return await inWorkspace(request, async () =>
      NextResponse.json(listTemplates()),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
