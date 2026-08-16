export const ELECTRON_MAJOR_VERSION = 43;
export const ELECTRON_FUSE_POLICY_NAME = "electron-43-arm64-launchable-v1";

/**
 * Electron 43 packaging must apply this policy to the final executable.
 * Keeping it data-only makes the expectation independently testable without
 * installing or launching Electron.
 */
export const ELECTRON_FUSE_POLICY = Object.freeze({
  policyName: ELECTRON_FUSE_POLICY_NAME,
  RunAsNode: false,
  EnableCookieEncryption: true,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  EnableEmbeddedAsarIntegrityValidation: true,
  OnlyLoadAppFromAsar: true,
  // The Electron 43 arm64 archive has no browser_v8_context_snapshot.bin;
  // prior native testing proved that enabling this fuse prevents launch.
  LoadBrowserProcessSpecificV8Snapshot: false,
  GrantFileProtocolExtraPrivileges: false,
  WasmTrapHandlers: true,
});

export const ELECTRON_FUSE_OPTIONS = Object.freeze({
  resetAdHocDarwinSignature: true,
});
