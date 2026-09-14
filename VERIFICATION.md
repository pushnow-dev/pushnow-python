# Local Verification

Verified on 2026-09-13. No production endpoints, real user accounts or device
notifications were used. No registry publication or deployment was performed.

- Locked Node dependencies installed successfully.
- Actual CLI-generated HPKE Auth ciphertext decrypted with the bundled runtime.
- Altered ciphertext and wrong message/account/source AAD rejected.
- Token-only configuration and invalid sound rejected.
- default, silent and chime travel as public metadata, outside body/preview ciphertext.
- Omitted sound stays absent; exact retries retain sound and changed-sound retries conflict.
- Real language binding ran against a loopback HTTP fixture.
- Authorization grant decrypted and the account root independently verified.
- Verified recipients, inbox-only scheduling and explicit expiry preserved.
- Encrypted files, image preview and icon references decrypted and checked.
- Identical outbox retries preserved the request and deduplicated.
- Convenience send defaulted to all eligible devices.
- Unknown device IDs rejected.
- Logs contained only method, route, status and elapsedMs.
- Server error content was not exposed in returned errors.
- Account-token authorization was verified before sending.

The HTTP fixture automatically approves TEST credentials. This is not a bypass
in the SDK or a production authorization test. OS notification display and APNs
delivery require separate device QA.

See README.md for exact setup and test commands. The examples compile or import,
but production send/authorization examples were intentionally not executed.
