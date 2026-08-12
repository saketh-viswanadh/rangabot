export const DESKTOP_RENDERER_WEB_PREFERENCES = Object.freeze({
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  devTools: false,
  spellcheck: false,
  navigateOnDragDrop: false,
  safeDialogs: true,
});

type PreventableEvent = { preventDefault(): void };

export type DesktopSessionLike = {
  setPermissionCheckHandler(handler: () => boolean): void;
  setPermissionRequestHandler(handler: (webContents: unknown, permission: string, callback: (allowed: boolean) => void) => void): void;
  on(event: "will-download", handler: (event: PreventableEvent) => void): void;
  webRequest: {
    onBeforeRequest(
      filter: { urls: string[] },
      handler: (details: { url: string }, callback: (response: { cancel: boolean }) => void) => void,
    ): void;
  };
};

export type DesktopWebContentsLike = {
  setWindowOpenHandler(handler: () => { action: "deny" }): void;
  on(event: "will-navigate" | "will-redirect", handler: (event: PreventableEvent, url: string) => void): void;
  on(event: "will-attach-webview", handler: (event: PreventableEvent) => void): void;
};

export function isAllowedDesktopDocumentUrl(candidate: string, allowedOrigin: string) {
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" && url.origin === allowedOrigin && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

export function installDesktopSessionGuards(session: DesktopSessionLike, allowedOrigin: string) {
  const parsed = new URL(allowedOrigin);
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("Desktop renderer traffic requires one exact IPv4 loopback origin.");
  }
  session.setPermissionCheckHandler(() => false);
  session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.on("will-download", (event) => event.preventDefault());
  session.webRequest.onBeforeRequest(
    { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] },
    (details, callback) => callback({ cancel: !isAllowedDesktopDocumentUrl(details.url, parsed.origin) }),
  );
}

export function installDesktopWebContentsGuards(webContents: DesktopWebContentsLike, allowedOrigin: string) {
  webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const guardNavigation = (event: PreventableEvent, url: string) => {
    if (!isAllowedDesktopDocumentUrl(url, allowedOrigin)) event.preventDefault();
  };
  webContents.on("will-navigate", guardNavigation);
  webContents.on("will-redirect", guardNavigation);
  webContents.on("will-attach-webview", (event) => event.preventDefault());
}
