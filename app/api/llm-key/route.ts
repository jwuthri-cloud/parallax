import { NextRequest, NextResponse } from "next/server";
import { clearKey, keyStatus, saveKey } from "@/lib/judge/provider";
import { errorResponse, guard, jsonBody } from "@/lib/http";
export const runtime = "nodejs";
/** The OpenRouter key every judge call runs on: one key for this Parallax, kept in a private
 *  file in the data folder. The value is write-only; reads say only if one is configured. */
export async function GET(request: NextRequest) {
  try {
    guard(request);
    return NextResponse.json(keyStatus());
  } catch (e) {
    return errorResponse(e);
  }
}
export async function PUT(request: NextRequest) {
  try {
    guard(request);
    const body = await jsonBody(request, 4096);
    return NextResponse.json(saveKey(body?.api_key));
  } catch (e) {
    return errorResponse(e);
  }
}
export async function DELETE(request: NextRequest) {
  try {
    guard(request);
    return NextResponse.json(clearKey());
  } catch (e) {
    return errorResponse(e);
  }
}
