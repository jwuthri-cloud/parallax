import { NextRequest, NextResponse } from "next/server";
import { createRecord, listRecords } from "@/lib/store";
import { inWorkspace, errorResponse, jsonBody } from "@/lib/http";
export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  try {
    return await inWorkspace(request, async () => {
      return NextResponse.json(
        listRecords(
          request.nextUrl.searchParams.get("q") || "",
          request.nextUrl.searchParams.get("kind") || "",
        ),
      );
    });
  } catch (e) {
    return errorResponse(e);
  }
}
export async function POST(request: NextRequest) {
  try {
    return await inWorkspace(request, async () => {
      return NextResponse.json(createRecord(await jsonBody(request)), {
        status: 201,
      });
    });
  } catch (e) {
    return errorResponse(e);
  }
}
