import { htmlPreviewPolicy } from "@/lib/preview";
import { withArtifactKit } from "@/lib/artifact-kit";
import { NextRequest, NextResponse } from "next/server";
import { getArtifact, updateArtifactLinks } from "@/lib/store";
import { inWorkspace, errorResponse, jsonBody } from "@/lib/http";
export const runtime = "nodejs";
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    return await inWorkspace(request, async () => {
      const { artifact, buffer } = getArtifact((await context.params).id);
      if (
        request.nextUrl.searchParams.has("preview") &&
        ["text/html", "image/svg+xml"].includes(artifact.mime)
      ) {
        const body =
          artifact.mime === "text/html"
            ? withArtifactKit(
                buffer.toString("utf8"),
                request.nextUrl.searchParams.get("theme"),
              )
            : buffer;
        return new NextResponse(body, {
          headers: {
            "Content-Type": artifact.mime + "; charset=utf-8",
            "Content-Security-Policy": htmlPreviewPolicy,
            "X-Frame-Options": "SAMEORIGIN",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
            "Cache-Control": "no-store",
          },
        });
      }
      if (request.nextUrl.searchParams.has("text")) {
        const text = buffer.toString("utf8");
        const limit = artifact.name.endsWith(".ipynb") ? text.length : 500000;
        return NextResponse.json({
          text: text.slice(0, limit),
          truncated: text.length > limit,
        });
      }
      const inline =
        /^image\/(png|jpeg|webp|gif)$/.test(artifact.mime) &&
        !request.nextUrl.searchParams.has("download");
      return new NextResponse(new Uint8Array(buffer), {
        headers: {
          "Content-Type": artifact.mime,
          "Content-Length": String(buffer.length),
          "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(artifact.name)}`,
          "Content-Security-Policy":
            "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-store",
        },
      });
    });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    return await inWorkspace(request, async () => {
      const body = await jsonBody(request);
      return NextResponse.json(
        updateArtifactLinks(
          (await context.params).id,
          body.recordIds,
          body.revision,
        ),
      );
    });
  } catch (error) {
    return errorResponse(error);
  }
}
