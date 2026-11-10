import { NextRequest, NextResponse } from "next/server";
import { getFieldDefinitions, saveFieldDefinitions } from "@/lib/store";
import { inWorkspace, errorResponse, jsonBody } from "@/lib/http";
export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  try {
    return inWorkspace(request, () => NextResponse.json(getFieldDefinitions()));
  } catch (error) {
    return errorResponse(error);
  }
}
export async function PUT(request: NextRequest) {
  try {
    return await inWorkspace(request, async () =>
      NextResponse.json(saveFieldDefinitions(await jsonBody(request))),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
