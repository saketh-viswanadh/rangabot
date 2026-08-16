export const onboardingSteps = ["you", "model", "welcome", "context", "ready"] as const;

export type OnboardingStep = typeof onboardingSteps[number];
export type OnboardingStatus = "pending" | "available" | "in-progress" | "dismissed" | "completed";
export type OnboardingSelectedModelState = "installed-reviewed" | "configured-unverified" | "not-checked-testing";

export type OnboardingReceipt = Readonly<{
  completedAt: string;
  localOnly: true;
  selectedModel: string;
  selectedModelState: OnboardingSelectedModelState;
  approvedWorkFolders: number;
  knowledgeDocuments: number;
}>;

export type OnboardingState = Readonly<{
  schemaVersion: 1;
  flowVersion: 1;
  status: OnboardingStatus;
  step: OnboardingStep;
  revision: number;
  startedAt: string | null;
  dismissedAt: string | null;
  completedAt: string | null;
  receipt: OnboardingReceipt | null;
  updatedAt: string | null;
}>;

export function onboardingStepAfterRefresh(state: Pick<OnboardingState, "status" | "step">): OnboardingStep {
  return state.status === "completed" ? "ready" : state.step;
}

export function onboardingNeedsStart(state: Pick<OnboardingState, "status">) {
  return state.status === "pending" || state.status === "available" || state.status === "dismissed";
}

export function formatOnboardingTimestamp(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toISOString().replace("T", " ").replace(/\.000Z$/, " UTC");
}
