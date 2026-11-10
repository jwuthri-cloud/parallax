import { NextRequest, NextResponse } from "next/server";
import { exportWorkspace } from "@/lib/store";
import { inWorkspace, errorResponse } from "@/lib/http";
export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  try {
    return await inWorkspace(request, async () => {
      return new NextResponse(JSON.stringify(exportWorkspace(), null, 2), {
        headers: {
          "Content-Type": "application/json",
          "Content-Disposition": 'attachment; filename="parallax-backup.json"',
          "Cache-Control": "no-store",
        },
      });
    });
  } catch (e) {
    return errorResponse(e);
  }
}
