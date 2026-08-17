# Store listing copy — Spelling Camp

Dated 15 August 2026. Resolves
[#144](https://github.com/fol2/ks2-spelling/issues/144). Locale is **en-GB**.
App Store Connect app `6798866142`, version 1.0
(`PREPARE_FOR_SUBMISSION`).

Every claim below cites shipped behaviour. Do not apply copy that promises
PIN recovery ([#140](https://github.com/fol2/ks2-spelling/issues/140)) or a
paywall moment ([#163](https://github.com/fol2/ks2-spelling/issues/163)).

## Locked fields

| Field | Value |
|---|---|
| Name (30) | `Spelling Camp` |
| Subtitle (30) | `Offline KS2 spelling practice` |
| Primary category | Education |
| Secondary category | none |
| Kids band | 9–11 (already set) |
| Age rating | 4+ (questionnaire output; do not raise) |
| Privacy Policy URL | `https://help.eugnel.uk/privacy` |
| Support URL | `https://help.eugnel.uk/` |
| Marketing URL | empty |
| Contact | `support@eugnel.uk` (Email Routing; not a listing field) |
| Home Screen name | `Spelling Camp` (`CFBundleDisplayName`; must match the listing) |

Name and subtitle were already live on the en-GB app-info localization
([#170](https://github.com/fol2/ks2-spelling/issues/170)). URLs replace the
GitHub placeholders. `ks2.eugnel.uk` is **KS2 Mastery** (a different product
with sign-in) and must never be this listing's marketing URL.

## Promotional text (170; evergreen)

```
Hear it, type it, master it. KS2 spelling for Years 3-6, with companions, a Word Bank, and a parent area. Offline. No accounts, ads or tracking.
```

144 characters. Editable without a new binary. Do not put a price or a
What's New story here.

## Keywords (100)

```
Key Stage 2,SATs,Year 3,Year 4,Year 5,Year 6,dictation,homework,statutory,revision,lists,test,words
```

99 characters, no spaces after commas. Indexed together with name and
subtitle, so this field does **not** repeat Spelling, Camp, Offline, KS2,
practice, or Education. No competitor names.

## Description

```
Spelling Camp is offline KS2 spelling practice for Years 3–6 (ages 7–11). Hear the word, type it, and make it stick — on this device, with no child account.

The free download includes 20 statutory spellings across both year bands, with companions that grow as words become secure. A one-time Full KS2 unlock adds the complete 213-word list and its audio. It downloads once, then practice stays offline.

Spell with confidence: hear it, type it, master it — including a slower replay.
Spell words and grow companions: practice unlocks companions, growth and a world to discover.
Every round is an adventure on the Trail — Smart Review, Trouble, a SATs-style assessed round, and Guardian.
Know every word in the Word Bank: see what is secure, learning or due, then open a word to hear it and practise.
Make spellings stick with Camp and Guardian, returning at the right time.
Learn from every try: clear feedback, and tricky words come back. See every step forward after each round.

Grown-ups stay in control. Learner profiles, weekly goals and progress stay on this device. Purchases live in the Parent area, not in front of the child. No advertising, analytics or tracking.
```

The nine body beats follow the nine `final-v3` screenshot overlays in order.
"SATs-style assessed round" is the in-app Trail mode `SATs Test`, not
official past papers. £9.99 is the IAP price in App Store Connect and must
not appear in this description (territories vary; the Parent area already
shows StoreKit's localised price).

## In-app purchase — Full KS2

| Field | Value |
|---|---|
| Product id | `uk.eugnel.ks2spelling.fullks2` |
| Type | non-consumable |
| Reference name | Full KS2 |
| Display name | `Full KS2` |
| Description | `All 213 KS2 spelling words, with offline audio. One-time unlock.` |
| Price | £9.99 (GBR; already set) |
| Promotional image | `assets/branding/iap-full-ks2-phaeton.png` |

The image is a **new-pose, 3D-toy icon reinterpretation** of Phaeton
stage 1. It is not the in-game sprite. 1024×1024 PNG, RGB, no alpha, no
letters. Current IAP state is `MISSING_METADATA` until this image is
uploaded.

## Screenshots

Authority: `design/app-store-screenshots/final-v3/` (nine iPhone 6.7-inch
`1320×2868`, nine iPad 13-inch `2064×2752`). Required order:

1. Spell with confidence.
2. Spell words. Grow companions.
3. Master spellings. Discover a world.
4. Every round is an adventure.
5. Know every word.
6. Make spellings stick.
7. Learn from every try.
8. See every step forward.
9. Grown-ups stay in control.

App Store Connect already holds these files on `APP_IPHONE_67` and
`APP_IPAD_PRO_3GEN_129` but **out of order**. Reorder to 01–09.
`APP_IPHONE_61` (six old welcome/practise shots) and
`APP_IPAD_PRO_3GEN_11` (one old welcome) must not ship; delete them.

## What this replaces on Connect

The live version localization is TestFlight residue and is false:

- Description still names the product KS2 Spelling and says store purchases
  are not enabled.
- Keywords repeat name/subtitle terms.
- Privacy, support and marketing URLs point at GitHub.

Replace them with the fields above. Do not leave the preview sentence in
place.

## Execution

Not this document's job. Apply as
[#188](https://github.com/fol2/ks2-spelling/issues/188), consumed by
[#171](https://github.com/fol2/ks2-spelling/issues/171):

1. Native Home Screen name → `Spelling Camp`.
2. App-info URLs; empty marketing URL; version localization copy.
3. IAP display name, description, promotional image.
4. Screenshot reorder and deletion of stale sets.

`help.eugnel.uk` must be live before submission
([#172](https://github.com/fol2/ks2-spelling/issues/172)). The listing
strings may be saved earlier; a reviewer who opens a dead support URL will
reject.
