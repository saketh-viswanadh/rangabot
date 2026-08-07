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

export const welcomeModeOptions: Array<{ value: WelcomeMode; label: string; shortLabel: string; detail: string }> = [
  { value: "mixed", label: "A thoughtful mix", shortLabel: "Mix", detail: "Rotate through quotes, jokes and thoughts." },
  { value: "quotes", label: "Quotes only", shortLabel: "Quotes", detail: "Show only the offline quote collection." },
  { value: "jokes", label: "Jokes only", shortLabel: "Jokes", detail: "Keep fresh chats light." },
  { value: "thoughts", label: "Thoughts only", shortLabel: "Thoughts", detail: "Open with a small idea to sit with." },
  { value: "books", label: "Facts from my books", shortLabel: "My books", detail: "Use an exact cited sentence from the local Knowledge Vault." },
];

type WelcomePreferencesDialogProps = {
  preferences: WelcomePreferences;
  onClose: () => void;
  onSave: (preferences: WelcomePreferences) => void;
};

export function WelcomePreferencesDialog({ preferences, onClose, onSave }: WelcomePreferencesDialogProps) {
  const [preferredName, setPreferredName] = useState(preferences.preferredName ?? "");
  const [mode, setMode] = useState<WelcomeMode>(preferences.mode);
  const dialogRef = useRef<HTMLElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    requestAnimationFrame(() => nameRef.current?.focus());
  }, []);

  function submit(event: FormEvent) {
    event.preventDefault();
    onSave(normalizeWelcomePreferences({ preferredName, mode }));
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
          <div><span>Fresh chat</span><h2 id="welcome-preferences-title">Make the welcome yours</h2></div>
          <button type="button" onClick={onClose} aria-label="Close welcome preferences"><CraftIcon name="close" /></button>
        </header>
        <form onSubmit={submit}>
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
          <fieldset>
            <legend>What should appear on a fresh chat?</legend>
            {welcomeModeOptions.map((option) => (
              <label key={option.value} className={mode === option.value ? "selected" : ""}>
                <input type="radio" name="welcome-mode" value={option.value} checked={mode === option.value} onChange={() => setMode(option.value)} />
                <span><strong>{option.label}</strong><small>{option.detail}</small></span>
              </label>
            ))}
          </fieldset>
          <p className="welcome-privacy"><CraftIcon name="shield" size={15} /><span>This preference stays in this browser. Your name is not added to chat, Local Memory, the Knowledge Vault or a model prompt.</span></p>
          <footer>
            <button type="button" className="welcome-clear" onClick={() => onSave({ ...defaultWelcomePreferences })}>Clear</button>
            <button type="submit" className="welcome-save">Save preferences</button>
          </footer>
        </form>
      </section>
    </div>
  );
}
