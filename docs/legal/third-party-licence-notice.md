# Third-party licence notice

Review date: 23 July 2026

`THIRD_PARTY_NOTICES.md` is the deterministic identity, version, source,
distribution-role and declared-licence inventory. It covers npm, SwiftPM and
Maven inputs and distinguishes packaged runtime components from build and test
tools.

The packaged WebView closure is Capacitor Community SQLite, Capacitor App,
Capacitor Core, React, React DOM and Scheduler. The packaged iOS closure also
includes Capacitor SwiftPM, SQLCipher.swift and ZIPFoundation. The packaged
Android closure is the exact release-runtime set recorded by the dependency
audit; its accepted licence classes are Apache-2.0, BSD-3-Clause and the
platform Android SDK licence.

The final distribution assembly must retain the exact upstream copyright and
licence texts required by these components and expose the notice inventory
through the release listing or installed distribution as appropriate. The
Task 22 release proof verifies those assembled bytes; the C5 development
candidate does not turn a repository inventory into a signed-store claim.
