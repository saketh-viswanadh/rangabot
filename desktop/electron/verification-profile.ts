import type { App } from "electron";
import {
  DESKTOP_FINDER_VERIFICATION_BUILD_PROFILE,
  validateFinderVerificationCapsuleReadOnly,
  type DesktopLaunchProfile,
} from "../../lib/desktop-launch-profile.ts";
import {
  preflightVerificationExternalFilesystemRegistries,
  RANGABOT_VERIFICATION_EXTERNAL_FILESYSTEM_ACCESS_ENV,
  VERIFICATION_EXTERNAL_FILESYSTEM_ACCESS,
  VERIFICATION_LOCAL_MODEL_POLICY,
} from "../../lib/desktop-external-filesystem-policy.ts";
import type { DesktopVerificationLaunchPolicy } from "./launch-environment.ts";

export type PreparedDesktopStartupProfile = Readonly<{
  kind: DesktopLaunchProfile["kind"];
  windowTitle: "Rangabot" | "Rangabot Verification";
  userDataPath: string;
  verificationPolicy?: DesktopVerificationLaunchPolicy;
}>;

/**
 * Runs only after immutable artifact verification and before the
 * single-instance lock. The verification branch validates its capsule, binds
 * only pre-existing paths, and preflights registries without filesystem writes.
 */
export function prepareDesktopStartupProfileBeforeLock(input: {
  electronApp: Pick<App, "getPath" | "setPath">;
  launchProfile: DesktopLaunchProfile;
}): PreparedDesktopStartupProfile {
  if (input.launchProfile.kind !== DESKTOP_FINDER_VERIFICATION_BUILD_PROFILE) {
    return Object.freeze({
      kind: "normal" as const,
      windowTitle: "Rangabot" as const,
      userDataPath: input.electronApp.getPath("userData"),
    });
  }

  const capsule = validateFinderVerificationCapsuleReadOnly({
    appDataPath: input.electronApp.getPath("appData"),
    profile: input.launchProfile,
  });
  const policyEnvironment = {
    [RANGABOT_VERIFICATION_EXTERNAL_FILESYSTEM_ACCESS_ENV]: VERIFICATION_EXTERNAL_FILESYSTEM_ACCESS,
  } as const;
  input.electronApp.setPath("userData", capsule.userDataPath);
  input.electronApp.setPath("sessionData", capsule.sessionDataPath);
  input.electronApp.setPath("logs", capsule.logsPath);
  input.electronApp.setPath("crashDumps", capsule.crashDumpsPath);
  preflightVerificationExternalFilesystemRegistries({
    dataRoot: capsule.dataRoot,
    environment: policyEnvironment,
  });
  return Object.freeze({
    kind: DESKTOP_FINDER_VERIFICATION_BUILD_PROFILE,
    windowTitle: "Rangabot Verification" as const,
    userDataPath: capsule.userDataPath,
    verificationPolicy: Object.freeze({
      externalFilesystemAccess: VERIFICATION_EXTERNAL_FILESYSTEM_ACCESS,
      localModelPolicy: VERIFICATION_LOCAL_MODEL_POLICY,
    }),
  });
}
