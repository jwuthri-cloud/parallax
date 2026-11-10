import { NextRequest, NextResponse } from "next/server";
import { deleteRun, getRun, updateRun } from "@/lib/runs";
import { inWorkspace, errorResponse, jsonBody } from "@/lib/http";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: NextRequest, context: Context) {
  try {
    return await inWorkspace(request, async () => {
      const { id } = await context.params;
      return NextResponse.json(getRun(id));
    });
  } catch (e) {
    return errorResponse(e);
  }
}
export async function PATCH(request: NextRequest, context: Context) {
  try {
    return await inWorkspace(request, async () => {
      const { id } = await context.params;
      return NextResponse.json(updateRun(id, await jsonBody(request)));
    });
  } catch (e) {
    return errorResponse(e);
  }
}
export async function DELETE(request: NextRequest, context: Context) {
  try {
    return await inWorkspace(request, async () => {
      const { id } = await context.params;
      return NextResponse.json(deleteRun(id));
    });
  } catch (e) {
    return errorResponse(e);
  }
}
