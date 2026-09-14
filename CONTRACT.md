# PushNow v2 SDK Contract

This SDK is an account-bound E2EE client, not a token-only webhook wrapper.
It is a language binding to a bundled **Node.js 22 or newer** runtime, not a
native-language HPKE implementation. Node must be installed on the machine
running your application. The runtime uses the pinned, proven
[@hpke/core 1.9.0](https://www.npmjs.com/package/@hpke/core/v/1.9.0).
Use npm ci in runtime/ to install the exact transitive dependencies in the lockfile.
No global PushNow CLI installation or sibling repository directory is required.

## Trust and Authorization

1. Register and verify your email in PushNow, sign in on a trusted device, and
   initialize the account's encrypted archive.
2. Obtain the full 64-character SHA-256 account-root fingerprint through a
   trusted, independent channel, such as your already trusted app.
   Do not derive trust from the authorization response you are about to verify.
3. Construct a client with this pinned root fingerprint.
4. Begin authorization. Display only authorization.user_code and fingerprint
   (the sender public-key fingerprint) from the pending result.
5. Approve the code and matching sender fingerprint on your trusted device.
6. Complete authorization. The SDK decrypts the grant, checks the API origin,
   verifies the archive certificate and pinned root, then verifies the source
   private-key binding and recipient certificates before returning the config.

Authorization polls until approval or server expiry. HTTP 429 respects the
server polling interval, with a minimum of three seconds. Each HTTP request has
a 30-second deadline. The process deadline defaults to 660 seconds; cancellation
or expiry requires a new authorization if the grant has already been consumed.

The pending authorization contains a private key and a device code. The completed
config contains a source credential and sender private key. Keep both secret.
Store config in your application's secret store, OS keychain, or a mode-0600
file with appropriate Windows ACLs. The library does not automatically persist
either object. Never print a complete pending object or config.

The source credential selects an account and sender, but it does not by itself
provide E2EE. A complete verified config must also contain api_url, user_id,
source_id, identity_public_key, sender_private_key, and the pinned signed archive.
Every operation rechecks the independently supplied root pin. Recipient reads
verify account, source, archive and device certificates, and that the sender
private key matches the certified source public key.

## Operations

| Operation | Result |
| --- | --- |
| begin authorization | Pending grant, public user code and sender fingerprint |
| authorize | Verified E2EE config; retained on this client |
| recipients | Verified directory, with devices and signed archive |
| prepare | Encrypted v2 envelope; files uploaded, message not yet submitted |
| send | Object with envelope and result from submission |
| retry | Submission result for the exact previously prepared envelope |

Send and prepare accept the following notification fields. Python uses these
camelCase option names as keyword arguments; Java uses the same JSON names.
Go provides the corresponding exported fields in Notification.

| Field | Type / default | Meaning |
| --- | --- | --- |
| title | Required string | Full encrypted message title |
| body | String, empty | Full encrypted message body |
| links | Array of strings, empty | Links stored in the encrypted manifest |
| files | Array of file inputs, empty | Encrypted file attachments |
| images | Array of file inputs, empty | Image attachments; first is the preview image |
| icon | Optional file input | Icon attachment referenced by icon_id |
| deviceIds | Omitted, or array of IDs | Omitted means all eligible notification-enabled devices |
| pushEnabled | Boolean, true | false saves inbox-only without push deliveries |
| scheduledAt | Optional ISO timestamp | Future reminder time, at most 30 days from now |
| expiresAt | Optional ISO timestamp | Future delivery expiry, at most 30 days from now and after schedule |
| sound | Optional enum: default, silent, chime | Public notification sound metadata; omission preserves legacy behavior |

A file input has either path or dataBase64, plus name and mime. A path defaults
name to its basename; dataBase64 requires an explicit name. mime defaults to
application/octet-stream. Images and icons require an image/* MIME type.
File paths are local to the application machine. They are never fetched as URLs.
Use path for large files to avoid base64 expansion in the subprocess input.

At most 20 total files, images and icons are allowed. Each encrypted file is at
most 20 MiB, so plaintext is at most 20 MiB minus the 16-byte GCM tag. Full
encrypted message manifests are limited to 256 KiB. Preview text is shortened to
fit the notification budget; the full title and body remain in the archive.

The wire contract supports a single image_id and icon_id, not a gallery preview.
Sound is a top-level v2 routing field, never part of the encrypted body or preview.
default selects the system notification sound. silent omits aps.sound but keeps
the visible notification alert; it does not mean inbox-only. chime asks the backend
to use the bundled pushnow-chime.wav sound. Actual playback depends on the app
bundling that resource, device notification settings and OS behavior. Use
pushEnabled=false for inbox-only delivery. Unknown values, null, empty strings
and filenames supplied directly as sound fail with INVALID_SOUND before uploads.

Additional images remain ordinary downloadable encrypted attachments. The SDK
does not claim that every OS notification surface will display an icon or image.
The fixture image bytes test encryption and references, not OS image rendering.

## Targeting, Time and Retention

All devices share account archive history. Device targeting controls push
delivery, not who can read account history. Select one or several IDs returned
by recipients. Unknown IDs fail. Disabled devices remain disabled even if
selected. An explicit empty deviceIds array or pushEnabled=false means inbox-only.
Membership, credentials, device notification settings and active-session rules
remain enforced by the server.

Use complete timezone-qualified ISO timestamps, for example
2026-12-01T09:00:00Z or 2026-12-01T17:00:00+08:00 (choose a future date within
30 days when actually sending). Calendar-invalid dates, missing timezones,
past times and expiry at/before schedule are rejected. Inputs support seconds
and optional 1-3 fractional digits. The backend is authoritative for clock bounds.
Omitted schedule sends immediately. Omitted expiry uses the server's legacy
30-day transport expiry.

Scheduled messages are visible in history immediately. **Reading a scheduled
message does not cancel its explicitly requested reminder.** Reading an immediate
message can suppress its pending notification. Transport expiry stops delivery;
it does not remove retained encrypted account history. Key revocation or expiry
can suppress a pending delivery.

## Retry Without Duplicate Notifications

For durable sending, call prepare, save the returned envelope to an outbox,
then call retry with that same envelope and the same sender/account config.
Retry uses message_id as the Idempotency-Key and does not re-encrypt or regenerate
timestamps. An identical accepted request deduplicates even after its requested
time passes. A request that was never accepted may be rejected if its schedule
is now in the past. Changing payload fields with the same ID causes a conflict.

Do not call send repeatedly to recover an uncertain network outcome: each call
creates a new encrypted message with a new ID. The send convenience operation
returns its envelope only after submission succeeds. For crash-safe and
network-failure recovery, prepare plus durable outbox plus retry is required.
Prepare uploads files before returning; failed preparation may leave encrypted
orphan uploads for the server to expire.

Retry accepts a v2 CLI outbox for the same sender/account/archive. Do not transfer
outboxes between sender configs. Treat outboxes as private even though content
is encrypted: they retain routing and timing metadata.
The saved envelope retains sound exactly, including its absence. Do not change
sound when retrying: the backend includes explicitly supplied sound in its
idempotency hash and rejects a changed value for an accepted message ID with 409.
Omission preserves the old hash semantics. Sound is public metadata protected by
TLS and server request validation, not by the encrypted-content HPKE AAD.

## Encryption and Exposed Metadata

The vendored CLI core uses RFC 9180 HPKE Auth mode with DHKEM(P-256, HKDF-SHA256),
HKDF-SHA256, AES-256-GCM and info pushnow-v2. Message and preview AAD bind the
protocol version, purpose, account, source, message and archive IDs. Sender grants
use the existing HPKE base-mode grant contract and are checked against the
independently pinned account root. Device/source/archive certificates use
ECDSA P-256 SHA-256. No HPKE primitive is implemented by these bindings.

Files use independently generated AES-256-GCM keys and nonces. File AAD binds
account, source and attachment ID. File keys, names, MIME data and digest travel
inside the encrypted message manifest. The read capability is sent over TLS when
reserving an upload, stored hashed by the server, and conveyed to recipients in
the encrypted manifest. Files upload as ciphertext. Wrong-account AAD,
altered ciphertext and mismatched certificates
fail authentication. No plaintext fallback exists.

The API still sees account/source/device identifiers, schedule/expiry, sound, attachment
sizes and delivery metadata. TLS protects these transport fields; they are not
hidden by content E2EE. Device/account compromise or exposure of the private
sender configuration is outside this protection.

## Redacted Logs and Errors

Request logs contain only method, a fixed route label with dynamic IDs replaced
by :id, HTTP status (0 for network failure), and elapsedMs. They never include
headers, tokens, bodies, filenames, URLs with queries, grant codes, config or
ciphertext. Logs are local in-memory arrays; persist or forward them yourself
with your own retention policy. They are not the server's delivery log and
do not prove recipient-visible delivery.

Errors return bounded codes such as ROOT_PIN_REQUIRED, ROOT_PIN_MISMATCH,
E2EE_CONFIG_REQUIRED, INVALID_SCHEDULE, INVALID_EXPIRY, UNKNOWN_DEVICE,
INVALID_SOUND, HTTP_401, HTTP_409, HTTP_503 or BRIDGE_RUNTIME_FAILED. Cryptographic
or unexpected failures use E2EE_REQUEST_FAILED rather than echoing sensitive
exception details. Standard error from the bridge is not propagated.

HTTP acceptance, successful fixture tests and APNs acceptance do not prove a
visible notification. Actual device delivery also depends on server scheduling,
notification permission, provider setup, connectivity and OS behavior.

## Runtime, Testing and Distribution

Each language folder contains its own complete runtime and a pinned lockfile.
Keep that runtime alongside your application or pass its absolute main.js path.
The language process starts Node without a shell, passes secrets over stdin,
and captures only the structured reply. There is process-startup overhead per
operation. Use this in trusted server/desktop automation, not in iOS apps,
browsers, restricted serverless runtimes without Node, or untrusted multi-tenant
code-execution environments. Large attachments require sufficient local memory.

Use one client per thread/goroutine/task when calls overlap; config and logs are
mutable. Each language README provides setup, examples and executable tests.
Tests run against a loopback HTTP fixture with test-only automatic approval.
They decrypt a saved envelope generated by the actual repository CLI, reject
tampering, run the real language binding through authorization/send/retry,
decrypt uploaded files and inspect log redaction. They do not contact production
or send notifications to real users.

Upload the source folder with runtime/*.js, package.json, package-lock.json,
language source, documentation and tests. Exclude node_modules, compiled output,
downloaded JARs, private configs and outboxes (covered by each .gitignore).
Install dependencies on the destination machine. Nothing is published to a
package registry by these setup/build/test commands.
