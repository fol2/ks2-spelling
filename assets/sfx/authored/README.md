# Authored product SFX

`retry.wav` is a repository-owned, 24 kHz mono PCM WAV feedback cue. It is
not produced by the offline synthesizer.

It was generated on 24 August 2026 with the ElevenLabs
`eleven_text_to_sound_v2` sound-generation API on the product owner's paid
plan, then re-encoded through `encodeWavPcm16Mono` so public hashes stay
canonical.

The in-round `correct` sting is no longer authored. It is synthesised by
`scripts/lib/product-sfx-synthesis.mjs` as a one-shot winning arpeggio,
then copied into `public/sfx/` by `scripts/generate-product-sfx.mjs`.

| Cue | Listening candidate | Prompt summary |
| --- | --- | --- |
| `retry` | M buzzer | Classic TV quiz-show wrong: two-tone descending buzzer, sitting-room volume. |

`scripts/generate-product-sfx.mjs` copies authored bytes into `public/sfx/`
and writes synthesised cues beside them.
`scripts/verify-product-sfx.mjs` re-reads them and byte-compares.
