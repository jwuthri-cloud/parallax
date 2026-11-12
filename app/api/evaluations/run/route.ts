import { NextRequest } from "next/server";
import { z } from "zod";
import { llmEnabled } from "@/lib/judge/provider";
import { MAX_TARGETS, runEvaluators } from "@/lib/judge/service";
import { enabledSpecs } from "@/lib/judge/store";
import { StoreError } from "@/lib/store";
import { activeWorkspace, runInWorkspace } from "@/lib/workspaces";
import { inWorkspace, errorResponse, jsonBody } from "@/lib/http";
export const runtime = "nodejs";
const ids = z.array(z.string().max(300)).max(MAX_TARGETS).default([]);
const bodySchema = z.object({
  evaluator_ids: ids, // empty → every enabled evaluator
  thread_ids: ids, // conversation rows: every turn, then the conversation columns
  trace_ids: ids, // turn rows: the trace and its steps
});
/** A judge run the user started, streamed as server-sent events. Each score is stored and sent
 *  as it is made, so it lands in its table cell. Frames (`data: <json>`, then `data: [DONE]`):
 *    {"type":"start","targets":N,"evaluators":M}
 *    {"type":"result","score":{…}}
 *    {"type":"target_done","target":"<id>","scores":n} | {"type":"target_error","target":"<id>","detail":"…"}
 *    {"type":"done"}
 *  This spends money on the configured OpenRouter key. A client that disconnects stops the
 *  stream; the targets in flight finish and keep their scores. */
export async function POST(request: NextRequest) {
  try {
    return await inWorkspace(request, async () => {
      const body = bodySchema.parse(await jsonBody(request));
      if (!body.thread_ids.length && !body.trace_ids.length)
        throw new StoreError("no targets: pass thread_ids and/or trace_ids");
      if (!enabledSpecs(body.evaluator_ids).length)
        throw new StoreError("no enabled evaluators match the request");
      if (!llmEnabled())
        throw new StoreError(
          "No OpenRouter API key. Add one on the Evaluators page to run LLM judges.",
          503,
        );
      const workspaceId = activeWorkspace().id;
      const encoder = new TextEncoder();
      let open = true;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (frame: string) => {
            if (!open) return;
            try {
              controller.enqueue(encoder.encode(`data: ${frame}\n\n`));
            } catch {
              open = false; // the client went away
            }
          };
          void runInWorkspace(workspaceId, () =>
            runEvaluators(body, (event) => send(JSON.stringify(event))),
          )
            .catch((error: Error) =>
              send(JSON.stringify({ type: "error", detail: error.message })),
            )
            .finally(() => {
              send(JSON.stringify({ type: "done" }));
              send("[DONE]");
              if (open) controller.close();
              open = false;
            });
        },
        cancel() {
          open = false;
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
        },
      });
    });
  } catch (e) {
    return errorResponse(e);
  }
}
