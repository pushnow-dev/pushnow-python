"""Account-bound PushNow v2 SDK. Requires the bundled Node.js 22+ runtime."""
import json
from pathlib import Path
import subprocess


class PushNowError(Exception):
    """A redacted error code; server bodies and credentials are never included."""


class Client:
    def __init__(self, root_fingerprint, config=None, *, node="node", runtime=None,
                 timeout=660):
        self.root_fingerprint = root_fingerprint
        self.config = config
        self.node = node
        self.runtime = Path(runtime) if runtime else Path(__file__).parent / "runtime" / "main.js"
        self.timeout = timeout
        self.request_logs = []

    def _call(self, operation, **arguments):
        payload = dict(operation=operation, rootFingerprint=self.root_fingerprint,
                       config=self.config, **arguments)
        try:
            result = subprocess.run(
                [self.node, str(self.runtime.resolve())], input=json.dumps(payload),
                capture_output=True, text=True, timeout=self.timeout, check=False,
            )
            if result.returncode:
                raise PushNowError("BRIDGE_RUNTIME_FAILED")
            reply = json.loads(result.stdout)
        except (OSError, subprocess.TimeoutExpired, ValueError, TypeError):
            raise PushNowError("BRIDGE_RUNTIME_FAILED") from None
        self.request_logs.extend(reply.get("logs", []))
        if not reply.get("ok"):
            raise PushNowError(reply.get("error", {}).get("code", "E2EE_REQUEST_FAILED"))
        return reply["data"]

    def begin_authorization(self, api_url, name):
        """Return pending credentials plus the public user_code and sender fingerprint."""
        return self._call("beginAuthorization", apiURL=api_url, name=name)

    def authorize(self, pending):
        """Poll approval, verify the pinned account root, and retain E2EE config."""
        self.config = self._call("finishAuthorization", pending=pending)
        return self.config

    def recipients(self):
        return self._call("recipients")

    def prepare(self, *, title, body="", **options):
        """Encrypt/upload without submitting. Persist this outbox for exact retries."""
        return self._call("prepare", notification=dict(title=title, body=body, **options))

    def send(self, *, title, body="", **options):
        """Return {envelope, result}. For crash-safe sending use prepare then retry."""
        return self._call("send", notification=dict(title=title, body=body, **options))

    def retry(self, envelope):
        """Submit the same encrypted envelope and Idempotency-Key without re-encrypting."""
        return self._call("retry", envelope=envelope)
