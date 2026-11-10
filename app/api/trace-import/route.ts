import { NextRequest, NextResponse } from "next/server";
import { importTraceText } from "@/lib/traces";
import { inWorkspace, errorResponse } from "@/lib/http";
import { StoreError } from "@/lib/store";
export const runtime = "nodejs";
const maxBytes = 25 * 1024 * 1024; // the same cap as import_traces over MCP
/** A JSONL or JSON trace file as the request body (the format `import_traces` reads). */
export async function POST(request: NextRequest) {
  try {
    return await inWorkspace(request, async () => {
      const text = await request.text();
      if (Buffer.byteLength(text) > maxBytes)
        throw new StoreError("The file is larger than 25 MB", 413);
      return NextResponse.json(importTraceText(text, "Local script"), {
        status: 201,
      });
    });
  } catch (e) {
    return errorResponse(e);
  }
}
