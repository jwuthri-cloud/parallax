import { NextRequest, NextResponse } from "next/server";
import { createEvaluator, listEvaluators } from "@/lib/judge/store";
import { inWorkspace, errorResponse, jsonBody } from "@/lib/http";
export const runtime = "nodejs";
/** Judge columns of the traces table. Creating one runs nothing. */
export async function GET(request: NextRequest) {
  try {
    return await inWorkspace(request, async () =>
      NextResponse.json(listEvaluators()),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
export async function POST(request: NextRequest) {
  try {
    return await inWorkspace(request, async () =>
      NextResponse.json(await createEvaluator(await jsonBody(request)), {
        status: 201,
      }),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
