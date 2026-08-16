"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { CraftIcon } from "@/app/components/craft-icon";
import {
  MAX_PREFERRED_NAME_CHARACTERS,
  defaultWelcomePreferences,
  normalizeWelcomePreferences,
  type WelcomeMode,
  type WelcomePreferences,
} from "@/lib/welcome-preferences";
import {
  DEFAULT_PALETTE,
  paletteOptions,
  type Appearance,
  type Palette,
} from "@/lib/appearance-preferences";

export const welcomeModeOptions: Array<{ value: WelcomeMode; label: string; shortLabel: string; detail: string }> = [
  { value: "mixed", label: "A thoughtful mix", shortLabel: "Mix", detail: "Rotate through quotes, jokes and thoughts." },
  { value: "quotes", label: "Quotes only", shortLabel: "Quotes", detail: "Show only the offline quote collection." },
  { value: "jokes", label: "Jokes only", shortLabel: "Jokes", detail: "Keep fresh chats light." },
  { value: "thoughts", label: "Thoughts only", shortLabel: "Thoughts", detail: "Open with a small idea to sit with." },
  { value: "books", label: "Facts from my books", shortLabel: "My books", detail: "Use an exact cited sentence from the local Knowledge Vault." },
];

type WelcomePreferencesDialogProps = {
  preferences: WelcomePreferences;
  appearance: Appearance | null;
  palette: Palette;
  activeProfileMarker: string;
  onClose: () => void;
  onSave: (preferences: WelcomePreferences, appearance: Appearance | null, palette: Palette) => void;
  onOpenSetup: () => void;
};

export function WelcomePreferencesDialog({ preferences, appearance, palette, activeProfileMarker, onClose, onSave, onOpenSetup }: WelcomePreferencesDialogProps) {
  const [preferredName, setPreferredName] = useState(preferences.preferredName ?? "");
  const [mode, setMode] = useState<WelcomeMode>(preferences.mode);
  const [draftAppearance, setDraftAppearance] = useState<Appearance | null>(appearance);
  const [draftPalette, setDraftPalette] = useState<Palette>(palette);
  const [activeSection, setActiveSection] = useState<"personal" | "appearance" | "setup">("personal");
  const dialogRef = useRef<HTMLElement>(null);
  const tabListRef = useRef<HTMLElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    requestAnimationFrame(() => nameRef.current?.focus());
  }, []);

  function submit(event: FormEvent) {
    event.preventDefault();
    onSave(normalizeWelcomePreferences({ preferredName, mode }), draftAppearance, draftPalette);
  }

  function handleKeys(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
      "button:not(:disabled), input:not(:disabled), [href], select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])",
    ) ?? []);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function movePalette(event: KeyboardEvent<HTMLFieldSetElement>) {
    const keyOffsets: Partial<Record<string, number>> = {
      ArrowLeft: -1,
      ArrowUp: -1,
      ArrowRight: 1,
      ArrowDown: 1,
    };
    const currentIndex = paletteOptions.findIndex((choice) => choice.id === draftPalette);
    let nextIndex = currentIndex;
    if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = paletteOptions.length - 1;
    else if (keyOffsets[event.key]) nextIndex = (currentIndex + keyOffsets[event.key]! + paletteOptions.length) % paletteOptions.length;
    else return;
    event.preventDefault();
    const next = paletteOptions[nextIndex];
    const fieldset = event.currentTarget;
    setDraftPalette(next.id);
    requestAnimationFrame(() => fieldset.querySelector<HTMLInputElement>(`input[value="${next.id}"]`)?.focus());
  }

  function moveSection(event: KeyboardEvent<HTMLElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const sections = ["personal", "appearance", "setup"] as const;
    const current = sections.indexOf(activeSection);
    const nextSection = event.key === "Home" ? sections[0] : event.key === "End" ? sections.at(-1)!
      : sections[(current + (event.key === "ArrowLeft" ? -1 : 1) + sections.length) % sections.length];
    setActiveSection(nextSection);
    requestAnimationFrame(() => tabListRef.current?.querySelector<HTMLButtonElement>(`button[data-section="${nextSection}"]`)?.focus());
  }

  return (
    <div className="welcome-preferences-backdrop" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="welcome-preferences-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="welcome-preferences-title"
        onKeyDown={handleKeys}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div><span>Local preferences</span><h2 id="welcome-preferences-title">Make Rangabot yours</h2><small>Active profile: {activeProfileMarker}</small></div>
          <button type="button" onClick={onClose} aria-label="Close Preferences"><CraftIcon name="close" /></button>
        </header>
        <nav ref={tabListRef} className="preferences-tabs" role="tablist" aria-label="Preference sections" onKeyDown={moveSection}>
          <button id="preferences-personal-tab" data-section="personal" type="button" role="tab" aria-selected={activeSection === "personal"} aria-controls="preferences-personal-panel" tabIndex={activeSection === "personal" ? 0 : -1} onClick={() => setActiveSection("personal")}>Personal</button>
          <button id="preferences-appearance-tab" data-section="appearance" type="button" role="tab" aria-selected={activeSection === "appearance"} aria-controls="preferences-appearance-panel" tabIndex={activeSection === "appearance" ? 0 : -1} onClick={() => setActiveSection("appearance")}>Appearance</button>
          <button id="preferences-setup-tab" data-section="setup" type="button" role="tab" aria-selected={activeSection === "setup"} aria-controls="preferences-setup-panel" tabIndex={activeSection === "setup" ? 0 : -1} onClick={() => setActiveSection("setup")}>Setup &amp; tour</button>
        </nav>
        <form onSubmit={submit}>
          {activeSection === "personal" ? <section id="preferences-personal-panel" className="preferences-personal" role="tabpanel" aria-labelledby="preferences-personal-tab">
            <label className="welcome-name-field">
              <span>Name or nickname <small>optional</small></span>
              <input
                ref={nameRef}
                value={preferredName}
                onChange={(event) => setPreferredName(event.target.value)}
                maxLength={MAX_PREFERRED_NAME_CHARACTERS}
                placeholder="What should Ranga call you?"
                autoComplete="nickname"
              />
            </label>
            <fieldset className="welcome-content-options">
              <legend>What should appear on a fresh chat?</legend>
              {welcomeModeOptions.map((option) => (
                <label key={option.value} className={mode === option.value ? "selected" : ""}>
                  <input type="radio" name="welcome-mode" value={option.value} checked={mode === option.value} onChange={() => setMode(option.value)} />
                  <span><strong>{option.label}</strong><small>{option.detail}</small></span>
                </label>
              ))}
            </fieldset>
          </section> : activeSection === "appearance" ? <section id="preferences-appearance-panel" className="preferences-appearance" role="tabpanel" aria-labelledby="preferences-appearance-tab">
            <div className="appearance-copy"><strong>Choose your atmosphere</strong><small>Mode and palette are independent. Black and white adapts to the selected mode.</small></div>
            <div className="appearance-controls">
              <div className="appearance-setting">
                <span>Mode</span>
                <div className="appearance-mode" role="group" aria-label="Appearance mode">
                  {([null, "light", "dark"] as Array<Appearance | null>).map((choice) => (
                    <button key={choice ?? "system"} type="button" onClick={() => setDraftAppearance(choice)} aria-pressed={draftAppearance === choice} aria-label={`Use ${choice ?? "system"} mode`}>
                      <CraftIcon name={choice === "light" ? "sun" : choice === "dark" ? "moon" : "tune"} size={16} />
                      <span className="sr-only">{choice ?? "System"}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="appearance-setting colour-setting">
                <span>Palette</span>
                <fieldset className="palette-options" onKeyDown={movePalette}>
                  <legend className="sr-only">Colour theme</legend>
                  {paletteOptions.map((choice) => (
                    <label key={choice.id} className={`palette-choice ${choice.id}`} title={choice.label}>
                      <input className="sr-only" type="radio" name="colour-theme" value={choice.id} checked={draftPalette === choice.id} onChange={() => setDraftPalette(choice.id)} />
                      <span className="palette-preview" aria-hidden="true" />
                      <span className="palette-check" aria-hidden="true"><CraftIcon name="check" size={12} /></span>
                      <span className="sr-only">{choice.label}</span>
                    </label>
                  ))}
                </fieldset>
              </div>
            </div>
          </section> : <section id="preferences-setup-panel" className="preferences-setup" role="tabpanel" aria-labelledby="preferences-setup-tab">
            <CraftIcon name="spark" size={24} />
            <div><strong>Setup &amp; feature tour</strong><p>Review your local model, welcome style and explicitly approved context. Replaying the tour never resets this profile or its completion receipt.</p></div>
            <button type="button" onClick={onOpenSetup}>Open setup &amp; tour</button>
          </section>}
          <p className="welcome-privacy"><CraftIcon name="shield" size={15} /><span>These preferences stay in Rangabot’s private local data on this device. Your name is not added to chat, Local Memory, the Knowledge Vault or a model prompt.</span></p>
          <footer>
            <button type="button" className="welcome-clear" onClick={() => { setPreferredName(defaultWelcomePreferences.preferredName ?? ""); setMode(defaultWelcomePreferences.mode); setDraftAppearance(null); setDraftPalette(DEFAULT_PALETTE); }}>Reset</button>
            <button type="button" className="welcome-cancel" onClick={onClose}>Cancel</button>
            {activeSection !== "setup" && <button type="submit" className="welcome-save">Save preferences</button>}
          </footer>
        </form>
      </section>
    </div>
  );
}
