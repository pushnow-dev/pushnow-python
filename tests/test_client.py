import unittest
from pushnow import Client, PushNowError


class RuntimeTests(unittest.TestCase):
    def test_missing_runtime_returns_redacted_error(self):
        with self.assertRaisesRegex(PushNowError, "^BRIDGE_RUNTIME_FAILED$"):
            Client("0" * 64, node="/missing/pushnow-node").recipients()

    def test_token_only_config_is_not_e2ee(self):
        client = Client("0" * 64, {"source_key": "must-not-appear"})
        with self.assertRaisesRegex(PushNowError, "^E2EE_CONFIG_REQUIRED$"):
            client.recipients()
        self.assertEqual(client.request_logs, [])


if __name__ == "__main__":
    unittest.main()
