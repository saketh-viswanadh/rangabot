import { NextResponse } from "next/server";
import { buildModelViews, readInstalledModels, readModelPreference, updateSelectedChatModel } from "@/lib/model-manager";

export const runtime = "nodejs";

export async function GET() {
  try {
    const preference = readModelPreference();
    const installed = await readInstalledModels();
    return NextResponse.json({ runtime: "managed-local", preference, models: buildModelViews(installed, preference) });
  } catch {
    return NextResponse.json({ error: "The local model manager is unavailable." }, { status: 503 });
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    if (Object.keys(body).sort().join(",") !== "expectedRevision,modelId") throw new Error("Invalid model selection request.");
    const installed = await readInstalledModels();
    if (typeof body.modelId !== "string" || !installed.includes(body.modelId)) throw new Error("Select an installed local model.");
    const preference = updateSelectedChatModel({ modelId: body.modelId, expectedRevision: body.expectedRevision });
    return NextResponse.json({ preference, models: buildModelViews(installed, preference) });
  } catch {
    return NextResponse.json({ error: "The selected model was not changed." }, { status: 400 });
  }
}
