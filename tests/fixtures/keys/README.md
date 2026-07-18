# Public B3 signing test vector

`b3-public-test-vector-p256-private.pem` is the deliberately public RFC 6979
P-256 reproducibility fixture whose private scalar is
`C9AFA9D845BA75166B5C215767B1D6934E50C3DB36E89B127B8A622B120F6721`.

This fixture is test-only, public and non-secret. It must never be used as a
production signing key or imported into application, native, gateway or release
runtime code. Runtime bundles contain only the corresponding public SPKI from
`config/pack-signing-public-keys.json`.

Frozen fixture identities:

- PKCS#8 PEM SHA-256: `930c320433c65f7b500f06ebf5a2a31637b96e84bb1572e551c90054ed1dea49`
- SPKI DER SHA-256: `5a7a78cca4a0f420d9bc62bb669c3c2759e39f723d3ae10dcbe0f0815a07ecd4`
