# Third-party licence notice

Review date: 23 July 2026

This document is the current C5 product licence authority. It identifies the
third-party components in the current product candidate and the release work
that remains before store distribution.

`THIRD_PARTY_NOTICES.md` remains the generated B3 technical dependency audit.
It supplies exact identities, versions, sources, distribution roles and
declared licences for npm, SwiftPM and Maven inputs. Its B3 sandbox mode and
gateway statements are historical certification context; they do not describe
ProductApp's runtime mode or network endpoints.

The packaged WebView closure is Capacitor Community SQLite, Capacitor App,
Capacitor Core, React, React DOM and Scheduler. The packaged iOS closure also
includes Capacitor SwiftPM, SQLCipher.swift and ZIPFoundation. The packaged
Android closure is the exact release-runtime set recorded by the dependency
audit; its accepted licence classes are Apache-2.0, BSD-3-Clause and the
platform Android SDK licence.

## Bundled artwork

`content/mastery-art/` holds the painted companion stages and Scribe Downs
plates the product surfaces render. They were copied from the frozen upstream
authority `fol2/ks2-mastery` at commit `dff6f57f8bf0b24e960c46d712afdbcf59c54b7d`
and are the same first-party work as the rest of that project; they are not a
licensed third-party asset pack. `provenance/ks2-mastery-art.json` records the
upstream path, Git blob identity and SHA-256 of every imported file, so the
bytes in this repository can be re-verified against that authority.

The native icon and launch artwork in `assets/branding/` remain separate
repository-owned sources and are unaffected by this import.

## Bundled fonts

`src/app/fonts/` holds two Latin-subset variable web fonts that the product
type rule depends on. Both carry the SIL Open Font License 1.1, which permits
redistribution inside an application:

| Font | Role | Licence |
| --- | --- | --- |
| Fraunces | Content and figures | SIL OFL 1.1 |
| Inter | Interface chrome | SIL OFL 1.1 |

They are packaged locally so the application renders its own typography with no
remote stylesheet and no network request, which the local-only shell test
enforces against the built output.

## Release assembly

The final distribution assembly must retain the exact upstream copyright and
licence texts required by these components — including the two OFL font
licences — and expose the notice inventory through the release listing or
installed distribution as appropriate. The Task 22 release proof verifies those
assembled bytes; the C5 development candidate does not turn a repository
inventory into a signed-store claim.
