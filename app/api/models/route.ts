import { NextResponse } from "next/server";
import { buildModelViews, isSelectableChatModel, readInstalledModels, readModelPreference, updateSelectedChatModel } from "@/lib/model-manager";
import { StaleProfileRequestError, withProfileRequest } from "@/lib/profile-request";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    return await withProfileRequest(request, { kind: "tool-execution", label: "local model discovery" }, async () => {
      const preference = readModelPreference();
      const installed = await readInstalledModels();
      return NextResponse.json({ runtime: "managed-local", preference, models: buildModelViews(installed, preference) });
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof StaleProfileRequestError ? error.message : "The local model manager is unavailable." }, { status: error instanceof StaleProfileRequestError ? 409 : 503 });
  }
}

export async function PUT(request: Request) {
  try {
    return await withProfileRequest(request, { kind: "database-mutation", label: "model preference update" }, async () => {
      const body = await request.json() as Record<string, unknown>;
      if (Object.keys(body).sort().join(",") !== "contextTokens,expectedRevision,modelId") {
        throw new Error("Invalid model preference request.");
      }
      const installed = await readInstalledModels();
      if (typeof body.modelId !== "string" || !isSelectableChatModel(body.modelId, installed)) throw new Error("Select an installed reviewed chat model.");
      const preference = updateSelectedChatModel({
        modelId: body.modelId,
        contextTokens: body.contextTokens,
        expectedRevision: body.expectedRevision,
      });
      return NextResponse.json({ preference, models: buildModelViews(installed, preference) });
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof StaleProfileRequestError ? error.message : "The selected model was not changed." }, { status: error instanceof StaleProfileRequestError ? 409 : 400 });
  }
}
