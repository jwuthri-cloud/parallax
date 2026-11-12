import { NextRequest, NextResponse } from "next/server";
import { scoreCalls } from "@/lib/judge/store";
import { inWorkspace, errorResponse } from "@/lib/http";
export const runtime = "nodejs";
// A judge prompt is a few KB. One that pasted a 2 MB tool result is not something a popover
// can show.
const promptChars = 20_000;
const clip = (text: string) =>
  text.length <= promptChars
    ? text
    : `${text.slice(0, promptChars)}\n… (truncated)`;
/** The model calls behind one score cell: the judge's prompt and what came back. `subject` is
 *  the trace id for a message or step score and the thread id for a conversation score. */
export async function GET(request: NextRequest) {
  try {
    return await inWorkspace(request, async () => {
      const q = request.nextUrl.searchParams;
      const calls = scoreCalls({
        subject: q.get("subject") ?? "",
        level: q.get("level") ?? "",
        name: q.get("name") ?? "",
        spanId: q.get("span_id") ?? "",
      });
      return NextResponse.json({
        steps: calls.map((c) => ({
          ...c,
          input: clip(c.input),
          output: clip(c.output),
        })),
      });
    });
  } catch (e) {
    return errorResponse(e);
  }
}
