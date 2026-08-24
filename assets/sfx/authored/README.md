# Authored product SFX

`correct.wav` and `retry.wav` are repository-owned, 24 kHz mono PCM WAV
feedback cues. They are not produced by the offline synthesizer.

They were generated on 24 August 2026 with the ElevenLabs
`eleven_text_to_sound_v2` sound-generation API on the product owner's paid
plan, then re-encoded through `encodeWavPcm16Mono` so public hashes stay
canonical.

| Cue | Listening candidate | Prompt summary |
| --- | --- | --- |
| `correct` | J ding-ding-ding | Classic British TV quiz-show correct: three bright ascending bells. |
| `retry` | M buzzer | Classic TV quiz-show wrong: two-tone descending buzzer, sitting-room volume. |

`scripts/generate-product-sfx.mjs` copies these bytes into `public/sfx/`.
`scripts/verify-product-sfx.mjs` re-reads them and byte-compares.
