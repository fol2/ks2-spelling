export const DEFAULT_TTS_PROVIDER = 'openai';

export const TTS_PROVIDER_IDS = Object.freeze([
  'openai',
  'gemini',
  'browser',
]);

export function normaliseTtsProvider(value, fallback = DEFAULT_TTS_PROVIDER) {
  const provider = String(value || '').trim().toLowerCase();
  if (TTS_PROVIDER_IDS.includes(provider)) return provider;
  return TTS_PROVIDER_IDS.includes(fallback) ? fallback : DEFAULT_TTS_PROVIDER;
}

export const BUFFERED_GEMINI_VOICE_OPTIONS = Object.freeze([
  Object.freeze({
    id: 'Iapetus',
    role: 'male',
    label: 'Pre-cached UK male',
    blurb: 'Clear',
  }),
  Object.freeze({
    id: 'Sulafat',
    role: 'female',
    label: 'Pre-cached UK female',
    blurb: 'Warm',
  }),
]);

export const DEFAULT_BUFFERED_GEMINI_VOICE = BUFFERED_GEMINI_VOICE_OPTIONS[0].id;

export function bufferedVoiceById(voiceId) {
  return BUFFERED_GEMINI_VOICE_OPTIONS.find((voice) => voice.id === voiceId) || null;
}

export function normaliseBufferedGeminiVoice(value, fallback = DEFAULT_BUFFERED_GEMINI_VOICE) {
  const voiceId = String(value || '').trim();
  if (bufferedVoiceById(voiceId)) return voiceId;
  return bufferedVoiceById(fallback) ? fallback : DEFAULT_BUFFERED_GEMINI_VOICE;
}
