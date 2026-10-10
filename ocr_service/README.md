# ExpiryMitra PaddleOCR service

This is a small, separate Python HTTP service. It accepts date-label photos in memory, preprocesses them, and returns PaddleOCR 3.x text lines with available recognition confidence. It does not save product/date records and never marks a date confirmed. The existing Express date-label workflow parses its response and requires shopkeeper confirmation.

## Local setup

Use a clean **64-bit Python 3.9–3.13** environment with current pip. PaddlePaddle's official install guide currently lists Windows 10/11 64-bit x86_64 and Python 3.9–3.13. This service pins the CPU runtime; PaddleOCR may download its pretrained recognition/detection models on first start, so allow network access and disk space for its model cache.

From the repository root in PowerShell:

```powershell
py -3.11 -m venv .venv-ocr
.\.venv-ocr\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install paddlepaddle==3.3.0 -i https://www.paddlepaddle.org.cn/packages/stable/cpu/
python -m pip install -r ocr_service/requirements.txt
python -m uvicorn app:app --app-dir ocr_service --host 127.0.0.1 --port 8000
```

Set `PADDLE_OCR_URL=http://127.0.0.1:8000/ocr` in the **Node server's private environment**. If using service authentication, set the same high-entropy `PADDLE_OCR_TOKEN` in both the Node and Python service environments. Keep these values out of frontend JavaScript and source control. Without `PADDLE_OCR_URL`, the existing Tesseract/OCR.space configuration remains in use.

The Python service allows JPEG, PNG and WebP, up to 8 MB. It makes a short-lived temporary JPEG for the documented PaddleOCR path-based `predict()` API and removes it after each request. `/health` reports model readiness without exposing internal paths. `/docs` is disabled.

## Existing Express integration

The existing authenticated `POST /api/scan/dates` endpoint continues to accept its existing JSON data URL. Express forwards that image to `PADDLE_OCR_URL` as multipart form data. OCR text and confidence flow into date extraction; parser ambiguity and confirmation behavior stay in the current Express workflow. If the Python request fails or times out, the existing configured OCR provider remains the fallback. Gemini continues to be server-side and optional.

## Render deployment notes

Do not expose an OCR service publicly. Deploy `ocr_service/` as a separate Render **private service** in the same region as the Node service (a free web service cannot receive private-network requests). Build command: `pip install -r requirements.txt`; start command: `python -m uvicorn app:app --host 0.0.0.0 --port $PORT`. Configure `PADDLE_OCR_URL` on Node to the Python service's internal URL plus `/ocr`; set the same random `PADDLE_OCR_TOKEN` on both services. Pin `PYTHON_VERSION` to a supported 3.11/3.12 runtime. The current Render plan is not visible from this checkout, so memory suitability cannot be certified. PaddlePaddle plus pretrained models need substantially more memory, CPU and cold-start time than the existing Node service; test on the intended paid instance and monitor first model download/cache size before production use. This repository change does not alter Render configuration or deploy anything.

## Tests

With the Python dependencies installed, run `python -m unittest discover -s ocr_service/tests`. Tests replace the model with a fake engine and verify HTTP validation and failure handling; they do not count as a genuine model inference test. Use a real packaging photo locally to validate recognition quality before deployment.
