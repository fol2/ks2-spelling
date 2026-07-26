import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';

/* Fire-and-forget haptic feedback. Failures are swallowed: haptics are an
 * enhancement and must never block or fail the answer path. */
export function createCapacitorHaptics() {
  return Object.freeze({
    answerCorrect() {
      void Haptics.notification({ type: NotificationType.Success })
        .catch(() => undefined);
    },
    celebrationStart() {
      void Haptics.impact({ style: ImpactStyle.Medium })
        .catch(() => undefined);
    },
  });
}

export function createSilentHaptics() {
  return Object.freeze({
    answerCorrect() {},
    celebrationStart() {},
  });
}
