import { Keyboard } from '@capacitor/keyboard';

/*
 * Legacy diagnostic seam only.
 *
 * The installed Capacitor Keyboard plugin already starts iOS in its configured
 * resize mode (native when no override is present) and owns the form accessory
 * bar. Product startup must therefore not call this helper: app-wide runtime
 * mutations have repeatedly coupled unrelated fields to spelling-round polish.
 * `tests/ios-keyboard-ownership.test.mjs` rejects any runtime import.
 *
 * Keep this bounded helper for native proof work that explicitly needs to
 * re-assert the old chrome settings. It must be exercised on a physical device
 * before any product caller is added.
 */
export function applyKeyboardChrome() {
  void Keyboard.setAccessoryBarVisible({ isVisible: false })
    .catch(() => undefined);
  void Keyboard.setScroll({ isDisabled: false })
    .catch(() => undefined);
}
