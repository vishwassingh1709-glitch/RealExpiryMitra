# Practice build map

## Shivam

### Phase 1
Camera opens.

### Phase 2
Barcode is detected.

### Phase 3
Expiry image is captured.

### Phase 4
`POST /api/scan` is called with:

```json
{
  "barcode": "REAL_BARCODE",
  "image": "BASE64_JPEG"
}
```

### Phase 5
Result is shown.

---

## Vishwas

Backend:

```text
server
  ↓
routes
  ↓
controllers
  ↓
scan.service
  ├── product.service
  ├── ocr.service
  ├── ai.service
  ├── validation.service
  └── inventory.service
```

The OCR and AI services are deliberately mock implementations in this practice build.

---

## Yashashvi

The practice UI shows:
- scan screen
- barcode state
- captured image
- result
- confirmation
- manual entry
- inventory

---

## Suryansh

Use real physical products to practice:
- barcode detection
- expiry-image capture
- readable/unreadable expiry cases
- manual fallback
- inventory result

---

## Oct 10

Rebuild the actual hackathon project in the fresh repository.

Do not treat this practice repository as the final submission.
