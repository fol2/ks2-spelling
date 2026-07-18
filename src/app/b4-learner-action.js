export function createB4LearnerAction({
  controller,
  readState,
  readAnswer,
  onState,
  onAnswer,
  onBusy,
  onError,
}) {
  if (!controller || typeof controller !== 'object') {
    throw new TypeError('B4 learner controller is required.');
  }
  for (const [label, value] of Object.entries({
    readState,
    readAnswer,
    onState,
    onAnswer,
    onBusy,
    onError,
  })) {
    if (typeof value !== 'function') throw new TypeError(`${label} must be a function.`);
  }
  let busy = false;

  async function submit(event) {
    event?.preventDefault?.();
    if (busy) return;
    busy = true;
    onBusy(true);
    try {
      const state = readState();
      if (state.phase !== 'session' && state.phase !== 'summary') {
        const error = new Error('The spelling round is not ready.');
        error.code = 'b4_round_not_ready';
        throw error;
      }
      let next;
      if (state.phase === 'summary') {
        next = await controller.freshRound();
      } else if (state.awaitingAdvance === true) {
        next = await controller.continue();
      } else {
        const answer = readAnswer().trim();
        if (answer === '') {
          const error = new Error('Type the spelling before submitting.');
          error.code = 'b4_round_answer_required';
          throw error;
        }
        next = await controller.submit(answer);
      }
      onAnswer('');
      onState(next);
    } catch (error) {
      onError(error);
    } finally {
      busy = false;
      onBusy(false);
    }
  }

  return Object.freeze({ submit });
}
