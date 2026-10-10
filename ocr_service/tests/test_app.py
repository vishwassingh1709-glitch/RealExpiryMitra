import io
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from PIL import Image

import app as ocr_app


def image_bytes():
    buffer = io.BytesIO()
    Image.new("RGB", (300, 100), "white").save(buffer, format="JPEG")
    return buffer.getvalue()


class FakeResult:
    json = {"res": {"rec_texts": ["EXP 08/2027"], "rec_scores": [0.97]}}


class EmptyResult:
    json = {"res": {"rec_texts": [], "rec_scores": []}}


class OcrEndpointTests(unittest.TestCase):
    def setUp(self):
        ocr_app.app.state.model_ready = True
        self.client = TestClient(ocr_app.app)

    def upload(self, content=None, content_type="image/jpeg"):
        return self.client.post("/ocr", files={"file": ("label.jpg", content or image_bytes(), content_type)})

    def test_valid_image_returns_text_and_confidence(self):
        engine = type("Engine", (), {"predict": lambda self, path: [FakeResult()]})()
        with patch.object(ocr_app, "get_engine", return_value=engine):
            response = self.upload()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["lines"], [{"text": "EXP 08/2027", "confidence": 0.97}])

    def test_rejects_invalid_content_type(self):
        response = self.upload(content_type="application/pdf")
        self.assertEqual(response.status_code, 415)

    def test_rejects_invalid_image_bytes(self):
        response = self.upload(b"not an image")
        self.assertEqual(response.status_code, 422)

    def test_empty_ocr_is_an_empty_result_not_a_fabricated_match(self):
        engine = type("Engine", (), {"predict": lambda self, path: [EmptyResult()]})()
        with patch.object(ocr_app, "get_engine", return_value=engine):
            response = self.upload()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["lines"], [])
        self.assertEqual(response.json()["text"], "")

    def test_ocr_failure_is_sanitized(self):
        engine = type("Engine", (), {"predict": lambda self, path: (_ for _ in ()).throw(RuntimeError("private path"))})()
        with patch.object(ocr_app, "get_engine", return_value=engine):
            response = self.upload()
        self.assertEqual(response.status_code, 503)
        self.assertNotIn("private path", response.text)

    def test_rejects_oversized_image(self):
        with patch.object(ocr_app, "MAX_IMAGE_BYTES", 10):
            response = self.upload()
        self.assertEqual(response.status_code, 413)

    def test_service_token_is_required_when_configured(self):
        with patch.dict("os.environ", {"PADDLE_OCR_TOKEN": "test-token"}):
            self.assertEqual(self.upload().status_code, 401)
            with patch.object(ocr_app, "get_engine", side_effect=RuntimeError("model unavailable")):
                response = self.client.post(
                    "/ocr",
                    files={"file": ("label.jpg", image_bytes(), "image/jpeg")},
                    headers={"Authorization": "Bearer test-token"},
                )
        self.assertEqual(response.status_code, 503)  # No model loaded in this isolated auth check.


if __name__ == "__main__":
    unittest.main()
