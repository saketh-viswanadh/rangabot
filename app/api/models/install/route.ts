import { NextResponse } from "next/server";
import { buildModelViews, pullRecommendedModel, readInstalledModels, readModelPreference } from "@/lib/model-manager";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    if (Object.keys(body).sort().join(",") !== "confirmed,modelId" || body.confirmed !== true) throw new Error("Explicit model installation consent is required.");
    await pullRecommendedModel(body.modelId);
    const preference = readModelPreference();
    const installed = await readInstalledModels();
    return NextResponse.json({ preference, models: buildModelViews(installed, preference) });
  } catch {
    return NextResponse.json({ error: "The model could not be installed locally." }, { status: 400 });
  }
}
