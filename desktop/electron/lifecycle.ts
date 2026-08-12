export type FocusableDesktopWindow = {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
};

export function focusDesktopWindow(window: FocusableDesktopWindow | undefined) {
  if (!window || window.isDestroyed()) return false;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  return true;
}

export function createSecondInstanceFocusCoordinator(getWindow: () => FocusableDesktopWindow | undefined) {
  let focusPending = false;
  return Object.freeze({
    onSecondInstance() {
      if (!focusDesktopWindow(getWindow())) focusPending = true;
    },
    onWindowReady() {
      if (!focusPending) return false;
      focusPending = false;
      return focusDesktopWindow(getWindow());
    },
  });
}
