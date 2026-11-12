import { NextRequest, NextResponse } from "next/server";
import { evaluatorCost } from "@/lib/judge/store";
import { inWorkspace, errorResponse } from "@/lib/http";
export const runtime = "nodejs";
/** Token use and provider-reported cost of each judge column over the last `days`. */
export async function GET(request: NextRequest) {
  try {
    return await inWorkspace(request, async () =>
      NextResponse.json(
        evaluatorCost(request.nextUrl.searchParams.get("days") ?? 30),
      ),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
