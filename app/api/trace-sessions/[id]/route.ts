import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/traces";
import { inWorkspace, errorResponse } from "@/lib/http";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: NextRequest, context: Context) {
  try {
    return await inWorkspace(request, async () => {
      const { id } = await context.params;
      return NextResponse.json(getSession(id));
    });
  } catch (e) {
    return errorResponse(e);
  }
}
