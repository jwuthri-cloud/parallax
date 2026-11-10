import { NextRequest, NextResponse } from "next/server";
import {
  deleteRecord,
  getRecord,
  getRevisions,
  togglePin,
  updateRecord,
} from "@/lib/store";
import { inWorkspace, errorResponse, jsonBody } from "@/lib/http";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: NextRequest, context: Context) {
  try {
    return await inWorkspace(request, async () => {
      const { id } = await context.params;
      return NextResponse.json(
        request.nextUrl.searchParams.has("history")
          ? getRevisions(id)
          : getRecord(id),
      );
    });
  } catch (e) {
    return errorResponse(e);
  }
}
export async function PATCH(request: NextRequest, context: Context) {
  try {
    return await inWorkspace(request, async () => {
      const { id } = await context.params;
      const body = await jsonBody(request);
      return NextResponse.json(
        body.action === "pin"
          ? togglePin(id, body.revision)
          : updateRecord(id, body, body.revision),
      );
    });
  } catch (e) {
    return errorResponse(e);
  }
}
export async function DELETE(request: NextRequest, context: Context) {
  try {
    return await inWorkspace(request, async () => {
      const { id } = await context.params;
      const body = await jsonBody(request);
      return NextResponse.json(deleteRecord(id, body.revision));
    });
  } catch (e) {
    return errorResponse(e);
  }
}
