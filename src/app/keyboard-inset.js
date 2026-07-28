// The product originally measured visualViewport and published keyboard height
// plus a data-room="tight" signal. That second layout system squeezed the
// dictation card even though the round already reserves its keyboard area.
//
// Keep this tiny integration seam so ProductRoot has one stable teardown shape,
// but deliberately leave viewport geometry to the designed round layout and to
// WebKit's native keyboard presentation.
export function observeKeyboardInset() {
  return () => {};
}
