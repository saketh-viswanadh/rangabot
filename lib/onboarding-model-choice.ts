export type OnboardingModelCandidate = Readonly<{
  id: string;
  installed: boolean;
  selectable: boolean;
  selected: boolean;
}>;

export function usableOnboardingModels<T extends OnboardingModelCandidate>(models: readonly T[]) {
  return models.filter((model) => model.installed && model.selectable);
}

export function initialOnboardingModelId(models: readonly OnboardingModelCandidate[]) {
  const usable = usableOnboardingModels(models);
  const usableSelected = usable.find((model) => model.selected);
  return usableSelected?.id ?? (usable.length === 1 ? usable[0].id : "");
}

export function shouldDiscoverOnboardingModels(input: {
  step: string;
  hasModelState: boolean;
  discoveryError: string;
  testing: boolean;
}) {
  return input.step === "model" && !input.hasModelState && !input.discoveryError && !input.testing;
}
