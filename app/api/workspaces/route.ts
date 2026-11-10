import { NextRequest, NextResponse } from "next/server";
import { listWorkspaces, createWorkspace } from "@/lib/workspaces";
import { guard, errorResponse, jsonBody } from "@/lib/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  try {
    guard(request);
    return NextResponse.json(listWorkspaces());
  } catch (error) {
    return errorResponse(error);
  }
}
export async function POST(request: NextRequest) {
  try {
    guard(request);
    return NextResponse.json(createWorkspace(await jsonBody(request)), {
      status: 201,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
