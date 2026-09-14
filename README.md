# PushNow Python SDK

[中文说明](README.zh-CN.md)

Python 3.10+ and **Node.js 22+** are required. This is a subprocess binding to the
bundled, pinned HPKE runtime, not native Python cryptography. No Python runtime
dependencies are needed. Read [CONTRACT.md](CONTRACT.md) for the complete API,
trust model, attachment limits, errors, scheduling and retry semantics.

## Local Setup

Run from this folder:

```sh
npm --prefix runtime ci --ignore-scripts
python3 -m unittest discover -s tests -p 'test_*.py'
npm --prefix runtime test
```

Install from PyPI after publication:

```sh
pip install pushnow
```

For local development, `pip install .` installs the Python package and bundled
runtime bridge. Run `npm --prefix pushnow/runtime ci --ignore-scripts` after
installation or source checkout to install the pinned HPKE dependency beside the
bridge runtime.

## Authorize With an Account Token

```python
import os
from pushnow import Client

client = Client()
pending = client.begin_account_authorization(
    'https://api.pushnow.dev',
    os.environ['PUSHNOW_ACCESS_TOKEN'],
    'Python automation',
)
print(pending['authorization']['user_code'])  # Public approval code only.
print(pending['fingerprint'])                 # Sender fingerprint.
config = client.authorize_account(pending)    # Waits for approval; do not print.
```

Use an access token from a signed-in PushNow app or trusted dashboard session.
The token only creates an account-bound authorization; it cannot encrypt
messages by itself. Store the returned config securely for reuse.
[examples/authorize.py](examples/authorize.py) creates a new mode-0600 config
file without overwriting an existing one.

## Send and Retry

```python
client = Client(config, runtime='/absolute/path/to/runtime/main.js')
devices = client.recipients()['devices']
outbox = client.prepare(
    title='Build finished', body='The artifact is ready.', sound='chime',
    deviceIds=[devices[0]['id']],
    links=['https://example.com/build/123'],
    files=[{'path': '/tmp/report.pdf', 'mime': 'application/pdf'}],
    images=[{'path': '/tmp/preview.png', 'mime': 'image/png'}],
    icon={'path': '/tmp/icon.png', 'mime': 'image/png'},
)
# Persist outbox securely before attempting submission.
result = client.retry(outbox)
```

Omit deviceIds for all eligible devices. `pushEnabled=False` or `deviceIds=[]`
saves inbox-only. `scheduledAt` and `expiresAt` accept future timezone-qualified
ISO strings within 30 days. Option names are camelCase, matching the JSON wire
terminology. `sound='default'`, `sound='silent'` and `sound='chime'` are supported
public routing options. Omit sound to use the default behavior. `sound=None` and unknown
values fail with `INVALID_SOUND` before uploads. Silent keeps the visible alert;
chime maps to the app's `pushnow-chime.wav`. Neither changes inbox-only settings.

`client.send(title='Ready', body='Done')` is the one-call convenience API and returns
`{'envelope': ..., 'result': ...}`. Use prepare/persist/retry for durable recovery
from an uncertain response. Request logs are available in `client.request_logs`.
Catch `PushNowError` for redacted codes; do not log config or pending objects.

`node=` selects a Node executable and `timeout=` overrides the 660-second process
deadline. A timeout does not prove that the server rejected a message. Retry the
saved envelope to resolve an uncertain outcome.

## Example Commands

```sh
export PUSHNOW_ACCESS_TOKEN='your signed-in account access token'
python3 examples/authorize.py
python3 examples/send.py
```

The send example reads `private-config.json`, saves a private encrypted outbox,
then submits it. Source upload should exclude both files and node_modules.
