export const ELECTRON_MAJOR_VERSION = 43;

/**
 * Electron 43 packaging must apply this policy to the final executable.
 * Keeping it data-only makes the expectation independently testable without
 * installing or launching Electron.
 */
export const ELECTRON_FUSE_POLICY = Object.freeze({
  RunAsNode: false,
  EnableCookieEncryption: true,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  EnableEmbeddedAsarIntegrityValidation: true,
  OnlyLoadAppFromAsar: true,
  LoadBrowserProcessSpecificV8Snapshot: false,
  GrantFileProtocolExtraPrivileges: false,
  WasmTrapHandlers: true,
});

export const ELECTRON_FUSE_OPTIONS = Object.freeze({
  resetAdHocDarwinSignature: true,
});
