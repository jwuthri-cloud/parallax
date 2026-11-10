import { NextRequest, NextResponse } from "next/server";
import { getWorkspace, saveSettings } from "@/lib/store";
import { initializeWorkspace } from "@/lib/importer";
import { inWorkspace, errorResponse, jsonBody } from "@/lib/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  try {
    return await inWorkspace(request, async () => {
      initializeWorkspace();
      return NextResponse.json(getWorkspace());
    });
  } catch (e) {
    return errorResponse(e);
  }
}
export async function PATCH(request: NextRequest) {
  try {
    return await inWorkspace(request, async () => {
      return NextResponse.json(saveSettings(await jsonBody(request)));
    });
  } catch (e) {
    return errorResponse(e);
  }
}
