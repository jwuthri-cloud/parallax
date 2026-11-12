import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { generateEvaluatorConfig } from "@/lib/judge/generation";
import { llmEnabled } from "@/lib/judge/provider";
import { StoreError } from "@/lib/store";
import { errorResponse, guard, jsonBody } from "@/lib/http";
export const runtime = "nodejs";
const bodySchema = z.object({
  description: z.string().trim().min(3).max(2000),
});
/** A description in plain words → a draft column config. One paid model call; nothing is saved. */
export async function POST(request: NextRequest) {
  try {
    guard(request);
    const { description } = bodySchema.parse(await jsonBody(request));
    if (!llmEnabled())
      throw new StoreError(
        "AI generation needs an OpenRouter key. Add one on the Evaluators page.",
        503,
      );
    try {
      return NextResponse.json(await generateEvaluatorConfig(description));
    } catch (error) {
      throw new StoreError(
        `generation failed: ${(error as Error).message}`,
        502,
      );
    }
  } catch (e) {
    return errorResponse(e);
  }
}
