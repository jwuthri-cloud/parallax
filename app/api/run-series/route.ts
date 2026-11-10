import { NextRequest, NextResponse } from "next/server";
import { runSeries } from "@/lib/runs";
import { inWorkspace, errorResponse } from "@/lib/http";
export const runtime = "nodejs";
/** ?runs=a,b&name=loss/train&name=loss/val&maxPoints=1000 (no name: every metric). */
export async function GET(request: NextRequest) {
  try {
    return await inWorkspace(request, async () => {
      const p = request.nextUrl.searchParams;
      const names = p.getAll("name");
      return NextResponse.json(
        runSeries({
          runs: (p.get("runs") ?? "").split(",").filter(Boolean),
          names: names.length ? names : undefined,
          maxPoints: p.get("maxPoints") ?? undefined,
        }),
      );
    });
  } catch (e) {
    return errorResponse(e);
  }
}
