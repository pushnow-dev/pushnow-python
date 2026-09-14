"""Run from the SDK folder. Creates a private local config after phone approval."""
import json
import os
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pushnow import Client

client = Client()
pending = client.begin_account_authorization('https://api.pushnow.dev', os.environ['PUSHNOW_ACCESS_TOKEN'], 'Python automation')
print('Approve code:', pending['authorization']['user_code'])
print('Sender fingerprint:', pending['fingerprint'])
config = client.authorize_account(pending)
fd = os.open('private-config.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as handle:
    json.dump(config, handle)
print('Authorized. Private configuration stored locally.')
