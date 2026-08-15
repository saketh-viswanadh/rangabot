import assert from "node:assert/strict";
import test from "node:test";
import { initialOnboardingModelId, shouldDiscoverOnboardingModels, usableOnboardingModels } from "../lib/onboarding-model-choice.ts";

const model = (id: string, input: Partial<{ installed: boolean; selectable: boolean; selected: boolean }> = {}) => ({
  id,
  installed: input.installed ?? true,
  selectable: input.selectable ?? true,
  selected: input.selected ?? false,
});

test("zero compatible models never seed a stale configured default", () => {
  const models = [model("stale:8b", { installed: false, selectable: false, selected: true })];
  assert.equal(initialOnboardingModelId(models), "");
  assert.deepEqual(usableOnboardingModels(models), []);
});

test("one compatible model is offered when the configured default is unavailable", () => {
  const models = [
    model("stale:8b", { installed: false, selectable: false, selected: true }),
    model("local:7b"),
  ];
  assert.equal(initialOnboardingModelId(models), "local:7b");
});

test("multiple compatible models require an explicit choice when the configured default is unavailable", () => {
  const models = [
    model("stale:8b", { installed: false, selectable: false, selected: true }),
    model("local:7b"),
    model("local:14b"),
  ];
  assert.equal(initialOnboardingModelId(models), "");
});

test("an installed selectable current model remains selected", () => {
  assert.equal(initialOnboardingModelId([model("local:7b"), model("local:14b", { selected: true })]), "local:14b");
});

test("skipping an in-flight discovery and returning to Model starts discovery again", () => {
  const base = { hasModelState: false, discoveryError: "", testing: false };
  assert.equal(shouldDiscoverOnboardingModels({ ...base, step: "model" }), true);
  assert.equal(shouldDiscoverOnboardingModels({ ...base, step: "welcome" }), false);
  assert.equal(shouldDiscoverOnboardingModels({ ...base, step: "model" }), true);
});
