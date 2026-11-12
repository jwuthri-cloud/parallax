import { NextRequest, NextResponse } from "next/server";
import {
  defaultColumnModelId,
  defaultModelId,
  listModels,
} from "@/lib/judge/provider";
import { errorResponse, guard } from "@/lib/http";
export const runtime = "nodejs";
/** The model choices of the column editor. `default` is what a new column starts on (the
 *  decision model when a key makes it reachable); `text_default` is what an LLM column with no
 *  model runs on. Without an OpenRouter key this is a static list and no call is made. */
export async function GET(request: NextRequest) {
  try {
    guard(request);
    return NextResponse.json({
      default: defaultColumnModelId(),
      text_default: defaultModelId(),
      models: await listModels(),
    });
  } catch (e) {
    return errorResponse(e);
  }
}
