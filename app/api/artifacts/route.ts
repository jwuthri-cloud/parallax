import { NextRequest, NextResponse } from "next/server";
import {
  addArtifact,
  listArtifacts,
  maxFileSize,
  StoreError,
} from "@/lib/store";
import { inWorkspace, errorResponse } from "@/lib/http";
export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  try {
    return await inWorkspace(request, async () => {
      return NextResponse.json(listArtifacts());
    });
  } catch (e) {
    return errorResponse(e);
  }
}
export async function POST(request: NextRequest) {
  try {
    return await inWorkspace(request, async () => {
      if (
        Number(request.headers.get("content-length") || 0) >
        maxFileSize + 100000
      )
        throw new StoreError("Upload exceeds 25 MB", 413);
      const data = await request.formData();
      const file = data.get("file");
      if (!(file instanceof File)) throw new StoreError("Select a file");
      if (file.size > maxFileSize)
        throw new StoreError("Upload exceeds 25 MB", 413);
      return NextResponse.json(
        addArtifact(Buffer.from(await file.arrayBuffer()), file.name, {
          recordId: String(data.get("recordId") || ""),
          caption: String(data.get("caption") || ""),
        }),
        { status: 201 },
      );
    });
  } catch (e) {
    return errorResponse(e);
  }
}
