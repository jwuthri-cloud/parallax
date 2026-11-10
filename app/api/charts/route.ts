import { NextRequest, NextResponse } from "next/server";
import { listChartLinks, linkChart, unlinkChart } from "@/lib/store";
import { inWorkspace, errorResponse, jsonBody } from "@/lib/http";
export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  try {
    return inWorkspace(request, () => NextResponse.json(listChartLinks()));
  } catch (error) {
    return errorResponse(error);
  }
}
export async function POST(request: NextRequest) {
  try {
    return await inWorkspace(request, async () =>
      NextResponse.json(linkChart(await jsonBody(request))),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
export async function DELETE(request: NextRequest) {
  try {
    return await inWorkspace(request, async () =>
      NextResponse.json(unlinkChart((await jsonBody(request)).id)),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
