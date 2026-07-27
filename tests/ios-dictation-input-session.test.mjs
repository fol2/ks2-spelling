import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  closestMatching,
  installIOSDictationInputSession,
  isUsableControl,
  placementForRect,
  writeControlledInputValue,
} from '../src/platform/keyboard/ios-dictation-input-session.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

class ListenerTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type, event = {}) {
    if (event.type == null) event.type = type;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class FakeElement extends ListenerTarget {
  constructor(tagName, document) {
    super();
    this.tagName = tagName.toUpperCase();
    this.nodeType = 1;
    this.ownerDocument = document;
    this.parentElement = null;
    this.attributes = new Map();
    this.style = {};
    this.selectors = new Set();
    this.disabled = false;
    this.tabIndex = 0;
    this.rect = { left: 0, top: 0, width: 1, height: 1 };
    this.dispatched = [];
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  closest(selector) {
    return this.selectors.has(selector) ? this : null;
  }

  getBoundingClientRect() {
    return this.rect;
  }

  focus() {
    this.ownerDocument.activeElement = this;
    this.focusCount = (this.focusCount ?? 0) + 1;
  }

  blur() {
    if (this.ownerDocument.activeElement === this) {
      this.ownerDocument.activeElement = null;
    }
    this.blurCount = (this.blurCount ?? 0) + 1;
  }

  setSelectionRange(start, end) {
    this.selection = [start, end];
  }

  dispatchEvent(event) {
    this.dispatched.push(event);
    this.emit(event.type, event);
    return true;
  }

  click() {
    this.clickCount = (this.clickCount ?? 0) + 1;
    this.ownerDocument.emit('click', { target: this });
  }

  remove() {
    this.removed = true;
  }
}

class FakeInput extends FakeElement {
  constructor(document) {
    super('input', document);
    this._value = '';
    this.form = null;
  }

  get value() {
    return this._value;
  }

  set value(value) {
    this._value = String(value);
  }
}

class FakeDocument extends ListenerTarget {
  constructor() {
    super();
    this.documentElement = { dataset: {} };
    this.activeElement = null;
    this.queries = new Map();
    this.body = {
      children: [],
      append: (element) => {
        this.body.children.push(element);
      },
    };
  }

  createElement(tagName) {
    if (tagName !== 'input') throw new Error(`unexpected element ${tagName}`);
    return new FakeInput(this);
  }

  querySelector(selector) {
    return this.queries.get(selector) ?? null;
  }
}

function createView() {
  const document = new FakeDocument();
  let nextFrame = 1;
  let nextTimer = 1;
  const frames = new Map();
  const timers = new Map();
  const viewListeners = new ListenerTarget();
  const visualViewport = new ListenerTarget();

  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      view.observer = this;
    }

    observe(target, options) {
      this.target = target;
      this.options = options;
    }

    disconnect() {
      this.disconnected = true;
    }
  }

  class FakeEvent {
    constructor(type, options = {}) {
      this.type = type;
      Object.assign(this, options);
    }
  }

  const view = {
    document,
    HTMLInputElement: FakeInput,
    Event: FakeEvent,
    MutationObserver: FakeMutationObserver,
    visualViewport,
    requestAnimationFrame(callback) {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {
      frames.delete(id);
    },
    setTimeout(callback) {
      const id = nextTimer++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    addEventListener: viewListeners.addEventListener.bind(viewListeners),
    removeEventListener: viewListeners.removeEventListener.bind(viewListeners),
    flushFrame() {
      const queued = [...frames.values()];
      frames.clear();
      for (const callback of queued) callback();
    },
  };
  return view;
}


test('the product root owns the public-API iOS session and visual viewport layout', async () => {
  const [productRoot, sessionSource, sessionCss] = await Promise.all([
    readFile(join(ROOT, 'src/app/ProductRoot.jsx'), 'utf8'),
    readFile(join(ROOT, 'src/platform/keyboard/ios-dictation-input-session.js'), 'utf8'),
    readFile(join(ROOT, 'src/app/ios-dictation-input-session.css'), 'utf8'),
  ]);

  assert.match(productRoot, /observeKeyboardInset\(\)/);
  assert.match(productRoot, /Capacitor\.getPlatform\(\) === 'ios'/);
  assert.match(productRoot, /installIOSDictationInputSession\(\)/);
  assert.match(productRoot, /stopInputSession\(\)[\s\S]*stopInset\(\)/);

  assert.match(sessionSource, /sessionInput\.addEventListener\('pointerdown', onSessionPointerDown\)/);
  assert.match(sessionSource, /startButton\.click\(\)/);
  assert.match(sessionSource, /document\.addEventListener\('click', onDocumentActivation, true\)/);
  assert.match(sessionSource, /document\.addEventListener\('scroll', reposition, true\)/);
  assert.match(sessionSource, /document\.addEventListener\('focusin', onDocumentFocusIn, true\)/);
  assert.match(sessionSource, /writeControlledInputValue\(roundInput, buffered, view\)/);
  assert.match(sessionSource, /pauseRoundInputSession\(\)/);
  assert.doesNotMatch(sessionSource, /Keyboard\.show|keyboardDisplayRequiresUserAction/);

  assert.match(sessionCss, /--keyboard-inset/);
  assert.match(sessionCss, /data-dictation-input-session='round'/);
  assert.match(sessionCss, /data-room='tight'/);
});

test('small dictation-session helpers preserve geometry and controlled input events', () => {
  assert.deepEqual(
    placementForRect({ left: 12.5, top: 24, width: 0, height: 48 }),
    { left: '12.5px', top: '24px', width: '1px', height: '48px' },
  );
  assert.equal(isUsableControl({ disabled: false, getAttribute: () => null }), true);
  assert.equal(isUsableControl({ disabled: true, getAttribute: () => null }), false);
  assert.equal(
    closestMatching({ nodeType: 3, parentElement: { closest: () => 'button' } }, '.x'),
    'button',
  );

  const view = createView();
  const input = new FakeInput(view.document);
  assert.equal(writeControlledInputValue(input, 'bicycle', view), true);
  assert.equal(input.value, 'bicycle');
  assert.equal(input.dispatched.at(-1).type, 'input');
  assert.equal(input.dispatched.at(-1).bubbles, true);
});

test('one trusted Setup activation survives the async round mount', () => {
  const view = createView();
  const { document } = view;
  const startButton = new FakeElement('button', document);
  startButton.selectors.add('.setup-tray > .button-primary');
  startButton.rect = { left: 20, top: 700, width: 350, height: 54 };
  document.queries.set('.setup-tray > .button-primary', startButton);

  const stop = installIOSDictationInputSession(view);
  const sessionInput = document.body.children[0];
  assert.ok(sessionInput);

  // While Setup is idle, the stable field sits directly over the visual button
  // but stays out of the accessibility tree. A normal touch therefore lands on
  // a genuine text control; only the product action is forwarded to React.
  assert.equal(sessionInput.style.left, '20px');
  assert.equal(sessionInput.style.width, '350px');
  assert.equal(sessionInput.style.pointerEvents, 'auto');
  assert.equal(sessionInput.getAttribute('aria-hidden'), 'true');

  sessionInput.emit('pointerdown', { target: sessionInput });
  assert.equal(document.activeElement, sessionInput);
  assert.equal(document.documentElement.dataset.dictationInputSession, 'armed');
  assert.equal(sessionInput.getAttribute('aria-hidden'), null);

  sessionInput.emit('click', { target: sessionInput });
  assert.equal(startButton.clickCount, 1);
  sessionInput.emit('click', { target: sessionInput });
  assert.equal(startButton.clickCount, 1, 'the transparent field shields double starts');

  // A quick learner can type while storage is still starting the round. The
  // stable input holds those letters until React's controlled input exists.
  sessionInput.value = 'bicy';
  sessionInput.emit('input', { target: sessionInput });

  const roundInput = new FakeInput(document);
  roundInput.rect = { left: 45, top: 240, width: 300, height: 58 };
  const submit = { disabled: false };
  const form = {
    submittedWith: null,
    querySelector: () => submit,
    requestSubmit(control) {
      this.submittedWith = control;
    },
  };
  roundInput.form = form;
  document.queries.set('#product-spelling-input', roundInput);

  view.observer.callback();
  view.flushFrame();

  assert.equal(document.body.children[0], sessionInput, 'the input node must not remount');
  assert.equal(document.activeElement, sessionInput, 'the first-responder session is retained');
  assert.equal(document.documentElement.dataset.dictationInputSession, 'round');
  assert.equal(roundInput.value, 'bicy');
  assert.equal(roundInput.dispatched.at(-1).type, 'input');
  assert.equal(roundInput.getAttribute('aria-hidden'), 'true');
  assert.equal(roundInput.style.pointerEvents, 'none');
  assert.equal(sessionInput.style.left, '45px');
  assert.equal(sessionInput.style.pointerEvents, 'auto');

  roundInput.rect.left = 72;
  document.emit('scroll', { target: new FakeElement('div', document) });
  assert.equal(sessionInput.style.left, '72px', 'internal scene scrolling keeps the overlay aligned');

  sessionInput.value = 'bicycle';
  sessionInput.emit('input', { target: sessionInput });
  assert.equal(roundInput.value, 'bicycle');

  let prevented = false;
  sessionInput.emit('keydown', {
    key: 'Enter',
    preventDefault: () => { prevented = true; },
  });
  assert.equal(prevented, true);
  assert.equal(form.submittedWith, submit);

  const endRound = new FakeElement('button', document);
  endRound.selectors.add('.round-foot button');
  document.emit('click', { target: endRound });
  assert.equal(document.documentElement.dataset.dictationInputSession, 'paused');
  assert.equal(document.activeElement, null);
  assert.equal(sessionInput.style.pointerEvents, 'none');

  const keepRound = new FakeElement('button', document);
  keepRound.selectors.add('.exit-confirmation .button-quiet');
  document.emit('pointerup', { target: keepRound });
  assert.equal(
    document.documentElement.dataset.dictationInputSession,
    'paused',
    'pointerup must not put the transparent field above the dialog before click',
  );
  document.emit('click', { target: keepRound });
  assert.equal(document.documentElement.dataset.dictationInputSession, 'round');
  assert.equal(document.activeElement, sessionInput);
  assert.equal(sessionInput.style.pointerEvents, 'auto');

  // React's dialog effect may restore the previously focused End button after
  // the click has bubbled. The short focus guard immediately gives first
  // responder ownership back to the already re-opened spelling input.
  endRound.focus();
  document.emit('focusin', { target: endRound });
  assert.equal(document.activeElement, sessionInput);

  document.queries.delete('#product-spelling-input');
  document.queries.delete('.setup-tray > .button-primary');
  view.observer.callback();
  view.flushFrame();
  assert.equal(document.documentElement.dataset.dictationInputSession, undefined);
  assert.equal(document.activeElement, null);
  assert.equal(roundInput.getAttribute('aria-hidden'), null);
  assert.equal(roundInput.style.pointerEvents ?? '', '');

  stop();
  assert.equal(sessionInput.removed, true);
  assert.equal(view.observer.disconnected, true);
});
