from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PATH = ROOT / "tests/ios-dictation-input-session.test.mjs"
source = PATH.read_text()

old_setup = """  const [productRoot, productApp, sessionSource, sessionCss, keyboardChrome] = await Promise.all([
    readFile(join(ROOT, 'src/app/ProductRoot.jsx'), 'utf8'),
    readFile(join(ROOT, 'src/app/ProductApp.jsx'), 'utf8'),
    readFile(join(ROOT, 'src/platform/keyboard/ios-dictation-input-session.js'), 'utf8'),
    readFile(join(ROOT, 'src/app/ios-dictation-input-session.css'), 'utf8'),
    readFile(join(ROOT, 'src/platform/keyboard/capacitor-keyboard.js'), 'utf8'),
  ]);
"""
new_setup = """  const [productRoot, productApp, sessionSource, sessionCss, mainSource] = await Promise.all([
    readFile(join(ROOT, 'src/app/ProductRoot.jsx'), 'utf8'),
    readFile(join(ROOT, 'src/app/ProductApp.jsx'), 'utf8'),
    readFile(join(ROOT, 'src/platform/keyboard/ios-dictation-input-session.js'), 'utf8'),
    readFile(join(ROOT, 'src/app/ios-dictation-input-session.css'), 'utf8'),
    readFile(join(ROOT, 'src/main.jsx'), 'utf8'),
  ]);
"""
if source.count(old_setup) != 1:
    raise SystemExit("Expected one dictation test dependency setup block.")
source = source.replace(old_setup, new_setup, 1)

old_assertions = """  assert.match(keyboardChrome, /setAccessoryBarVisible\(\{ isVisible: false \}\)/);
  assert.match(keyboardChrome, /setScroll\(\{ isDisabled: false \}\)/);
  assert.doesNotMatch(
    keyboardChrome,
    /export function applyKeyboardChrome\(\) \{[^}]*setResizeMode/su,
  );
"""
new_assertions = """  assert.doesNotMatch(mainSource, /applyKeyboardChrome|@capacitor\\/keyboard/);
"""
if source.count(old_assertions) != 1:
    raise SystemExit("Expected one obsolete global Keyboard helper assertion block.")
source = source.replace(old_assertions, new_assertions, 1)
PATH.write_text(source)
