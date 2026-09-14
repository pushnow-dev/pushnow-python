"""Run from the SDK folder. Creates a private local config after phone approval."""
import json
import os
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pushnow import Client

client = Client(os.environ['PUSHNOW_ROOT_FINGERPRINT'])
pending = client.begin_authorization('https://api.pushnow.dev', 'Python automation')
print('Approve code:', pending['authorization']['user_code'])
print('Compare sender fingerprint:', pending['fingerprint'])
config = client.authorize(pending)
fd = os.open('private-config.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as handle:
    json.dump(config, handle)
print('Authorized. Private configuration stored locally.')
