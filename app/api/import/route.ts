import { NextRequest, NextResponse } from "next/server";
import { importRepository } from "@/lib/importer";
import { inWorkspace, errorResponse } from "@/lib/http";
export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  try {
    return await inWorkspace(request, async () => {
      return NextResponse.json(importRepository());
    });
  } catch (e) {
    return errorResponse(e);
  }
}
