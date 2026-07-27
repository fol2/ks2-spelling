import { Keyboard } from '@capacitor/keyboard';

/* iOS gives every WKWebView text field the system form accessory bar — the
 * `‹ › ✓` strip above the keys. A spelling round has one field and its own
 * Submit button, so the bar is three controls that do nothing but take the
 * bottom of the card. WebKit exposes no web API for it, and a native effect
 * cannot be reached from inside the page, so the plugin is the only seam.
 *
 * Do NOT force KeyboardResize.None here. @capacitor/keyboard already removes
 * the WKWebView’s own keyboard frame observers on load (see Keyboard.m). Pairing
 * that with ResizeMode.None has left physical iPhones without a software
 * keyboard for ordinary inputs (learner name, Words search, and dictation).
 * Leave Capacitor’s default native resize so keys can rise; round layout still
 * reads --keyboard-inset from the visual viewport when a session is active.
 *
 * Also pin scroll back on: a stuck disableScroll leaves the WebView unable to
 * bring focused fields into view with the keys.
 *
 * Fire-and-forget and silent on failure: neither call is implemented on web, on
 * Android there is no such bar to hide, and a keyboard that keeps its chrome
 * must never stop the app from starting.
 */
export function applyKeyboardChrome() {
  void Keyboard.setAccessoryBarVisible({ isVisible: false })
    .catch(() => undefined);
  void Keyboard.setScroll({ isDisabled: false })
    .catch(() => undefined);
}
