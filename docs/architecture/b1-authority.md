# B1 Source Authority and Boundaries

## Frozen upstream authority

| Evidence | Frozen value |
|---|---|
| Upstream repository | `https://github.com/fol2/ks2-mastery.git` |
| Gate A merged commit | `4501607a9b58f2fb252b4cce64ba056e6f60c630` |
| Gate A tree | `129ba457cccf21df03f4be813b4f4ed6e7d9f6ad` |
| A3 contract manifest | `content/spelling.mobile-a3-contract-manifest.json` |
| A3 manifest SHA-256 | `7fea17613ee10f747c1cfa9d5c923da4e506e23e61d1530ca71c283c0ce39465` |
| Runtime entry | `shared/spelling/mobile/a3/index.js` |
| Runtime closure | Exactly the 24 files enumerated by `.runtime.files` in the A3 manifest |
| Starter catalogue | `content/spelling.mobile-runtime-starter.json` |
| Starter catalogue SHA-256 | `a67317764d1bae4e1796e070fa8d482c0b4702451c63ba7cacf9470c5272eb34` |
| Starter catalogue size | Exactly 20 items |
| Full catalogue | `content/spelling.mobile-runtime-full.json` |
| Full catalogue SHA-256 | `50918c93043eba984cb2472238ac9370be4f46fb52a55c76cf5c469beb330d84` |
| Full catalogue size | Exactly 213 items |

These values identify the only approved source input for the later B1 vendor
step. Task 1 records the authority but does not vendor or execute the upstream
runtime.

## Import boundary

Later import work must copy the manifest-selected bytes from the frozen Git
commit. The mobile repository must not depend on a sibling checkout, symlink,
Git submodule, workspace link, remote runtime or unpublished shared package.
Each later update requires an explicit import commit with refreshed commit,
tree and hash evidence.

## Local-first and release boundary

Application code must be bundled into the installed application. Production
builds must not load remote HTML or JavaScript and must not configure a
Capacitor `server.url`. B1 does not approve accounts, cloud progress,
analytics, advertising, SQLite, billing, downloads, production native plugins,
release signing, store records, deployment or production readiness.

## B2 continuation

B1 remains the immutable repository and native-shell entry authority. B2's
separate transactional persistence and lifecycle authority is documented in
[`b2-persistence-authority.md`](b2-persistence-authority.md). B2 does not alter
the frozen B1 commit, tree, hosted run or evidence hashes recorded above.
