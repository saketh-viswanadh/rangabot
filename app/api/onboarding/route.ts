import { NextResponse } from "next/server";
import {
  completeOnboardingState,
  OnboardingConflictError,
  parseOnboardingMutation,
  readOnboardingState,
  updateOnboardingState,
} from "@/lib/onboarding-state";
import { getKnowledgeStatus } from "@/lib/knowledge";
import { isSelectableChatModel, readInstalledModels, readModelPreference } from "@/lib/model-manager";
import { getProfileContext } from "@/lib/profile-context";
import { StaleProfileRequestError, profileBindingFromRequest, withProfileRequest } from "@/lib/profile-request";
import { listAllowedRepositories } from "@/lib/repositories";

export const runtime = "nodejs";

function boundedCurrentCount(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) {
    throw new Error(`${label} is outside the bounded setup receipt limit.`);
  }
  return value;
}

async function currentStateReceipt() {
  const context = getProfileContext();
  if (context.setupRequired) throw new Error("A profile must be active before setup can be completed.");
  const preference = readModelPreference();
  if (context.profile.kind === "testing") {
    return Object.freeze({
      selectedModel: preference.selectedModel,
      selectedModelState: "not-checked-testing" as const,
      approvedWorkFolders: 0,
      knowledgeDocuments: 0,
    });
  }
  let selectedModelState: "configured-unverified" | "installed-reviewed" = "configured-unverified";
  try {
    const installed = await readInstalledModels();
    if (isSelectableChatModel(preference.selectedModel, installed)) selectedModelState = "installed-reviewed";
  } catch {
    // The receipt remains truthful when local model discovery is unavailable.
  }
  return Object.freeze({
    selectedModel: preference.selectedModel,
    selectedModelState,
    approvedWorkFolders: boundedCurrentCount(listAllowedRepositories().length, "Approved work-folder count"),
    knowledgeDocuments: boundedCurrentCount(getKnowledgeStatus().documents, "Knowledge document count"),
  });
}

export function GET(request: Request) {
  try {
    profileBindingFromRequest(request);
    return NextResponse.json({ onboarding: readOnboardingState({ initialStatus: "available" }) }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof StaleProfileRequestError ? error.message : "Local setup progress could not be read safely." }, {
      status: error instanceof StaleProfileRequestError ? 409 : 500,
    });
  }
}

export async function PATCH(request: Request) {
  try {
    return await withProfileRequest(request, { kind: "database-mutation", label: "setup progress update" }, async () => {
      const mutation = parseOnboardingMutation(await request.json());
      const onboarding = mutation.action === "complete"
        ? completeOnboardingState({ expectedRevision: mutation.expectedRevision, receipt: await currentStateReceipt() }, { initialStatus: "available" })
        : updateOnboardingState(mutation, { initialStatus: "available" });
      return NextResponse.json({ onboarding });
    });
  } catch (error) {
    if (error instanceof OnboardingConflictError) {
      return NextResponse.json({ error: error.message, onboarding: error.current }, { status: 409 });
    }
    return NextResponse.json({ error: error instanceof StaleProfileRequestError ? error.message : "Setup progress was not changed." }, {
      status: error instanceof StaleProfileRequestError ? 409 : 400,
    });
  }
}
