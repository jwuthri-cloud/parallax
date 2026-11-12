import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { readThreadSpans } from "@/lib/judge/store";
import {
  buildContext,
  extractTemplateVariables,
  resolveTemplate,
} from "@/lib/judge/template";
import { LEVELS } from "@/lib/judge/types";
import { inWorkspace, errorResponse, jsonBody } from "@/lib/http";
export const runtime = "nodejs";
const bodySchema = z.object({
  prompt: z.string().max(20000).default(""),
  level: z.enum(LEVELS).catch("AGENT_RUN"),
  thread_id: z.string().default(""),
  trace_id: z.string().default(""),
  span_id: z.string().default(""),
});
/** Preview of an advanced `@VARIABLE` prompt against one real conversation, turn or step: the
 *  same context builder and resolver as a run, without the model call. */
export async function POST(request: NextRequest) {
  try {
    return await inWorkspace(request, async () => {
      const body = bodySchema.parse(await jsonBody(request));
      const threadId = body.thread_id || body.trace_id;
      const resolved = resolveTemplate(
        body.prompt,
        buildContext(body.level, {
          threadSpans: threadId ? readThreadSpans(threadId) : [],
          currentTraceId: body.trace_id || threadId,
          currentSpanId: body.span_id || null,
          wantedVars: extractTemplateVariables(body.prompt),
        }),
      );
      return NextResponse.json({
        resolved_prompt: resolved.resolvedText,
        variables_used: resolved.variablesUsed,
        variables_missing: resolved.variablesMissing,
        level: body.level,
      });
    });
  } catch (e) {
    return errorResponse(e);
  }
}
