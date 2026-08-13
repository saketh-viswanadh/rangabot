"use client";

import { ChangeEvent, FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  adoptLocalProfileSession,
  localApiFetch,
} from "@/lib/local-api-client";
import { CraftIcon } from "./craft-icon";

export type ProfileView = {
  id: string;
  displayName: string;
  kind: "default" | "personal" | "testing";
  marker: "Default" | "Personal" | "Testing · Temporary";
  protected: boolean;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

type ProfilesView = {
  schemaVersion: 1;
  setupRequired: boolean;
  generation: number;
  activeProfileId: string | null;
  profiles: ProfileView[];
  recoveryRequired?: boolean;
  registryRecoveryRequired?: boolean;
  operationRecovery?: { operation: string; phase: string } | null;
  profileTransferAllowed: boolean;
  message?: string;
};

type ScopePreview = {
  profile: Pick<ProfileView, "id" | "displayName" | "kind" | "protected">;
  active: boolean;
  rootToken: string;
  categories: string[];
  sharedExcluded: string[];
};

function profileFrom(view: ProfilesView | null) {
  return view?.profiles.find(({ active }) => active) ?? null;
}

function profileInitials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? `${words[0][0]}${words.at(-1)?.[0] ?? ""}` : words[0]?.slice(0, 2) ?? "RB").toUpperCase();
}

async function jsonResponse<T>(response: Response) {
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? "The local profile operation failed.");
  return data;
}

type DesktopBackupBridge = Readonly<{
  saveProfileBackup(bytes: ArrayBuffer, filename: string): Promise<{ status: "saved" | "cancelled" }>;
}>;

type BrowserBackupSaveHandle = Readonly<{
  createWritable(): Promise<{
    write(value: Blob): Promise<void>;
    close(): Promise<void>;
    abort?(): Promise<void>;
  }>;
}>;

async function saveBlob(bytes: Blob, filename: string) {
  const desktop = (window as typeof window & { rangabotDesktop?: DesktopBackupBridge }).rangabotDesktop;
  if (desktop) return desktop.saveProfileBackup(await bytes.arrayBuffer(), filename);
  const browserWindow = window as typeof window & {
    showSaveFilePicker?: (options: {
      suggestedName: string;
      types: Array<{ description: string; accept: Record<string, string[]> }>;
    }) => Promise<BrowserBackupSaveHandle>;
  };
  const picker = browserWindow.showSaveFilePicker;
  if (!picker) return { status: "unsupported" as const };
  try {
    const handle = await picker.call(browserWindow, {
      suggestedName: filename,
      types: [{ description: "RangaBot profile backup", accept: { "application/json": [".json"] } }],
    });
    const writable = await handle.createWritable();
    try {
      await writable.write(bytes);
      await writable.close();
    } catch (error) {
      try { await writable.abort?.(); } catch { /* Preserve the original local-write failure. */ }
      throw error;
    }
    return { status: "saved" as const };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return { status: "cancelled" as const };
    throw error;
  }
}

export function ProfileManager({ onSwitchingChange, onActiveProfileChange, onRecoveryRequiredChange }: {
  onSwitchingChange?: (switching: boolean) => void;
  onActiveProfileChange?: (profile: { marker: string; kind: ProfileView["kind"] } | null) => void;
  onRecoveryRequiredChange?: (required: boolean) => void;
}) {
  const [view, setView] = useState<ProfilesView | null>(null);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"choose" | "create" | "manage">("choose");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [createName, setCreateName] = useState("");
  const [createKind, setCreateKind] = useState<"personal" | "testing">("personal");
  const [renameName, setRenameName] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [scope, setScope] = useState<ScopePreview | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [destructiveAction, setDestructiveAction] = useState<"reset" | "delete" | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreRef = useRef<HTMLInputElement>(null);
  const confirmationRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);

  const refresh = useCallback(async () => {
    const response = await localApiFetch("/api/profiles", { cache: "no-store" });
    const next = await jsonResponse<ProfilesView>(response);
    setView(next);
    setSelectedId((current) => current && next.profiles.some(({ id }) => id === current)
      ? current
      : next.activeProfileId);
    return next;
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refresh().catch((error) => setMessage(error instanceof Error ? error.message : "Profiles are unavailable."))
        .finally(() => setLoading(false));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  useEffect(() => { busyRef.current = busy; }, [busy]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) closeProfiles();
      if (event.key !== "Tab") return;
      const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
      ) ?? []).filter((element) => element.getClientRects().length > 0);
      const first = controls[0];
      const last = controls.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", closeOnEscape);
    requestAnimationFrame(() => closeRef.current?.focus());
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  useEffect(() => {
    if (scope && destructiveAction) requestAnimationFrame(() => confirmationRef.current?.focus());
  }, [destructiveAction, scope]);

  const active = profileFrom(view);
  const selected = view?.profiles.find(({ id }) => id === selectedId) ?? active;

  useEffect(() => {
    onActiveProfileChange?.(active ? { marker: `${active.displayName} · ${active.marker}`, kind: active.kind } : null);
  }, [active, onActiveProfileChange]);

  useEffect(() => {
    onRecoveryRequiredChange?.(Boolean(view?.registryRecoveryRequired || view?.recoveryRequired));
  }, [onRecoveryRequiredChange, view?.recoveryRequired, view?.registryRecoveryRequired]);

  function closeProfiles() {
    setOpen(false);
    setMode("choose");
    setCreateName("");
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  async function setUpDefault() {
    setBusy(true); onSwitchingChange?.(true); setMessage("Setting up the protected Default profile…");
    try {
      const response = await localApiFetch("/api/profiles/setup", { method: "POST", body: JSON.stringify({ confirmed: true }) });
      const data = await jsonResponse<{ profiles: ProfilesView; message: string }>(response);
      adoptLocalProfileSession(response);
      setView(data.profiles); setMessage(`${data.message} Reloading its private workspace…`); setSelectedId(data.profiles.activeProfileId);
      window.location.reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Profiles could not be set up. Your original RangaBot data was not replaced. You can retry or continue with the previous setup.");
      setBusy(false); onSwitchingChange?.(false);
    }
  }

  async function recoverProfiles() {
    if (!view || (!view.registryRecoveryRequired && !view.recoveryRequired)) return;
    setBusy(true); setMessage("Recovering the last validated local profile state…");
    try {
      const response = await localApiFetch("/api/profiles/recover", {
        method: "POST",
        body: JSON.stringify({ confirmed: true, expectedGeneration: view.generation }),
      });
      const data = await jsonResponse<{ profiles: ProfilesView; message: string }>(response);
      adoptLocalProfileSession(response);
      setView(data.profiles); setMessage(`${data.message} Reloading the validated workspace…`);
      onSwitchingChange?.(true);
      window.location.reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Profile registry Recovery did not complete.");
    } finally { setBusy(false); }
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!view || view.setupRequired) return;
    setBusy(true); setMessage("");
    try {
      const response = await localApiFetch("/api/profiles", {
        method: "POST",
        body: JSON.stringify({ displayName: createName, kind: createKind, expectedGeneration: view.generation }),
      });
      const data = await jsonResponse<{ profiles: ProfilesView; profile: ProfileView }>(response);
      adoptLocalProfileSession(response);
      setView(data.profiles); setSelectedId(data.profile.id); setCreateName(""); setRenameName(""); setMode("choose");
      setMessage(`${data.profile.displayName} was created empty and isolated.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "The profile was not created."); }
    finally { setBusy(false); }
  }

  async function rename() {
    if (!view || !selected) return;
    setBusy(true); setMessage("");
    try {
      const response = await localApiFetch(`/api/profiles/${selected.id}`, {
        method: "PATCH",
        body: JSON.stringify({ displayName: renameName, expectedGeneration: view.generation }),
      });
      const data = await jsonResponse<{ profiles: ProfilesView }>(response);
      adoptLocalProfileSession(response);
      setView(data.profiles); setRenameName(""); setMessage("Profile name changed locally.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "The profile was not renamed."); }
    finally { setBusy(false); }
  }

  async function switchTo(profile: ProfileView) {
    if (!view || profile.active) return;
    setBusy(true); onSwitchingChange?.(true); setMessage(`Switching to ${profile.displayName}…`);
    try {
      const response = await localApiFetch(`/api/profiles/${profile.id}/switch`, {
        method: "POST",
        body: JSON.stringify({ expectedGeneration: view.generation }),
      });
      await jsonResponse(response);
      adoptLocalProfileSession(response);
      setMessage(`Switched to ${profile.displayName}. Reloading its private workspace…`);
      window.location.reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The profile was not switched.");
      setBusy(false); onSwitchingChange?.(false);
    }
  }

  async function reviewDestructive(action: "reset" | "delete", profile: ProfileView) {
    setBusy(true); setMessage("");
    try {
      const response = await localApiFetch(`/api/profiles/${profile.id}`, { cache: "no-store" });
      setScope(await jsonResponse<ScopePreview>(response));
      setDestructiveAction(action); setConfirmation("");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Profile scope could not be reviewed."); }
    finally { setBusy(false); }
  }

  async function applyDestructive() {
    if (!view || !scope || !destructiveAction) return;
    setBusy(true); setMessage("");
    try {
      const path = destructiveAction === "reset" ? `/api/profiles/${scope.profile.id}/reset` : `/api/profiles/${scope.profile.id}`;
      const response = await localApiFetch(path, {
        method: destructiveAction === "reset" ? "POST" : "DELETE",
        body: JSON.stringify({ confirmedName: confirmation, expectedGeneration: view.generation }),
      });
      const data = await jsonResponse<{ profiles: ProfilesView; cleanupPending: boolean }>(response);
      adoptLocalProfileSession(response);
      setView(data.profiles); setScope(null); setDestructiveAction(null); setConfirmation(""); setRenameName("");
      setMessage(data.cleanupPending
        ? "Profile state changed, but a private tombstone still needs cleanup. No other profile was touched."
        : destructiveAction === "reset" ? "Testing profile reset to an empty workspace." : "Profile deleted locally.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "The profile was not changed."); }
    finally { setBusy(false); }
  }

  async function backup(profile: ProfileView) {
    setBusy(true); setMessage(`Preparing ${profile.displayName} backup…`);
    try {
      const response = await localApiFetch(`/api/profiles/${profile.id}/backup`, { cache: "no-store" });
      if (!response.ok) throw new Error(((await response.json()) as { error?: string }).error ?? "The backup could not be created.");
      const result = await saveBlob(await response.blob(), `RangaBot-${profile.marker.replaceAll(" ", "-").replaceAll("·", "-")}-profile-backup.json`);
      setMessage(result.status === "saved"
        ? "Profile backup saved locally. Credentials, logs, shared model weights, and active external approvals were excluded."
        : result.status === "cancelled"
          ? "Profile backup save cancelled. No destination file was changed."
          : "This browser cannot choose and verify a local backup destination. Use the RangaBot desktop app or a browser with the local Save File picker.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "The backup could not be created."); }
    finally { setBusy(false); }
  }

  async function restore(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !view || view.setupRequired) return;
    setBusy(true); setMessage("Validating the complete backup before creating a profile…");
    try {
      const response = await localApiFetch("/api/profiles/restore", {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.rangabot.profile-backup+json",
          "X-Rangabot-Profile-Generation": String(view.generation),
        },
        body: file,
      });
      const data = await jsonResponse<{ profiles: ProfilesView; profile: ProfileView }>(response);
      adoptLocalProfileSession(response);
      setView(data.profiles); setSelectedId(data.profile.id); setRenameName("");
      setMessage(`${data.profile.displayName} was restored as a new inactive profile. External paths require reapproval.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "The backup was not restored."); }
    finally { setBusy(false); }
  }

  const marker = active ? `${active.displayName} · ${active.marker}` : view?.setupRequired ? "Previous setup · Profiles not ready" : "Profiles unavailable";
  return <>
    <button ref={triggerRef} type="button" className={`profile-trigger ${view?.recoveryRequired || view?.registryRecoveryRequired ? "recovery-required" : ""}`} onClick={() => { setMode("choose"); setOpen(true); }} aria-label={`Open Profiles. Active: ${marker}${view?.recoveryRequired || view?.registryRecoveryRequired ? ". Recovery required" : ""}`} disabled={loading}>
      <CraftIcon name="shield" size={15} /><span>{marker}</span>{(view?.recoveryRequired || view?.registryRecoveryRequired) && <b>Recovery</b>}
    </button>
    {open && createPortal(<div className="profile-backdrop" onMouseDown={() => { if (!busy) closeProfiles(); }}>
      <section ref={dialogRef} className="profile-dialog" role="dialog" aria-modal="true" aria-labelledby="profile-title" aria-busy={busy} onMouseDown={(event) => event.stopPropagation()}>
        <header className="profile-dialog-header"><div><span>Local workspaces · not accounts</span><h2 id="profile-title">{mode === "choose" ? "Who’s using RangaBot?" : mode === "create" ? "Add a profile" : "Manage profiles"}</h2><p>{mode === "choose" ? "Choose a private workspace" : `Active: ${marker}`}</p></div><button ref={closeRef} type="button" onClick={closeProfiles} disabled={busy} aria-label="Close Profiles"><CraftIcon name="close" /></button></header>
        {(view?.recoveryRequired || view?.registryRecoveryRequired) && <div className="profile-recovery-warning" role="status" aria-live="polite"><strong>Profile Recovery required.</strong> {view.registryRecoveryRequired ? "RangaBot opened the last validated registry copy without changing it. " : "A local profile operation did not finish. "}{view.operationRecovery ? `${view.operationRecovery.operation.replaceAll("-", " ")} stopped at ${view.operationRecovery.phase.replaceAll("-", " ")}. ` : ""}Normal workspace access stays blocked until you explicitly recover the validated state. <button type="button" onClick={() => void recoverProfiles()} disabled={busy}>Recover validated profile state</button></div>}
        {!(view?.recoveryRequired || view?.registryRecoveryRequired) && (view?.setupRequired ? <section className="profile-setup">
          <h3>Set up your protected Default profile</h3>
          <p>Your existing RangaBot data will become the protected Default profile.</p>
          <ul><li>RangaBot first inventories, backs up, copies, and verifies the workspace.</li><li>Your previous setup is not replaced until the verified cutover.</li><li>Installed Ollama model weights stay shared in place and are never copied.</li></ul>
          <button type="button" onClick={() => void setUpDefault()} disabled={busy}>Set up Default profile</button>
          <button type="button" className="secondary" onClick={closeProfiles} disabled={busy}>Continue with previous setup</button>
        </section> : view && mode === "choose" ? <section className="profile-chooser" aria-label="Choose a profile">
          <div className="profile-cards">
            {view.profiles.map((profile) => <button key={profile.id} type="button" className={`profile-card ${profile.active ? "active" : ""}`} onClick={() => profile.active ? closeProfiles() : void switchTo(profile)} disabled={busy} aria-label={`${profile.displayName}, ${profile.marker}${profile.active ? ", active" : ""}`}>
              <span className="profile-avatar" aria-hidden="true">{profileInitials(profile.displayName)}</span>
              <strong>{profile.displayName}</strong>
              <small>{profile.active ? "Active" : profile.marker}</small>
            </button>)}
            <button type="button" className="profile-card profile-add-card" onClick={() => { setCreateName(""); setCreateKind("personal"); setMode("create"); }} disabled={busy}>
              <span className="profile-avatar" aria-hidden="true">+</span><strong>Add profile</strong><small>Empty workspace</small>
            </button>
          </div>
          <button type="button" className="profile-manage-link" onClick={() => setMode("manage")}>Manage profiles</button>
        </section> : view && mode === "create" ? <form className="profile-create-screen" onSubmit={create}>
          <button type="button" className="profile-back" onClick={() => setMode("choose")} disabled={busy}>← Back</button>
          <span className="profile-avatar profile-avatar-preview" aria-hidden="true">{profileInitials(createName)}</span>
          <label><span>Profile name</span><input autoFocus value={createName} onChange={(event) => setCreateName(event.target.value)} maxLength={64} placeholder="Name" required /></label>
          {createName.trim() && <label className="profile-kind-choice"><span>Workspace type</span><select value={createKind} onChange={(event) => setCreateKind(event.target.value as "personal" | "testing")}><option value="personal">Personal</option><option value="testing">Testing · Temporary</option></select><small>Testing profiles accept synthetic data only.</small></label>}
          <button type="submit" className="profile-primary-action" disabled={busy || !createName.trim()}>Create profile</button>
        </form> : view && <div className="profile-content">
          <nav aria-label="Local profiles">
            {view.profiles.map((profile) => <button key={profile.id} type="button" aria-current={profile.active ? "true" : undefined} className={profile.id === selected?.id ? "selected" : ""} onClick={() => { setSelectedId(profile.id); setRenameName(""); setScope(null); setDestructiveAction(null); }}>
              <span><strong>{profile.displayName}</strong><small>{profile.marker}</small></span>{profile.active && <b>Active</b>}
            </button>)}
          </nav>
          <div className="profile-details">
            {selected && <>
              <div className="profile-selected"><div><strong>{selected.displayName}</strong><span>{selected.marker}{selected.protected ? " · Protected identity" : ""}</span></div>{!selected.active && <button type="button" onClick={() => void switchTo(selected)} disabled={busy}>Switch profile</button>}</div>
              {selected.kind === "testing" && <p className="profile-testing-warning" role="note"><strong>Synthetic data only.</strong> External folders, datasets, and imported conversations or memories are disabled in this temporary workspace.</p>}
              <label><span>Display name</span><div><input value={renameName} onChange={(event) => setRenameName(event.target.value)} placeholder={selected.displayName} maxLength={64} /><button type="button" onClick={() => void rename()} disabled={busy || !renameName.trim()}>Rename</button></div><small>Renaming never changes the opaque profile identity.</small></label>
              <div className="profile-actions">{view.profileTransferAllowed && <button type="button" onClick={() => void backup(selected)} disabled={busy}>Back up profile</button>}{selected.kind === "testing" && !selected.active && <button type="button" onClick={() => void reviewDestructive("reset", selected)} disabled={busy}>Reset Testing profile</button>}{!selected.protected && !selected.active && <button type="button" className="danger" onClick={() => void reviewDestructive("delete", selected)} disabled={busy}>Delete profile</button>}</div>
            </>}
            <button type="button" className="profile-back" onClick={() => setMode("choose")}>← Back to profiles</button>
            {view.profileTransferAllowed ? <div className="profile-transfer"><button type="button" onClick={() => restoreRef.current?.click()} disabled={busy}>Restore backup as new profile</button><input ref={restoreRef} type="file" accept="application/vnd.rangabot.profile-backup+json,application/json,.json" onChange={(event) => void restore(event)} /><small>Restore validates before mutation. Credentials and model weights are not restored.</small></div> : <p className="profile-testing-warning" role="note">Backup and restore file access is disabled in this sealed verification build.</p>}
          </div>
        </div>)}
        {scope && destructiveAction && <section className="profile-confirmation" role="region" aria-live="assertive" aria-atomic="true" aria-labelledby="profile-confirmation-title"><h3 id="profile-confirmation-title">{destructiveAction === "reset" ? "Reset" : "Delete"} {scope.profile.displayName}?</h3><p>This affects only:</p><ul>{scope.categories.map((category) => <li key={category}>{category}</li>)}</ul><p>It does not touch: {scope.sharedExcluded.join(", ")}.</p><label><span>Enter the exact profile name to confirm</span><input ref={confirmationRef} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" /></label><div><button type="button" className="danger" onClick={() => void applyDestructive()} disabled={busy || confirmation !== scope.profile.displayName}>{destructiveAction === "reset" ? "Reset this Testing profile" : "Delete this profile"}</button><button type="button" onClick={() => { setScope(null); setDestructiveAction(null); setConfirmation(""); }} disabled={busy}>Stay</button></div>{destructiveAction === "delete" && <small>Back up first if you may need this profile later. Deletion is not secure erasure.</small>}</section>}
        {message && <p className="profile-status" role="status" aria-live="polite" aria-atomic="true">{message}</p>}
      </section>
    </div>, document.querySelector<HTMLElement>(".app-shell") ?? document.body)}
  </>;
}
