import json
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pushnow import Client, PushNowError

request = json.load(sys.stdin)
client = Client(request["rootFingerprint"])
pending = client.begin_authorization(request["apiURL"], "Python integration")
client.authorize(pending)
directory = client.recipients()
envelope = client.prepare(**request["notification"])
first = client.retry(envelope)
second = client.retry(envelope)
sent = client.send(title="Immediate Python", body="Second message", sound="silent")
default_envelope = client.prepare(title="Default sound", sound="default")
legacy_envelope = client.prepare(title="Legacy sound")
errors = []
for options in [dict(title="No custom sound", sound="custom"),
                dict(title="Foreign", deviceIds=["00000000-0000-0000-0000-000000000000"])]:
    try:
        client.prepare(**options)
        raise AssertionError("Invalid notification accepted")
    except PushNowError as error:
        errors.append(str(error))
try:
    client.retry(dict(envelope, sound="silent"))
    raise AssertionError("Changed sound accepted with the same message ID")
except PushNowError as error:
    errors.append(str(error))
json.dump(dict(envelope=envelope, first=first, second=second, sent=sent,
               defaultEnvelope=default_envelope, legacyEnvelope=legacy_envelope,
               deviceCount=len(directory["devices"]), errors=errors,
               logs=client.request_logs), sys.stdout)
