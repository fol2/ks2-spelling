import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';

/* Fire-and-forget haptic feedback. Failures are swallowed: haptics are an
 * enhancement and must never block or fail the answer path. */
export function createCapacitorHaptics() {
  return Object.freeze({
    answerCorrect() {
      void Haptics.notification({ type: NotificationType.Success })
        .catch(() => undefined);
    },
    celebrationStart(kind = 'progress', stage = 0) {
      if (kind === 'caught') {
        void Haptics.notification({ type: NotificationType.Success })
          .catch(() => undefined);
        return;
      }
      const style = kind === 'evolve'
        ? (stage >= 4 ? ImpactStyle.Heavy : ImpactStyle.Medium)
        : ImpactStyle.Light;
      void Haptics.impact({ style }).catch(() => undefined);
    },
  });
}

export function createSilentHaptics() {
  return Object.freeze({
    answerCorrect() {},
    celebrationStart() {},
  });
}
