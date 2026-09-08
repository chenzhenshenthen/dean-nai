"""No live account requests: verify the desktop proxy preserves the V5 usage payload."""
import json
import unittest
import tempfile
from pathlib import Path
from functools import partial
from database import connect
from io import BytesIO
from unittest.mock import patch
from urllib.error import HTTPError

from app import app
from nai_token import normalize_novelai_token, has_novelai_token_format


class SubscriptionProxyTest(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        isolated = patch("app.connect", partial(connect, Path(folder.name) / "library.db"))
        isolated.start()
        self.addCleanup(isolated.stop)

    def test_image_service_returns_usage_unchanged(self):
        payload = {"tier": 3, "usage": {"percent": 73.25, "isNegative": False}}
        response = BytesIO(json.dumps(payload).encode())
        response.status = 200
        response.headers = {"content-type": "application/json"}
        with patch("app.urllib.request.urlopen", return_value=response) as request:
            result = app.test_client().post("/api/novelai/subscription", json={"token": "pst-offline-test"})
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json, payload)
        self.assertEqual(request.call_args.args[0].full_url, "https://image.novelai.net/user/subscription")
        self.assertEqual(request.call_count, 1)
        upstream = request.call_args.args[0]
        self.assertEqual(upstream.get_header("Authorization"), "Bearer pst-offline-test")
        self.assertEqual(upstream.get_header("User-agent"), "deanai/2.0.0")
        self.assertEqual(upstream.get_header("Content-type"), "application/json")
        self.assertEqual(upstream.get_header("Accept"), "application/json")
        self.assertEqual(request.call_args.kwargs, {"timeout": 30})
        self.assertIn("no-store", result.headers["Cache-Control"])

    def test_wrapped_token_reaches_header_intact(self):
        response = BytesIO(b'{"tier":3}')
        response.status = 200
        response.headers = {}
        with patch("app.urllib.request.urlopen", return_value=response) as upstream:
            result = app.test_client().post("/api/novelai/subscription", json={"token": ' "Bearer Bearer pst-offline-\n test" '})
        self.assertEqual(result.status_code, 200)
        self.assertEqual(upstream.call_args.args[0].get_header("Authorization"), "Bearer pst-offline-test")

    def test_copy_cleanup_and_mask_rejection(self):
        self.assertEqual(normalize_novelai_token("pst-AbC_123+/=-test"), "pst-AbC_123+/=-test")
        for token in ["", "pst-", "pst-...", "••••••", "******", "pst-abc…", "pst-abc***", "pst-" + "a" * 4096]:
            with self.subTest(token=token[:10]), patch("app.urllib.request.urlopen") as upstream:
                self.assertFalse(has_novelai_token_format(token))
                self.assertEqual(app.test_client().post("/api/novelai/subscription", json={"token": token}).status_code, 400)
                upstream.assert_not_called()

    def test_malformed_payload_is_rejected_locally(self):
        for payload in [["pst-offline"], {"token": 123}]:
            with patch("app.urllib.request.urlopen") as upstream:
                self.assertEqual(app.test_client().post("/api/novelai/subscription", json=payload).status_code, 400)
                upstream.assert_not_called()

    def test_rate_limit_is_not_retried(self):
        error = HTTPError("https://image.novelai.net/user/subscription", 429, "Too Many Requests", {"content-type": "application/json"}, BytesIO(b'{"error":"rate limited"}'))
        with patch("app.urllib.request.urlopen", side_effect=error) as request:
            result = app.test_client().post("/api/novelai/subscription", json={"token": "pst-offline-test"})
        self.assertEqual(result.status_code, 429)
        self.assertEqual(request.call_count, 1)

    def test_invalid_token_does_not_call_upstream(self):
        with patch("app.urllib.request.urlopen") as request:
            result = app.test_client().post("/api/novelai/subscription", json={"token": "invalid"})
        self.assertEqual(result.status_code, 400)
        request.assert_not_called()


if __name__ == "__main__":
    unittest.main()
