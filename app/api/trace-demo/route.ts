import { NextRequest, NextResponse } from "next/server";
import { loadDemoTraces } from "@/lib/traces";
import { errorResponse, guard } from "@/lib/http";
export const runtime = "nodejs";
/** Fills the temporary demo workspace with synthetic traces; never touches a real workspace. */
export async function POST(request: NextRequest) {
  try {
    guard(request);
    return NextResponse.json(loadDemoTraces());
  } catch (e) {
    return errorResponse(e);
  }
}
