import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const component = readFileSync("app/components/first-run-setup.tsx", "utf8");
const page = readFileSync("app/page.tsx", "utf8");
const css = readFileSync("app/globals.css", "utf8");
const onboardingRoute = readFileSync("app/api/onboarding/route.ts", "utf8");
const knowledgeImportRoute = readFileSync("app/api/knowledge/import/route.ts", "utf8");
const knowledgeImport = readFileSync("lib/knowledge-import.ts", "utf8");
const knowledgeImportMessage = readFileSync("lib/knowledge-import-message.ts", "utf8");
const onboardingModelChoice = readFileSync("lib/onboarding-model-choice.ts", "utf8");
const onboardingContract = readFileSync("lib/onboarding-contract.ts", "utf8");
const profileLifecycle = readFileSync("lib/profile-lifecycle.ts", "utf8");
const settings = readFileSync("app/components/welcome-preferences.tsx", "utf8");

test("new profile lifecycle and existing-user invitation are governed by profile-owned onboarding state", () => {
  assert.match(profileLifecycle, /status: receipt\.inventory\.files\.length === 0 && receipt\.inventory\.directories\.length === 0 \? "pending" : "available"/);
  assert.match(profileLifecycle, /createProfile[\s\S]*writeInitialOnboardingState\([\s\S]*status: "pending"[\s\S]*clearProfileRecovery/);
  assert.doesNotMatch(profileLifecycle, /readdirSync\(profileRoot\)\.length/);
  assert.match(page, /onboarding\.status === "pending" \|\| onboarding\.status === "in-progress"/);
  assert.match(page, /onboarding\?\.status === "available"[\s\S]*Optional setup and tour/);
  assert.match(page, /action: "dismiss", expectedRevision: onboarding\.revision, step: onboarding\.step/);
});

test("the five-step flow is resumable while completed replay is Ready-only and receipt-preserving", () => {
  for (const step of ["you", "model", "welcome", "context", "ready"]) {
    assert.match(component, new RegExp(`${step}: \\{ eyebrow:`));
  }
  assert.match(component, /const replay = initialOnboarding\.status === "completed"/);
  assert.match(component, /useState<OnboardingStep>\(replay \? "ready" : initialOnboarding\.step\)/);
  assert.match(component, /if \(replay \|\| onboarding\.status === "completed"\) return onClose\(\)/);
  assert.doesNotMatch(component, /action: "record"|OnboardingProgress|\.progress/);
  assert.match(component, /action: "complete"/);
  assert.match(onboardingRoute, /completeOnboardingState\(\{ expectedRevision: mutation\.expectedRevision, receipt: await currentStateReceipt\(\) \}/);
});

test("Testing profiles traverse the same adjacent tour without product or external-input mutations", () => {
  assert.match(component, /const externalInputsDisabled = profile\.kind === "testing"/);
  assert.match(component, /Read-only tour/);
  assert.match(component, /disabled=\{externalInputsDisabled\}/);
  assert.match(component, /if \(options\.saveYou && profile\.kind !== "testing"\)/);
  assert.match(component, /if \(options\.saveWelcome && profile\.kind !== "testing"\)/);
  assert.match(component, /Local model discovery and selection are disabled during this tour/);
  assert.match(component, /Testing profiles get the tour without opening local pickers/);
  assert.match(onboardingRoute, /context\.profile\.kind === "testing"[\s\S]*selectedModelState: "not-checked-testing"[\s\S]*approvedWorkFolders: 0[\s\S]*knowledgeDocuments: 0/);
  assert.match(component, /testingTour \? "Done" : "Finish setup"/);
  assert.match(component, /step === "model" && \(testingTour \? <button[\s\S]*?Continue tour<\/button>/);
  assert.match(component, /step === "context" && \(testingTour \? <button[\s\S]*?Continue tour<\/button>/);
  assert.doesNotMatch(component, /profile\.kind === "testing" \? "ready"/);
});

test("model setup distinguishes discovery failure, zero, one, and multiple installed choices without copy or download", () => {
  assert.match(component, /Discovery unavailable/);
  assert.match(component, /selectableModels\.length === 0/);
  assert.match(component, /setSelectedModelId\(initialOnboardingModelId\(data\.models\)\)/);
  assert.match(onboardingModelChoice, /usable\.length === 1 \? usable\[0\]\.id/);
  assert.match(onboardingModelChoice, /const usableSelected = usable\.find\(\(model\) => model\.selected\)/);
  assert.match(component, /selectableModels\.length === 1 \? "Detected model" : "Choose a default"/);
  assert.match(component, /await selectModel\(\)\) await advance\(\)/);
  assert.match(component, /method: "PUT"[\s\S]*expectedRevision: modelState\.preference\.revision/);
  assert.doesNotMatch(component, /\/api\/models\/install|\/api\/models\/pull|pullRecommendedModel|copyFile/);
  assert.match(component, /never copies or downloads one during setup/);
});

test("local context uses consent-first native selection and separate approval or Import actions", () => {
  assert.match(component, /pickLocalFiles\("repository"\)/);
  assert.match(component, /selected\. No files have been read or approved/);
  assert.match(component, /\/api\/repositories/);
  assert.match(component, /Work folder/);
  assert.match(component, /pickLocalFiles\("knowledge"\)/);
  assert.match(component, /Knowledge documents/);
  assert.match(component, /Choose documents/);
  assert.match(component, />Import<\/button>/);
  assert.match(component, /Nothing has been copied or indexed/);
  assert.doesNotMatch(component, /Knowledge folder|memory folder/i);
  assert.match(component, /Paths cannot be pasted here/);
  assert.match(knowledgeImportRoute, /assertProfileAcceptsExternalUserData\(\)/);
  assert.match(knowledgeImportRoute, /partial: error\.retained\.length > 0/);
  assert.match(knowledgeImport, /preflightKnowledgeImport/);
  assert.match(knowledgeImport, /chmodSync\(path, 0o600\)/);
  assert.match(component, /knowledgeImportMessage\(/);
  assert.match(knowledgeImportMessage, /some may not be searchable/);
  assert.doesNotMatch(component, /copied into this profile and indexed locally/);
});

test("completion receipt is authoritative current profile state and cannot be supplied by the client", () => {
  assert.match(onboardingRoute, /readModelPreference\(\)/);
  assert.match(onboardingRoute, /readInstalledModels\(\)/);
  assert.match(onboardingRoute, /listAllowedRepositories\(\)\.length/);
  assert.match(onboardingRoute, /getKnowledgeStatus\(\)\.documents/);
  assert.match(onboardingRoute, /> 10_000/);
  assert.match(component, /Current-state receipt[\s\S]*Calculated when you finish/);
  assert.match(component, /Approved work folders at completion/);
  assert.match(component, /Knowledge documents at completion/);
  assert.doesNotMatch(component, /approved now|imported now/i);
});

test("Settings preserves System appearance and exposes replay without coupling preference and onboarding failures", () => {
  assert.match(settings, /Setup &amp; tour/);
  assert.match(settings, /Open setup &amp; tour/);
  assert.match(settings, /useState<Appearance \| null>\(appearance\)/);
  assert.match(settings, /\[null, "light", "dark"\]/);
  assert.match(page, /appearance=\{desktopPreferences\?\.appearance \?\? null\}/);
  assert.match(page, /setAppearance\(saved\.appearance \?\? \(window\.matchMedia/);
  assert.match(page, /try \{[\s\S]*localApiFetch\("\/api\/onboarding"[\s\S]*catch \(error\) \{[\s\S]*Your saved preferences were kept/);
});

test("dialog has keyboard containment, SSR guards, announced tour state, safe exit, mobile stacking, and reduced motion", () => {
  assert.match(component, /if \(typeof window === "undefined"\) return undefined/);
  assert.match(component, /useState<Appearance>\("light"\)/);
  assert.match(component, /useEffect\(\(\) => \{[\s\S]*window\.matchMedia\("\(prefers-color-scheme: dark\)"\)[\s\S]*setSystemAppearance/);
  assert.doesNotMatch(component, /const resolvedAppearance = appearance \?\? \(typeof window/);
  assert.match(component, /event\.key === "Escape"/);
  assert.match(component, /event\.key !== "Tab"/);
  assert.match(component, /aria-modal="true"/);
  assert.match(component, /aria-pressed=\{tourIndex === index\}/);
  assert.match(component, /role="status" aria-live="polite"/);
  assert.match(component, /if \(replay \|\| onboarding\.status === "completed"\) return onClose\(\)/);
  assert.match(component, /await mutateOnboarding\(\{ action: "complete" \}\);/);
  assert.doesNotMatch(component, /await mutateOnboarding\(\{ action: "complete" \}\);\s*onClose\(\)/);
  assert.match(component, /const receiptMode = replay \|\| completed/);
  assert.match(component, /step !== "you" && !receiptMode/);
  assert.match(component, /Close without saving progress/);
  assert.match(component, /Rangabot may invite you again/);
  assert.match(component, /Retry saving progress/);
  assert.match(css, /@media \(max-width: 380px\), \(max-height: 600px\)/);
  assert.match(css, /\.app-shell \{ grid-template-columns: minmax\(0, 1fr\); \}/,
    "The late experience-blueprint grid must collapse to one column on mobile");
  assert.match(css, /first-run-footer[^}]*flex-direction: column-reverse/);
  assert.match(css, /first-run-footer > div[^}]*grid-template-columns: 1fr/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*first-run-backdrop[\s\S]*animation: none !important/);
  assert.match(css, /setup-invitation small \{[^}]*font-size: 11px/);
  assert.match(css, /first-run-copy > span \{[^}]*font-size: 11px/);
  assert.match(css, /first-run-model-list small, \.first-run-welcome small \{[^}]*font-size: 11px/);
  assert.match(css, /context-step article p \{[^}]*font-size: 11px/);
  assert.match(css, /context-actions button \{[^}]*font-size: 11px/);
  assert.match(css, /tour-layout nav button \{[^}]*font-size: 11px/);
  assert.match(css, /privacy-receipt li \{[^}]*font-size: 11px/);
  assert.match(css, /privacy-receipt li strong \{[^}]*min-width: 0;[^}]*overflow-wrap: anywhere;[^}]*text-align: right/);
  assert.match(css, /privacy-receipt header small, \.privacy-receipt > small \{[^}]*overflow-wrap: anywhere/);
  assert.match(page, /ref=\{preferencesTriggerRef\}/);
  assert.match(page, /className="sidebar-settings" onClick=\{\(\) => \{ setWelcomePreferencesOpen\(true\); setSidebarOpen\(false\); \}\}/,
    "Opening Settings from the mobile drawer must reveal it immediately");
  assert.match(page, /function restoreWelcomePreferencesOpenerFocus\(\)[\s\S]*max-width: 720px[\s\S]*mobile && !sidebarOpen \? mobileNavigationRef\.current : preferencesTriggerRef\.current/,
    "Closing mobile Settings must restore focus to a visible control");
  assert.match(page, /setWelcomePreferencesOpen\(false\);\s*rotateWelcome\(preferences\.mode\);\s*restoreWelcomePreferencesOpenerFocus\(\);\s*\} catch \{[\s\S]*setPreferencesMessage\("Couldn’t save preferences on this device\. Try again\."\);\s*\}\s*\}/,
    "Saving must restore focus only after success and keep failed saves inside Preferences");
  assert.match(page, /function closeSetupAndRestoreFocus\(\)[\s\S]*max-width: 720px[\s\S]*if \(mobile && !sidebarOpen\) \{[\s\S]*setupReturnFocusRef\.current = null;[\s\S]*mobileNavigationRef\.current[\s\S]*\.composer textarea[\s\S]*return;[\s\S]*const opener = setupReturnFocusRef\.current/);
  assert.match(page, /onClose=\{closeSetupAndRestoreFocus\}/);
  assert.match(component, /role="progressbar"[\s\S]*aria-valuemin=\{1\}[\s\S]*aria-valuemax=\{onboardingSteps\.length\}[\s\S]*aria-valuenow/);
  assert.match(component, /<span aria-hidden="true"/);
});

test("the client setup graph imports only the browser-safe onboarding contract", () => {
  assert.match(component, /from "@\/lib\/onboarding-contract"/);
  assert.doesNotMatch(component, /from "@\/lib\/onboarding-state"/);
  assert.match(page, /import type \{ OnboardingState \} from "@\/lib\/onboarding-contract"/);
  assert.doesNotMatch(onboardingContract, /node:|runtime-paths|private-storage|readFile|writeFile/);
  assert.match(onboardingContract, /export const onboardingSteps = \["you", "model", "welcome", "context", "ready"\] as const/);
});

test("revision conflicts resynchronize local setup navigation and retry state", () => {
  assert.match(component, /response\.status === 409 && data\.onboarding/);
  assert.match(component, /setStep\(onboardingStepAfterRefresh\(refreshed\)\)/);
  assert.match(component, /setStartFailed\(onboardingNeedsStart\(refreshed\)\)/);
  assert.match(component, /startRequested\.current = !onboardingNeedsStart\(refreshed\)/);
  assert.match(component, /Setup progress refreshed from this profile/);
  assert.match(component, /error instanceof OnboardingRefreshError/);
});

test("Context and completed receipts have hydration-stable first renders", () => {
  assert.match(component, /\[desktopBridgeAvailable, setDesktopBridgeAvailable\] = useState<boolean \| null>\(null\)/);
  assert.match(component, /requestAnimationFrame\(\(\) => setDesktopBridgeAvailable\(Boolean\(desktopBridge\(\)\)\)\)/);
  assert.match(component, /desktopBridgeAvailable === false && !externalInputsDisabled/);
  assert.doesNotMatch(component, /\{!desktopBridge\(\)/);
  assert.match(component, /<time dateTime=\{receipt\.completedAt\}>\{formatOnboardingTimestamp\(receipt\.completedAt\)\}<\/time>/);
  assert.doesNotMatch(component, /toLocaleString\(/);
});
