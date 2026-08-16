import { NextResponse } from "next/server";
import { buildModelViews, pullRecommendedModel, readInstalledModels, readModelPreference } from "@/lib/model-manager";
import { StaleProfileRequestError, withProfileRequest } from "@/lib/profile-request";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    return await withProfileRequest(request, { kind: "tool-execution", label: "local model installation" }, async () => {
      const body = await request.json() as Record<string, unknown>;
      if (Object.keys(body).sort().join(",") !== "confirmed,modelId" || body.confirmed !== true) throw new Error("Explicit model installation consent is required.");
      await pullRecommendedModel(body.modelId);
      const preference = readModelPreference();
      const installed = await readInstalledModels();
      return NextResponse.json({ preference, models: buildModelViews(installed, preference) });
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof StaleProfileRequestError ? error.message : "The model could not be installed locally." }, { status: error instanceof StaleProfileRequestError ? 409 : 400 });
  }
}
