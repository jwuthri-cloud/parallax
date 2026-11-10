import { NextRequest, NextResponse } from "next/server";
import { linkRecords, listRelations } from "@/lib/store";
import { inWorkspace, errorResponse, jsonBody } from "@/lib/http";
export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  try {
    return await inWorkspace(request, async () => {
      return NextResponse.json(listRelations());
    });
  } catch (e) {
    return errorResponse(e);
  }
}
export async function POST(request: NextRequest) {
  try {
    return await inWorkspace(request, async () => {
      return NextResponse.json(linkRecords(await jsonBody(request)));
    });
  } catch (e) {
    return errorResponse(e);
  }
}
