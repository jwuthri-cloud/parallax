import { NextRequest, NextResponse } from "next/server";
import { deleteEvaluator, updateEvaluator } from "@/lib/judge/store";
import { inWorkspace, errorResponse, jsonBody } from "@/lib/http";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function PATCH(request: NextRequest, context: Context) {
  try {
    return await inWorkspace(request, async () => {
      const { id } = await context.params;
      return NextResponse.json(
        await updateEvaluator(id, await jsonBody(request)),
      );
    });
  } catch (e) {
    return errorResponse(e);
  }
}
/** Removes the column and its scores. */
export async function DELETE(request: NextRequest, context: Context) {
  try {
    return await inWorkspace(request, async () => {
      const { id } = await context.params;
      return NextResponse.json(deleteEvaluator(id));
    });
  } catch (e) {
    return errorResponse(e);
  }
}
