import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';

function fireAndForget(operation) {
  try {
    void Promise.resolve(operation()).catch(() => undefined);
  } catch {
    // Native feedback is optional. A synchronous bridge failure must be just as
    // harmless as a rejected plugin promise.
  }
}

/* Fire-and-forget haptic feedback. Failures are swallowed: haptics are an
 * enhancement and must never block or fail the answer path. */
export function createCapacitorHaptics() {
  return Object.freeze({
    answerCorrect() {
      fireAndForget(() => Haptics.notification({
        type: NotificationType.Success,
      }));
    },
    celebrationStart(kind = 'progress', stage = 0) {
      if (kind === 'caught') {
        fireAndForget(() => Haptics.notification({
          type: NotificationType.Success,
        }));
        return;
      }
      const style = kind === 'evolve'
        ? (stage >= 4 ? ImpactStyle.Heavy : ImpactStyle.Medium)
        : ImpactStyle.Light;
      fireAndForget(() => Haptics.impact({ style }));
    },
  });
}

export function createSilentHaptics() {
  return Object.freeze({
    answerCorrect() {},
    celebrationStart() {},
  });
}
