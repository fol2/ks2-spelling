import { Keyboard, KeyboardResize } from '@capacitor/keyboard';

/* iOS gives every WKWebView text field the system form accessory bar — the
 * `‹ › ✓` strip above the keys. A spelling round has one field and its own
 * Submit button, so the bar is three controls that do nothing but take the
 * bottom of the card. WebKit exposes no web API for it, and a native effect
 * cannot be reached from inside the page, so the plugin is the only seam.
 *
 * The plugin's own resize is switched off in the same breath. Its default
 * shrinks the whole WebView, which would take the backdrop art down with the
 * card; `keyboard-inset.js` gives the keyboard its room from inside the page
 * instead, so the art still fills the phone and only the card compacts.
 *
 * Both are properties of the WebView rather than of a screen, so this runs once
 * at startup. Setting the mode here rather than in `capacitor.config.json`
 * keeps that file byte-identical to its sealed B2 policy hash.
 *
 * Fire-and-forget and silent on failure: neither call is implemented on web, on
 * Android there is no such bar to hide, and a keyboard that keeps its chrome
 * must never stop the app from starting.
 */
export function applyKeyboardChrome() {
  void Keyboard.setAccessoryBarVisible({ isVisible: false })
    .catch(() => undefined);
  void Keyboard.setResizeMode({ mode: KeyboardResize.None })
    .catch(() => undefined);
}
