export const ELECTRON_MAJOR_VERSION = 43;
export const ELECTRON_FUSE_POLICY_NAME = "electron-43-hardened-v2";

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
  // Current pinned Electron archives do not require the browser-specific
  // snapshot; keeping this disabled is launch-compatible on macOS and Windows.
  LoadBrowserProcessSpecificV8Snapshot: false,
  GrantFileProtocolExtraPrivileges: false,
  WasmTrapHandlers: true,
});

export function electronFuseOptions(platform: NodeJS.Platform, arch: string) {
  return Object.freeze({ resetAdHocDarwinSignature: platform === "darwin" && arch === "arm64" });
}
