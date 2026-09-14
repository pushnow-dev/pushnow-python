"""Run after authorize.py. Keeps an encrypted outbox for exact retries."""
import json
import os
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pushnow import Client

client = Client(os.environ['PUSHNOW_ROOT_FINGERPRINT'], json.loads(Path('private-config.json').read_text()))
outbox = Path('outbox.json')
if outbox.exists():
    envelope = json.loads(outbox.read_text())
else:
    envelope = client.prepare(title='Build finished', body='Your artifact is ready.')
    fd = os.open(outbox, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as handle:
        json.dump(envelope, handle)
result = client.retry(envelope)
print('API accepted:', result['message_id'], 'deduplicated:', result['deduplicated'])
print('Keep this outbox for retries; create a new outbox for a new message.')
