"""Small in-memory PaddleOCR HTTP service for ExpiryMitra date-label photos."""

import hmac
import io
import os
import tempfile
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, File, Header, HTTPException, UploadFile
from PIL import Image, ImageOps, UnidentifiedImageError

MAX_IMAGE_BYTES = 8 * 1024 * 1024
ALLOWED_CONTENT_TYPES = {"image/jpeg", "image/png", "image/webp"}
MODEL_LOCK = __import__("threading").Lock()
ocr_engine = None

app = FastAPI(title="ExpiryMitra OCR", docs_url=None, redoc_url=None)


def create_engine():
    # Import lazily so validation and unit tests do not download/load models.
    from paddleocr import PaddleOCR

    return PaddleOCR(
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=True,
        engine="paddle",
    )


def get_engine():
    global ocr_engine
    if ocr_engine is None:
        with MODEL_LOCK:
            if ocr_engine is None:
                ocr_engine = create_engine()
    return ocr_engine


@app.on_event("startup")
def initialize_model():
    # Warm the singleton once before accepting requests. Model download/startup
    # failures leave /ocr returning a sanitized 503 instead of fake OCR data.
    try:
        get_engine()
    except Exception:
        app.state.model_ready = False
    else:
        app.state.model_ready = True


def require_service_token(authorization: Optional[str]) -> None:
    configured = os.getenv("PADDLE_OCR_TOKEN", "")
    if not configured:
        return
    supplied = authorization[7:] if authorization and authorization.startswith("Bearer ") else ""
    if not hmac.compare_digest(supplied, configured):
        raise HTTPException(status_code=401, detail="Service authentication failed")


def preprocess_image(image_bytes: bytes) -> Path:
    """Correct EXIF orientation, boost stamp contrast, and enlarge small labels."""
    try:
        with Image.open(io.BytesIO(image_bytes)) as source:
            if source.width * source.height > 30_000_000:
                raise HTTPException(status_code=413, detail="Image dimensions exceed the supported limit")
            image = ImageOps.exif_transpose(source).convert("RGB")
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise HTTPException(status_code=422, detail="The uploaded file is not a readable image") from exc

    image = ImageOps.autocontrast(image, cutoff=1)
    longest = max(image.size)
    if longest < 1400:
        factor = min(3.0, 1400 / max(longest, 1))
        image = image.resize((round(image.width * factor), round(image.height * factor)), Image.Resampling.LANCZOS)
    # PaddleOCR's documented predict API accepts a local image path. The file
    # exists only during this request and is removed even on inference errors.
    temporary = tempfile.NamedTemporaryFile(prefix="expiry-label-", suffix=".jpg", delete=False)
    path = Path(temporary.name)
    temporary.close()
    try:
        image.save(path, format="JPEG", quality=95)
        return path
    except Exception:
        path.unlink(missing_ok=True)
        raise


def flatten_results(results: Any) -> list[dict[str, Any]]:
    """Extract text and confidence from PaddleOCR 3.x prediction JSON."""
    lines: list[dict[str, Any]] = []
    for result in results or []:
        payload = getattr(result, "json", result)
        if callable(payload):
            payload = payload()
        if not isinstance(payload, dict):
            continue
        payload = payload.get("res", payload)
        texts = payload.get("rec_texts", []) if isinstance(payload, dict) else []
        scores = payload.get("rec_scores", []) if isinstance(payload, dict) else []
        for index, text in enumerate(texts if isinstance(texts, list) else []):
            value = str(text).strip()
            if not value:
                continue
            score = scores[index] if isinstance(scores, list) and index < len(scores) else None
            try:
                confidence = max(0.0, min(1.0, float(score))) if score is not None else None
            except (TypeError, ValueError):
                confidence = None
            lines.append({"text": value, "confidence": confidence})
    return lines


@app.get("/health")
def health():
    return {"status": "ok", "model_ready": bool(getattr(app.state, "model_ready", False))}


@app.post("/ocr")
async def recognize(file: UploadFile = File(...), authorization: Optional[str] = Header(default=None)):
    require_service_token(authorization)
    if file.content_type not in ALLOWED_CONTENT_TYPES:
        raise HTTPException(status_code=415, detail="Upload a JPEG, PNG, or WebP image")
    try:
        image_bytes = await file.read(MAX_IMAGE_BYTES + 1)
    finally:
        await file.close()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="The uploaded image is empty")
    if len(image_bytes) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Image exceeds the 8 MB limit")

    image_path = preprocess_image(image_bytes)
    try:
        results = get_engine().predict(str(image_path))
        lines = flatten_results(results)
        return {"lines": lines, "text": "\n".join(line["text"] for line in lines)}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=503, detail="OCR processing is temporarily unavailable") from exc
    finally:
        image_path.unlink(missing_ok=True)
