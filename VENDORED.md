# Runtime Provenance

The six core JavaScript modules in runtime/ were copied from the PushNow
repository's cli/src/ on 2026-09-13. They are intentionally bundled locally so
this SDK has no runtime dependency on sibling SDK or CLI folders.
bridge.js and main.js are the language-binding adapter, not cryptographic primitives.
The v2-client snapshot includes the synchronized optional sound routing extension.

Snapshot SHA-256 checksums (run shasum -a 256 in runtime/ to compare):

```text
cc3732b1c65e8ef9afc9f118103cb85ae0647de9c0eb09e0aa94693d54cdb0d5  crypto.js
e6833d0e8739c1bbadecbb0d4a288fdf0318aac337b3899b63de6133d6f45835  client.js
1c421a780119c7f52da62f0bc2a4391b93ffa08ac864f6ef23c12e3a0cd926ba  v2-http.js
e818a28a486a6bf5c1fc2ac567cef06f00c81ba34ed621a1b213ed700222a107  v2-crypto.js
266db9acb7832638fb446658d9c9eb175e7043d5b2bde98da1fba98f53b08b6f  v2-auth.js
f164cf764fb55517a0360f3b438a3b209952bdc0945d8c8440420a7168c3157b  v2-client.js
```

The public bridge dispatches only v2 operations. client.js is included because
the core imports validateConfig from it; old manual authorization APIs are not exposed by
the language bindings.

Dependencies:
- @hpke/core 1.9.0, MIT: https://github.com/dajiaji/hpke-js
- @hpke/common 1.10.1, MIT, locked transitively in package-lock.json.
- Node's built-in WebCrypto provides ECDSA and AES-GCM.
- Java only: org.json:json:20250517, public domain:
  https://github.com/stleary/JSON-java/tree/20250517
  JAR SHA-256: 3ea61b2a06e31edf1c91134fe9106b0ebb16628be169f3db75bc7a2b06b45796

npm dependency license files are included in installed node_modules packages.
The source-upload folder excludes generated dependencies; destination setup
installs the locked packages with their licenses.

tests/cli-vector.json was generated using the actual repository
cli/test/v2-fixtures.js and cli/src/v2-client.js prepareMessageV2.
It contains ephemeral TEST-ONLY account/sender/archive private keys, a
CLI-generated authenticated ciphertext, and expected plaintext. These are not
production credentials. The loopback HTTP fixture issues test-only approvals
and independently decrypts each language binding's outgoing envelopes and files.
Tests never call production or send device notifications.

There is no implicit native-language crypto fallback. To migrate to native
HPKE in a future release, first pass these Auth-mode, certificate, grant, AAD,
attachment and HTTP tests without changing the server wire contract.
