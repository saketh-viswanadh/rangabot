"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { CraftIcon } from "./craft-icon";
import { PrimaryBrandMark } from "./brand-mark";
import { welcomeModeOptions } from "./welcome-preferences";
import { localApiFetch } from "@/lib/local-api-client";
import type { DesktopPreferences } from "@/lib/desktop-preferences";
import {
  onboardingNeedsStart,
  onboardingStepAfterRefresh,
  onboardingSteps,
  formatOnboardingTimestamp,
  type OnboardingState,
  type OnboardingStep,
} from "@/lib/onboarding-contract";
import { initialOnboardingModelId, shouldDiscoverOnboardingModels, usableOnboardingModels } from "@/lib/onboarding-model-choice";
import { knowledgeImportFailureMessage, knowledgeImportMessage } from "@/lib/knowledge-import-message";
import { paletteOptions, type Appearance, type Palette } from "@/lib/appearance-preferences";
import { MAX_PREFERRED_NAME_CHARACTERS, sanitizePreferredName, type WelcomeMode } from "@/lib/welcome-preferences";

type Profile = Readonly<{ displayName: string; marker: string; kind: "default" | "personal" | "testing" }>;
type Model = Readonly<{
  id: string;
  label: string;
  installed: boolean;
  selected: boolean;
  recommended: boolean;
  kind: "chat" | "embedding" | "unqualified";
  selectable: boolean;
  tier?: string;
  minimumMemoryGb?: number;
}>;
type ModelState = Readonly<{
  preference: { selectedModel: string; contextTokens: number; revision: number };
  models: Model[];
}>;
type DesktopPickerBridge = Readonly<{
  pickLocalFiles(kind: "knowledge" | "dataset" | "repository"): Promise<{ status: "selected" | "cancelled"; paths: string[] }>;
}>;

const stepCopy: Record<OnboardingStep, { eyebrow: string; title: string; detail: string }> = {
  you: { eyebrow: "1 · You", title: "Make it feel like yours", detail: "Choose only what helps. Your name is optional and never enters a model prompt." },
  model: { eyebrow: "2 · Local model", title: "Choose your local intelligence", detail: "Rangabot detects installed models in place. It never copies or downloads one during setup." },
  welcome: { eyebrow: "3 · Welcome", title: "Set the tone for a fresh page", detail: "Pick the offline welcome mix you want. You can change it later." },
  context: { eyebrow: "4 · Local context", title: "Approve only what you need", detail: "Selection and access are separate actions. Nothing is scanned just because you choose it." },
  ready: { eyebrow: "5 · Ready", title: "Know what Rangabot can do", detail: "A quiet, manual tour of the tools in this private profile." },
};

const tourItems = [
  { icon: "chat" as const, title: "Chat", detail: "Ask, write, build and reason with the selected local model." },
  { icon: "model" as const, title: "Models", detail: "See installed models, their limits and the active choice. Downloads always require a separate click." },
  { icon: "knowledge" as const, title: "Knowledge", detail: "Import supported documents into this profile, then use cited local retrieval." },
  { icon: "folder" as const, title: "Work folders", detail: "Approve a folder, then search or preview files only when you ask." },
  { icon: "memory" as const, title: "Memory", detail: "Review and remove explicit saved facts. Memory is never a folder." },
  { icon: "analysis" as const, title: "Data", detail: "Choose a local dataset and confirm read-only analysis before a query runs." },
  { icon: "document" as const, title: "Projects", detail: "Organize local chats and move them in or out whenever you need." },
];

function nextStep(step: OnboardingStep) {
  return onboardingSteps[Math.min(onboardingSteps.indexOf(step) + 1, onboardingSteps.length - 1)];
}

function displayPath(path: string) {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

class OnboardingRefreshError extends Error {
  constructor() {
    super("Setup progress refreshed from this profile.");
    this.name = "OnboardingRefreshError";
  }
}

export function FirstRunSetup({
  profile,
  preferences: initialPreferences,
  onboarding: initialOnboarding,
  onClose,
  onPreferencesChanged,
  onOnboardingChanged,
  onAppearancePreview,
}: {
  profile: Profile;
  preferences: DesktopPreferences;
  onboarding: OnboardingState;
  onClose(): void;
  onPreferencesChanged(preferences: DesktopPreferences): void;
  onOnboardingChanged(onboarding: OnboardingState): void;
  onAppearancePreview(appearance: Appearance | null, palette: Palette): void;
}) {
  const replay = initialOnboarding.status === "completed";
  const [preferences, setPreferences] = useState(initialPreferences);
  const [onboarding, setOnboarding] = useState(initialOnboarding);
  const [step, setStep] = useState<OnboardingStep>(replay ? "ready" : initialOnboarding.step);
  const [preferredName, setPreferredName] = useState(initialPreferences.preferredName);
  const [appearance, setAppearance] = useState<Appearance | null>(initialPreferences.appearance);
  const [systemAppearance, setSystemAppearance] = useState<Appearance>("light");
  const [palette, setPalette] = useState<Palette>(initialPreferences.palette);
  const [welcomeMode, setWelcomeMode] = useState<WelcomeMode>(initialPreferences.welcomeMode);
  const [modelState, setModelState] = useState<ModelState | null>(null);
  const [modelError, setModelError] = useState("");
  const [modelAttempt, setModelAttempt] = useState(0);
  const [selectedModelId, setSelectedModelId] = useState("");
  const [pendingRepository, setPendingRepository] = useState("");
  const [pendingKnowledge, setPendingKnowledge] = useState<string[]>([]);
  const [contextMessage, setContextMessage] = useState("");
  const [tourIndex, setTourIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [startFailed, setStartFailed] = useState(false);
  const [closeWithoutSavingAvailable, setCloseWithoutSavingAvailable] = useState(false);
  const [desktopBridgeAvailable, setDesktopBridgeAvailable] = useState<boolean | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const startRequested = useRef(false);
  const externalInputsDisabled = profile.kind === "testing";
  const modelLoading = shouldDiscoverOnboardingModels({
    step,
    hasModelState: Boolean(modelState),
    discoveryError: modelError,
    testing: externalInputsDisabled,
  });

  useEffect(() => {
    requestAnimationFrame(() => titleRef.current?.focus());
  }, [step]);

  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => setSystemAppearance(query.matches ? "dark" : "light");
    const frame = requestAnimationFrame(sync);
    query.addEventListener("change", sync);
    return () => { cancelAnimationFrame(frame); query.removeEventListener("change", sync); };
  }, []);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setDesktopBridgeAvailable(Boolean(desktopBridge())));
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (replay || startRequested.current || onboarding.status === "in-progress") return;
    void startSetupPersistence();
    // The initial persisted state identifies this one setup session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!modelLoading) return;
    let active = true;
    void Promise.resolve().then(async () => {
      if (!active) return;
      const response = await localApiFetch("/api/models", { cache: "no-store" });
      const data = await response.json() as ModelState & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Local model discovery failed.");
      if (!active) return;
      setModelState(data);
      setSelectedModelId(initialOnboardingModelId(data.models));
    }).catch((error) => {
      if (active) setModelError(error instanceof Error ? error.message : "Local model discovery failed.");
    });
    return () => { active = false; };
  }, [modelAttempt, modelLoading]);

  async function mutateOnboarding(input:
    | { action: "start" | "advance" | "dismiss"; step: OnboardingStep }
    | { action: "complete" }) {
    const response = await localApiFetch("/api/onboarding", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, expectedRevision: onboarding.revision }),
    });
    const data = await response.json() as { onboarding?: OnboardingState; error?: string };
    if (!response.ok || !data.onboarding) {
      if (response.status === 409 && data.onboarding) {
        const refreshed = data.onboarding;
        setOnboarding(refreshed);
        setStep(onboardingStepAfterRefresh(refreshed));
        setStartFailed(onboardingNeedsStart(refreshed));
        startRequested.current = !onboardingNeedsStart(refreshed);
        setCloseWithoutSavingAvailable(false);
        setMessage("Setup progress refreshed from this profile.");
        onOnboardingChanged(refreshed);
        throw new OnboardingRefreshError();
      }
      throw new Error(data.error ?? "Setup progress could not be saved.");
    }
    setOnboarding(data.onboarding);
    onOnboardingChanged(data.onboarding);
    setCloseWithoutSavingAvailable(false);
    return data.onboarding;
  }

  async function startSetupPersistence() {
    if (startRequested.current) return;
    startRequested.current = true;
    setBusy(true);
    setMessage("");
    try {
      await mutateOnboarding({ action: "start", step: onboarding.status === "dismissed" ? onboarding.step : step });
      setStartFailed(false);
    } catch (error) {
      if (error instanceof OnboardingRefreshError) return;
      startRequested.current = false;
      setStartFailed(true);
      setCloseWithoutSavingAvailable(true);
      setMessage(`${error instanceof Error ? error.message : "Setup progress could not be started."} Retry, or close without saving; Rangabot may invite you again.`);
    } finally { setBusy(false); }
  }

  function closeWithoutSaving() {
    onAppearancePreview(preferences.appearance, preferences.palette);
    onClose();
  }

  async function savePreferences(update: { preferredName?: string; welcomeMode?: WelcomeMode; appearance?: Appearance | null; palette?: Palette }) {
    const response = await localApiFetch("/api/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedRevision: preferences.revision,
        preferredName: update.preferredName ?? preferences.preferredName,
        welcomeMode: update.welcomeMode ?? preferences.welcomeMode,
        appearance: Object.prototype.hasOwnProperty.call(update, "appearance") ? update.appearance : preferences.appearance,
        palette: update.palette ?? preferences.palette,
      }),
    });
    const data = await response.json() as { preferences?: DesktopPreferences; error?: string };
    if (!response.ok || !data.preferences) throw new Error(data.error ?? "Preferences could not be saved.");
    setPreferences(data.preferences);
    onPreferencesChanged(data.preferences);
    return data.preferences;
  }

  async function advance(options: { saveYou?: boolean; saveWelcome?: boolean } = {}) {
    setBusy(true);
    setMessage("");
    try {
      if (options.saveYou && profile.kind !== "testing") {
        const name = sanitizePreferredName(preferredName) ?? "";
        setPreferredName(name);
        await savePreferences({ preferredName: name, appearance, palette });
      }
      if (!options.saveYou && step === "you") onAppearancePreview(preferences.appearance, preferences.palette);
      if (options.saveWelcome && profile.kind !== "testing") await savePreferences({ welcomeMode });
      const following = nextStep(step);
      if (!replay) await mutateOnboarding({ action: "advance", step: following });
      setStep(following);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "That setup choice was not saved.");
    } finally { setBusy(false); }
  }

  async function dismiss() {
    if (busy) return;
    onAppearancePreview(preferences.appearance, preferences.palette);
    if (replay || onboarding.status === "completed") return onClose();
    setBusy(true);
    try {
      await mutateOnboarding({ action: "dismiss", step });
      onClose();
    } catch (error) {
      setCloseWithoutSavingAvailable(true);
      setMessage(`${error instanceof Error ? error.message : "Setup could not be dismissed safely."} Close without saving if you want to leave now; Rangabot may invite you again.`);
    } finally { setBusy(false); }
  }

  async function selectModel() {
    if (!modelState || !selectedModelId) return false;
    const selected = modelState.models.find((model) => model.id === selectedModelId);
    if (!selected?.installed || !selected.selectable) { setModelError("Choose an installed reviewed chat model."); return false; }
    if (selected.selected) return true;
    setBusy(true);
    setModelError("");
    try {
      const response = await localApiFetch("/api/models", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modelId: selected.id,
          contextTokens: modelState.preference.contextTokens,
          expectedRevision: modelState.preference.revision,
        }),
      });
      const data = await response.json() as ModelState & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "The local model was not changed.");
      setModelState(data);
      setModelError(`${selected.label} is now the default for this profile.`);
      return true;
    } catch (error) {
      setModelError(error instanceof Error ? error.message : "The local model was not changed.");
      return false;
    } finally { setBusy(false); }
  }

  async function selectModelAndContinue() {
    if (await selectModel()) await advance();
  }

  async function goBack() {
    const previous = onboardingSteps[onboardingSteps.indexOf(step) - 1];
    if (!previous) return;
    setBusy(true);
    setMessage("");
    try {
      if (!replay) await mutateOnboarding({ action: "advance", step: previous });
      setStep(previous);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Setup progress could not be saved."); }
    finally { setBusy(false); }
  }

  function desktopBridge() {
    if (typeof window === "undefined") return undefined;
    return (window as typeof window & { rangabotDesktop?: DesktopPickerBridge }).rangabotDesktop;
  }

  async function chooseRepository() {
    const desktop = desktopBridge();
    if (!desktop) return setContextMessage("Folder selection is available only in the RangaBot desktop app. Paths cannot be pasted here.");
    try {
      const result = await desktop.pickLocalFiles("repository");
      if (result.status === "selected" && result.paths[0]) {
        setPendingRepository(result.paths[0]);
        setContextMessage(`${displayPath(result.paths[0])} selected. No files have been read or approved.`);
      }
    } catch (error) { setContextMessage(error instanceof Error ? error.message : "The folder picker could not open."); }
  }

  async function approveRepository() {
    if (!pendingRepository) return;
    setBusy(true);
    try {
      const response = await localApiFetch("/api/repositories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: pendingRepository }),
      });
      const data = await response.json() as { repository?: { name: string }; error?: string };
      if (!response.ok || !data.repository) throw new Error(data.error ?? "The folder was not approved.");
      setPendingRepository("");
      setContextMessage(`${data.repository.name} is approved for this profile. Its contents are still unread.`);
    } catch (error) { setContextMessage(error instanceof Error ? error.message : "The folder was not approved."); }
    finally { setBusy(false); }
  }

  async function chooseKnowledge() {
    const desktop = desktopBridge();
    if (!desktop) return setContextMessage("Document selection is available only in the RangaBot desktop app. Paths cannot be pasted here.");
    try {
      const result = await desktop.pickLocalFiles("knowledge");
      if (result.status === "selected") {
        setPendingKnowledge(result.paths);
        setContextMessage(`${result.paths.length} document${result.paths.length === 1 ? "" : "s"} selected. Nothing has been copied or indexed.`);
      }
    } catch (error) { setContextMessage(error instanceof Error ? error.message : "The document picker could not open."); }
  }

  async function importKnowledge() {
    if (!pendingKnowledge.length) return;
    setBusy(true);
    try {
      const response = await localApiFetch("/api/knowledge/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths: pendingKnowledge }),
      });
      const data = await response.json() as { selected?: number; copied?: number; retained?: string[]; partial?: boolean; status?: { incompatible?: number; pending?: number }; error?: string };
      if (!response.ok) {
        if (data.partial) {
          setPendingKnowledge([]);
          setContextMessage(knowledgeImportFailureMessage(data));
          return;
        }
        throw new Error(data.error ?? "The documents were not imported.");
      }
      const copied = data.copied ?? 0;
      const selected = data.selected ?? pendingKnowledge.length;
      setPendingKnowledge([]);
      setContextMessage(knowledgeImportMessage({
        selected,
        copied,
        incompatible: data.status?.incompatible ?? 0,
        pending: data.status?.pending ?? 0,
      }));
    } catch (error) { setContextMessage(error instanceof Error ? error.message : "The documents were not imported."); }
    finally { setBusy(false); }
  }

  async function finish() {
    if (replay || onboarding.status === "completed") return onClose();
    setBusy(true);
    setMessage("");
    try {
      await mutateOnboarding({ action: "complete" });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Setup could not be completed safely.");
    } finally { setBusy(false); }
  }

  function handleDialogKey(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") { event.preventDefault(); void dismiss(); return; }
    if (event.key !== "Tab") return;
    const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
    ) ?? []).filter((element) => element.getClientRects().length > 0);
    const first = controls[0];
    const last = controls.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  const selectableModels = useMemo(() => usableOnboardingModels(modelState?.models ?? []), [modelState]);
  const selectedModel = selectableModels.find((model) => model.selected);
  const selectedModelCandidate = selectableModels.find((model) => model.id === selectedModelId);
  const completed = onboarding.status === "completed";
  const receipt = onboarding.receipt;
  const receiptMode = replay || completed;
  const testingTour = profile.kind === "testing";
  const visibleStepCopy = testingTour && step === "ready"
    ? { eyebrow: "Tour only", title: "Explore without touching external state", detail: "No model inventory, folder, document, dataset or other external input is checked in this Testing tour." }
    : stepCopy[step];

  const resolvedAppearance = appearance ?? systemAppearance;

  return <div className="first-run-backdrop" data-appearance={resolvedAppearance} data-palette={palette}>
    <section ref={dialogRef} className="first-run-dialog" role="dialog" aria-modal="true" aria-labelledby="first-run-title" onKeyDown={handleDialogKey}>
      <header className="first-run-header">
        <div className="first-run-brand"><PrimaryBrandMark className="first-run-logo" /><span>Rangabot</span></div>
        <button type="button" className="first-run-close" onClick={() => void dismiss()} disabled={busy} aria-label={receiptMode || testingTour ? "Close setup tour" : "Save setup progress and close"}><CraftIcon name="close" /></button>
      </header>
      <div className="first-run-progress" role="progressbar" aria-label="Setup progress" aria-valuemin={1} aria-valuemax={onboardingSteps.length} aria-valuenow={onboardingSteps.indexOf(step) + 1} aria-valuetext={`${visibleStepCopy.eyebrow} of ${onboardingSteps.length}`}>
        {onboardingSteps.map((item, index) => <span aria-hidden="true" key={item} className={item === step ? "active" : onboardingSteps.indexOf(step) > index ? "done" : ""} />)}
      </div>
      <main className="first-run-content">
        <div className="first-run-copy"><span>{visibleStepCopy.eyebrow}</span><h2 ref={titleRef} id="first-run-title" tabIndex={-1}>{visibleStepCopy.title}</h2><p>{visibleStepCopy.detail}</p></div>

        {step === "you" && <div className="first-run-panel you-step">
          {externalInputsDisabled && <div className="first-run-truth"><CraftIcon name="shield" /><div><strong>Read-only tour</strong><p>Name, appearance and colour controls are shown for orientation but cannot change this Testing profile.</p></div></div>}
          <label><span>Name or nickname <small>Optional</small></span><input value={preferredName} onChange={(event) => setPreferredName(event.target.value)} maxLength={MAX_PREFERRED_NAME_CHARACTERS} autoComplete="nickname" placeholder={profile.displayName} disabled={externalInputsDisabled} /></label>
          <div className="first-run-appearance">
            <fieldset><legend>Appearance</legend>{([null, "light", "dark"] as Array<Appearance | null>).map((choice) => <button type="button" key={choice ?? "system"} aria-pressed={appearance === choice} disabled={externalInputsDisabled} onClick={() => { setAppearance(choice); onAppearancePreview(choice, palette); }}><CraftIcon name={choice === "dark" ? "moon" : choice === "light" ? "sun" : "tune"} />{choice ?? "system"}</button>)}</fieldset>
            <fieldset className="first-run-palettes"><legend>Colour</legend>{paletteOptions.map((choice) => <button type="button" key={choice.id} className={`palette-choice ${choice.id}`} aria-pressed={palette === choice.id} aria-label={choice.label} title={choice.label} disabled={externalInputsDisabled} onClick={() => { setPalette(choice.id); onAppearancePreview(appearance, choice.id); }}><span className="palette-preview" /></button>)}</fieldset>
          </div>
          <p className="first-run-privacy"><CraftIcon name="shield" /> Saved only in {profile.marker}. It is not chat memory and is never added to prompts.</p>
        </div>}

        {step === "model" && <div className="first-run-panel model-step">
          {externalInputsDisabled ? <div className="first-run-truth"><CraftIcon name="shield" /><div><strong>Testing profile protection</strong><p>Local model discovery and selection are disabled during this tour. No external model store is queried.</p></div></div>
            : modelLoading ? <p role="status">Checking the local model runtime…</p>
              : modelError && !modelState ? <div className="first-run-truth attention"><CraftIcon name="model" /><div><strong>Discovery unavailable</strong><p>{modelError} Nothing was selected or downloaded.</p><button type="button" onClick={() => { setModelError(""); setModelState(null); setModelAttempt((attempt) => attempt + 1); }}>Try again</button></div></div>
                : selectableModels.length === 0 ? <div className="first-run-truth attention"><CraftIcon name="model" /><div><strong>No reviewed chat model detected</strong><p>The configured default {modelState?.preference.selectedModel} is not currently usable. Continue now and use Model Manager later. Setup never downloads or copies a model.</p></div></div>
                  : <><div className="model-discovery-summary"><span className="model-ready-light" /><div><strong>{selectableModels.length} compatible model{selectableModels.length === 1 ? "" : "s"} on this device</strong><p>{selectedModel ? `${selectedModel.label} is currently selected.` : "No compatible default is selected yet."}</p></div></div>
                    <fieldset className="first-run-model-list"><legend>{selectableModels.length === 1 ? "Detected model" : "Choose a default"}</legend>{selectableModels.map((model) => <label key={model.id} className={selectedModelId === model.id ? "selected" : ""}><input type="radio" name="setup-model" value={model.id} checked={selectedModelId === model.id} onChange={() => setSelectedModelId(model.id)} /><span><strong>{model.label}</strong><small>{model.tier ?? "Reviewed local chat model"}{model.minimumMemoryGb ? ` · ${model.minimumMemoryGb} GB+ memory` : ""}</small></span>{model.selected && <em>Current</em>}</label>)}</fieldset>
                    {modelError && <p role="status" className="first-run-status">{modelError}</p>}</>}
          <p className="first-run-privacy"><CraftIcon name="shield" /> Detection reads only the local model runtime’s inventory. Models stay where they are.</p>
        </div>}

        {step === "welcome" && <fieldset className="first-run-panel first-run-welcome"><legend className="sr-only">Fresh-chat welcome mode</legend>{externalInputsDisabled && <div className="first-run-truth"><CraftIcon name="shield" /><div><strong>Read-only tour</strong><p>Welcome choices are shown but cannot change this Testing profile.</p></div></div>}{welcomeModeOptions.map((option) => <label key={option.value} className={welcomeMode === option.value ? "selected" : ""}><input type="radio" name="setup-welcome" value={option.value} checked={welcomeMode === option.value} disabled={externalInputsDisabled} onChange={() => setWelcomeMode(option.value)} /><span><strong>{option.label}</strong><small>{option.detail}</small></span></label>)}</fieldset>}

        {step === "context" && <div className="first-run-panel context-step">
          {externalInputsDisabled && <div className="first-run-truth"><CraftIcon name="shield" /><div><strong>External inputs disabled</strong><p>Testing profiles get the tour without opening local pickers or accepting folders and documents.</p></div></div>}
          <article><div className="context-icon"><CraftIcon name="folder" /></div><div><strong>Work folder</strong><p>Choose a folder, then approve it separately. Approval does not read its contents.</p>{pendingRepository && <small>Selected: {displayPath(pendingRepository)}</small>}</div><div className="context-actions"><button type="button" onClick={() => void chooseRepository()} disabled={busy || externalInputsDisabled}>Choose folder</button><button type="button" className="first-run-primary-small" onClick={() => void approveRepository()} disabled={busy || externalInputsDisabled || !pendingRepository}>Approve</button></div></article>
          <article><div className="context-icon"><CraftIcon name="knowledge" /></div><div><strong>Knowledge documents</strong><p>Choose supported files, then explicitly import copies into this profile for local indexing.</p>{pendingKnowledge.length > 0 && <small>{pendingKnowledge.length} selected · not imported</small>}</div><div className="context-actions"><button type="button" onClick={() => void chooseKnowledge()} disabled={busy || externalInputsDisabled}>Choose documents</button><button type="button" className="first-run-primary-small" onClick={() => void importKnowledge()} disabled={busy || externalInputsDisabled || !pendingKnowledge.length}>Import</button></div></article>
          {desktopBridgeAvailable === false && !externalInputsDisabled && <p className="first-run-unsupported">Native pickers are unavailable in this browser view. Open the desktop app; pasted paths are intentionally not accepted.</p>}
          {contextMessage && <p className="first-run-status" role="status">{contextMessage}</p>}
          <p className="first-run-privacy"><CraftIcon name="shield" /> Memory is separate: only explicit, inspectable facts can be saved there.</p>
        </div>}

        {step === "ready" && <div className="first-run-panel ready-step">
          <div className="tour-layout"><nav aria-label="Feature tour">{tourItems.map((item, index) => <button type="button" key={item.title} className={tourIndex === index ? "active" : ""} aria-pressed={tourIndex === index} onClick={() => setTourIndex(index)}><CraftIcon name={item.icon} />{item.title}</button>)}</nav><article role="status" aria-live="polite"><PrimaryBrandMark className="tour-mark" /><span>{tourItems[tourIndex].title}</span><h3>{tourItems[tourIndex].detail}</h3><p>This tour never opens a folder, starts a model, imports a document or sends a request. Explore when you are ready.</p></article></div>
          {testingTour ? <section className="privacy-receipt" aria-label="Testing tour receipt" role="status" aria-live="polite"><header><CraftIcon name="shield" /><div><strong>{receipt ? "Tour receipt" : "Tour only"}</strong><small>{profile.marker}</small></div></header><ul><li><span>External state checked</span><strong>None</strong></li><li><span>Model state at completion</span><strong>{receipt ? "Not checked in Testing tour" : "Not checked"}</strong></li><li><span>Approved work folders at completion</span><strong>{receipt?.approvedWorkFolders ?? 0}</strong></li><li><span>Knowledge documents at completion</span><strong>{receipt?.knowledgeDocuments ?? 0}</strong></li></ul>{receipt?.completedAt && <small>Completed <time dateTime={receipt.completedAt}>{formatOnboardingTimestamp(receipt.completedAt)}</time></small>}</section>
            : <section className="privacy-receipt" aria-label="Local setup receipt" role="status" aria-live="polite"><header><CraftIcon name="shield" /><div><strong>{completed ? "Setup receipt" : "Ready to finish"}</strong><small>{profile.marker}</small></div></header><ul><li><span>Cloud access</span><strong>None</strong></li><li><span>Automatic downloads</span><strong>None</strong></li><li><span>Model files copied</span><strong>None</strong></li>{receipt ? <><li><span>Selected model at completion</span><strong>{receipt.selectedModel}</strong></li><li><span>Model state at completion</span><strong>{receipt.selectedModelState === "installed-reviewed" ? "Installed and reviewed" : receipt.selectedModelState === "not-checked-testing" ? "Not checked in Testing tour" : "Configured; availability unverified"}</strong></li><li><span>Approved work folders at completion</span><strong>{receipt.approvedWorkFolders}</strong></li><li><span>Knowledge documents at completion</span><strong>{receipt.knowledgeDocuments}</strong></li></> : <li><span>Current-state receipt</span><strong>Calculated when you finish</strong></li>}</ul>{receipt?.completedAt && <small>Completed <time dateTime={receipt.completedAt}>{formatOnboardingTimestamp(receipt.completedAt)}</time></small>}</section>}
        </div>}

        {message && <p className="first-run-error" role="alert">{message}</p>}
      </main>
      <footer className="first-run-footer">
        <div className="first-run-exit-actions">
          <button type="button" className="first-run-text-button" onClick={() => void dismiss()} disabled={busy}>{receiptMode || testingTour ? "Close tour" : "Finish later"}</button>
          {startFailed && <button type="button" className="first-run-text-button" onClick={() => void startSetupPersistence()} disabled={busy}>Retry saving progress</button>}
          {closeWithoutSavingAvailable && <button type="button" className="first-run-text-button first-run-unsaved-close" onClick={closeWithoutSaving} disabled={busy}>Close without saving progress</button>}
        </div>
        <div>
          {step !== "you" && !receiptMode && <button type="button" className="first-run-secondary" onClick={() => void goBack()} disabled={busy}>Back</button>}
          {step === "you" && (testingTour ? <button type="button" className="first-run-primary" onClick={() => void advance()} disabled={busy}>Continue tour</button> : <><button type="button" className="first-run-secondary" onClick={() => void advance()} disabled={busy}>Skip</button><button type="button" className="first-run-primary" onClick={() => void advance({ saveYou: true })} disabled={busy}>Save & continue</button></>)}
          {step === "model" && (testingTour ? <button type="button" className="first-run-primary" onClick={() => void advance()} disabled={busy}>Continue tour</button> : <><button type="button" className="first-run-secondary" onClick={() => void advance()} disabled={busy}>Skip model</button><button type="button" className="first-run-primary" onClick={() => void selectModelAndContinue()} disabled={busy || !selectedModelCandidate}>Use selected & continue</button></>)}
          {step === "welcome" && (testingTour ? <button type="button" className="first-run-primary" onClick={() => void advance()} disabled={busy}>Continue tour</button> : <><button type="button" className="first-run-secondary" onClick={() => void advance()} disabled={busy}>Skip</button><button type="button" className="first-run-primary" onClick={() => void advance({ saveWelcome: true })} disabled={busy}>Save & continue</button></>)}
          {step === "context" && (testingTour ? <button type="button" className="first-run-primary" onClick={() => void advance()} disabled={busy}>Continue tour</button> : <><button type="button" className="first-run-secondary" onClick={() => void advance()} disabled={busy}>Skip</button><button type="button" className="first-run-primary" onClick={() => void advance()} disabled={busy}>Continue</button></>)}
          {step === "ready" && <button type="button" className="first-run-primary" onClick={() => void finish()} disabled={busy}>{completed || replay || testingTour ? "Done" : "Finish setup"}</button>}
        </div>
      </footer>
    </section>
  </div>;
}
