# 🌿 ExpiryMitra — Complete Grocery Inventory & Expiry Management

ExpiryMitra is a modern, full-stack grocery inventory, expiry date tracking, and POS sales application. It combines mobile-first UI design inspired directly by grocery store workflows with computer vision OCR, Google Gemini AI, Firebase Firestore persistence, and real-time inventory management.

---

## 📱 12 Screens Visual Architecture (Matching Reference Specification)

1. **Screen 1: Splash / Welcome**
   - Brand logo and header (`EM ExpiryMitra`).
   - Fresh grocery basket illustration with countdown clock.
   - Core value proposition: *"Track • Prioritize • Sell Before It Expires"*.
   - Onboarding indicators and *"Get Started →"* action.

2. **Screen 2: Authentication & Store Setup**
   - Role selector toggle: **Shopkeeper** vs **Customer**.
   - Store registration and contact inputs (*Shop Name*, *Phone/Email*, *Password* with visibility eye toggle).
   - *Remember me*, *Forgot Password*, and *Continue with Google* authentication.
   - Client and server Firebase Authentication integration with local session fallback.

3. **Screen 3: Dashboard**
   - Personalized shopkeeper greeting: *"Good Morning, Shopkeeper! 👋 Sharma Store"*.
   - Quick notification bell and user initials avatar chip.
   - Grocery stock banner: *"Track your stock, reduce waste and sell smarter"*.
   - 4 Live Metric Cards (2x2 grid): **Total Products** (128), **Expiring Soon** (7), **Expired** (2), **Low Stock** (5).
   - *"Needs Attention"* urgent products list with one-tap status badges.
   - Floating Bottom Navigation: **Home**, **Inventory**, **Scan**, **Alerts**, **Profile**.

4. **Screen 4: Inventory**
   - Live search bar by product name, barcode, category, and batch number.
   - Filter pills: **All**, **Expiring Soon**, **Expired**, **Low Stock**.
   - Product cards displaying high-res thumbnail, batch, quantity, expiry date, days remaining, and color-coded status badges (*2 days*, *10 days*, *18 days*, *26 days*, *1 day*, *Safe*).
   - Three-dots action menu for Quick Sell, Add Stock, Edit, and Delete.

5. **Screen 5: Add Product / Scan Barcode**
   - Dual-tab workflow: **Scan Barcode** and **Manual Entry**.
   - Live camera viewfinder frame with corner brackets and animated laser scanning line.
   - Upload Photo option and Preset Barcode loader.
   - Auto-matched *"Product Found"* card preview with thumbnail, name, variant, and edit shortcut.
   - Stepper quantity control (*- 50 +*), batch number, and expiry date picker.

6. **Screen 6: Product Details**
   - Hero card with large centered product package artwork, title, brand, and stock status badge (*● In Stock*).
   - Segmented navigation: **Overview**, **Stock History**, and **Sales**.
   - 6-box information grid: Batch No, Expiry Date, Quantity, Days Left, Category, Product No.
   - 4 Action tiles: **Record Sale** (orange), **Add Stock** (green), **Edit Product** (grey), **Delete** (red).

7. **Screen 7: Record Sale**
   - Product summary card showing available stock and current expiry status.
   - Large touch-friendly quantity stepper (*— 5 +*).
   - Real-time price breakdown and revenue total calculation.
   - Concurrency-safe stock deduction and sale transaction creation.
   - Strict validation preventing selling beyond available stock.

8. **Screen 8: Expiry Alerts**
   - Filter count pills: **All (9)**, **Critical (2)**, **Soon (5)**, **Expired (2)**.
   - Products grouped by urgency with remaining days countdowns (*Expires in 2 days*, *Expires in 1 day*, *Expired*).

9. **Screen 9: Scan Result & OCR Expiry Reader**
   - Displays captured photo or barcode viewfinder with detected barcode chip.
   - Raw OCR text extracted by Tesseract.js / OCR.space.
   - Candidate manufacturing date, candidate expiry date, and batch number.
   - AI interpretation and confidence meter (e.g. *96% Confident*).
   - Fully editable fields allowing user review and correction before database persistence.

10. **Screen 10: Sales Dashboard**
    - Time filter pills: **Today**, **This Week**, **This Month**.
    - Summary stat cards: **Total Sales** (18) and **Total Revenue** (₹1,440).
    - Recent sales list with item names, quantities, transaction timestamps, and amounts in ₹.

11. **Screen 11: My Store / Profile**
    - Store storefront hero card (*Sharma Store*, *9876543210*) with Edit button.
    - Menu navigation: **Store Details**, **Manage Products**, **Sales History**, **Expiry Alerts**, **System & Database Health**, **Settings**, **Help & Support**, **Logout**.

12. **Screen 12: Final Branding / Welcome Section**
    - High-res vector artwork of shopkeeper holding tablet in front of grocery shelves.
    - ExpiryMitra motto: *"Smart inventory. Less waste. Happier businesses."*

---

## 🏗️ Technical Architecture & Backend Flow

```
[ Camera / Photo Upload / Barcode Input ]
         │
         ├── 1. Barcode Lookup (Local Catalog / Open Food Facts API)
         │
         └── 2. Expiry Label Image (POST /api/scan)
                     │
                     ▼
             ┌───────────────┐
             │ Real OCR      │ ──► Tesseract.js (Offline) / OCR.space (Cloud)
             └───────┬───────┘
                     │ (Raw Extracted Text)
                     ▼
             ┌───────────────┐
             │ AI Analysis   │ ──► Google Gemini API (Structured JSON) /
             │               │     Deterministic Regex Engine (Fallback)
             └───────┬───────┘
                     │
                     ▼
             ┌───────────────┐
             │ Validation    │ ──► Format check, Mfg < Exp, Confidence score
             └───────┬───────┘
                     │
                     ▼
             [ User Review & Confirm ]
                     │
                     ▼
             ┌─────────────────────────┐
             │ Persistence Layer       │ ──► Google Cloud Firestore (Admin SDK)
             │                         │     or Local Dev JSON Storage
             └─────────────────────────┘
```

---

## 💾 Documented Firestore Database Schema

The database is structured into 7 collections:

### 1. `users`
- `uid` (string): Firebase Auth User ID.
- `name` (string): Full name.
- `email` (string): User email address.
- `role` (string): `"shopkeeper"` or `"customer"`.
- `store_id` (string): Associated store reference.
- `created_at` (string ISO timestamp).

### 2. `stores`
- `id` (string): Store ID (e.g. `"store_default"`).
- `store_name` (string): e.g. `"Sharma Store"`.
- `phone` (string): Contact number.
- `email` (string): Contact email.
- `owner_uid` (string): Owner reference.
- `address` (string): Store location address.
- `settings` (map): `{ expiry_warning_days: 7, low_stock_threshold: 5, currency: "INR" }`.
- `updated_at` (string ISO timestamp).

### 3. `products`
- `id` (string): `prod_<barcode>`.
- `barcode` (string): EAN-13, UPC, or custom barcode.
- `name` (string): Product title (e.g. `"Maggi 2-Minute Noodles"`).
- `variant` (string): Packaging details (e.g. `"Masala, 70g"`).
- `brand` (string): Manufacturer (e.g. `"Nestle"`).
- `category` (string): Category (e.g. `"Packaged Food"`).
- `price` (number): Unit selling price in ₹.
- `image_url` (string): Relative or hosted asset URL.
- `created_at` / `updated_at` (string ISO timestamps).

### 4. `inventory`
- `id` (string): Unique inventory batch ID (e.g. `"inv_amul_b102"`).
- `store_id` (string): Store ownership ID.
- `barcode` (string): Product barcode reference.
- `product_name` (string): Cached product name.
- `brand` (string): Brand name.
- `category` (string): Food category.
- `batch` (string): Batch or Lot code (e.g. `"B102"`).
- `mfg_date` (string | null): Manufacturing date (`YYYY-MM-DD`).
- `expiry_date` (string): Expiry date (`YYYY-MM-DD`).
- `quantity` (number): Current available stock units.
- `min_threshold` (number): Minimum low-stock warning threshold.
- `confidence` (number | null): OCR/AI confidence score (0.0 to 1.0).
- `source` (string): `"ocr"` or `"manual"`.
- `review_status` (string): `"confirmed"`.
- `created_at` / `updated_at` (string ISO timestamps).

### 5. `categories`
- `id` (string): `"dairy"`, `"packaged"`, `"beverages"`, `"grains"`, etc.
- `name` (string): Human-readable name.
- `icon` (string): Category emoji icon.

### 6. `scan_history`
- `id` (string): Audit scan event ID.
- `barcode` (string): Scanned barcode.
- `product_name` (string): Matched name.
- `ocr_status` (string): `"success"`, `"empty"`, or `"failed"`.
- `raw_text` (string): Raw unparsed OCR text.
- `candidate_mfg_date` (string | null).
- `candidate_expiry_date` (string | null).
- `confidence` (number).
- `source` (string): `"tesseract"`, `"gemini_ai"`, or `"deterministic_parser"`.
- `timestamp` (string ISO timestamp).

### 7. `sales`
- `id` (string): Unique sale transaction ID (e.g. `"sale_01"`).
- `store_id` (string): Store ID.
- `inventory_id` (string): Target inventory item.
- `barcode` (string): Product barcode.
- `product_name` (string): Item sold.
- `batch` (string): Batch code sold.
- `quantity_sold` (number): Units sold.
- `unit_price` (number): Price per unit in ₹.
- `total_amount` (number): Total transaction value (`unit_price * quantity_sold`).
- `timestamp` (string ISO timestamp).

---

## 🚀 Windows & VS Code Quick Start

### 1. Open Terminal in VS Code
Open the project directory in VS Code or PowerShell:
```powershell
cd c:\Users\ADMIN\OneDrive\Desktop\mainprojectfile\DemoOfExpiryMitra
```

### 2. Install Dependencies (if not already installed)
```powershell
npm install
```

### 3. Run Backend Test Suite
Verify that all 35 unit, feature, and HTTP API integration tests pass:
```powershell
npm test
```

### 4. Start the Application
Run in development mode (with auto-reload):
```powershell
npm run dev
```
Or start in standard mode:
```powershell
npm start
```

### 5. Open in Web Browser
Open your browser and navigate to:
```
http://localhost:3000
```
- The application starts on **Screen 1 (Splash)**. Click **"Get Started →"** to access **Screen 2 (Login)**, then click **"Login"** to enter the **Dashboard (Screen 3)**.
- Use the bottom navigation bar or dashboard cards to explore **Inventory**, **Scan**, **Alerts**, **Sales**, and **Profile**.

---

## ⚙️ Configuration (.env)

The server can run locally with the JSON persistence adapter, local Tesseract OCR engine, and deterministic date parser. Protected app APIs require a signed-in Firebase account; without Firebase Authentication configuration, login and signup return a configuration error instead of creating a fake session.

To enable live Google Cloud Firestore, Google Gemini AI, or OCR.space, create a `.env` file from `.env.example`:

```powershell
copy .env.example .env
```

### 1. Firebase Firestore Setup
1. Go to [Firebase Console](https://console.firebase.google.com/) and create a project.
2. Under **Build**, click **Firestore Database** -> **Create Database** (Start in production or test mode).
3. Under **Project Settings** -> **Service accounts**, click **Generate new private key** (downloads a JSON file).
4. Fill in `.env`:
   ```env
   STORAGE_PROVIDER=auto
   FIREBASE_PROJECT_ID=your-project-id
   FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@your-project.iam.gserviceaccount.com
   FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nYOUR_KEY_HERE\n-----END PRIVATE KEY-----\n"
   FIREBASE_WEB_API_KEY=your-firebase-web-api-key
   ```
4. In Firebase Console, enable **Authentication → Email/Password**. The Web API key is read by the server for Firebase email/password sign-in; it is not embedded in frontend code. Each signup creates one shopkeeper-owned store keyed to that account. No account can choose an administrative role.

### Production deployment
- Configure the Firebase service account variables and `FIREBASE_WEB_API_KEY` in the hosting provider's environment settings. Do not commit a real `.env` file.
- Use Firestore for production persistence (`STORAGE_PROVIDER=firestore` or `auto` with valid Firebase credentials). The local JSON adapter is intended for development and tests; on hosts with ephemeral filesystems, JSON changes can be lost on restart or redeploy.
- Keep Firebase Authentication's Email/Password provider enabled. The health endpoint reports storage configuration but does not prove that live sign-in credentials work; verify login against the configured Firebase project after deployment.

### 2. Google Gemini AI Setup
1. Get a free API key at [Google AI Studio](https://aistudio.google.com/).
2. Fill in `.env`:
   ```env
   GEMINI_API_KEY=your_gemini_key_here
   GEMINI_MODEL=gemini-1.5-flash
   ```

### Barcode identification web-search fallback
- Set `GROQ_API_KEY` in the server environment. The key is read only by the Express backend and is never sent to the browser.
- Browser search uses `GROQ_BROWSER_SEARCH_MODEL=openai/gpt-oss-20b` by default. See [Groq's Browser Search model and request documentation](https://console.groq.com/docs/tool-use/built-in-tools/browser-search) for supported models.
- `GROQ_PRODUCT_LOOKUP_TIMEOUT_MS` defaults to 6500 ms. Groq results stay unverified suggestions and include source links; a shopkeeper must confirm them before they enter the catalogue.
- The existing Gemini product-photo fallback requires `GEMINI_API_KEY`. Set `GEMINI_PRODUCT_MODEL` to a currently supported [Gemini API model](https://ai.google.dev/gemini-api/docs/models) if the fallback is enabled. The retired `gemini-1.5-flash` default may fail.

### 3. OCR Engine Configuration
- **Default**: `OCR_PROVIDER=tesseract` runs completely locally without external network requests or keys.
- **Cloud OCR**: Set `OCR_PROVIDER=ocr_space` and supply `OCR_API_KEY` from [ocr.space](https://ocr.space/ocrapi).

---

## 🧪 Testing Summary

The project includes 35 comprehensive automated tests:
1. **Date Parser**: Tests DD/MM/YYYY, textual months, MM/YYYY end-of-month, relative months from MFG, leap years, and format rejections.
2. **OCR Service**: Tests text normalization, multi-line label joiners, mock test payload, and empty payload handling.
3. **AI & Deterministic Parser**: Tests label extraction (MFG, EXP, BATCH), relative expiry logic, and low-confidence ambiguity flags.
4. **Validation Service**: Tests confidence thresholds, date ordering (mfg < exp), and format validation.
5. **Inventory Service**: Tests status computation (`safe`, `expiring_soon`, `expired`, `low_stock`), full CRUD lifecycle, and summary aggregation.
6. **Sales Transactions & Atomic Stock**: Tests stock decrementing, insufficient stock rejection, revenue calculation, and duplicate click prevention.
7. **Product Catalog**: Tests catalog search, barcode lookup, create, update, and delete.
8. **Store Profile**: Tests profile fetching and updating.
9. **HTTP API & End-to-End**: Tests static frontend delivery, `/health`, `/api/health`, `/api/inventory`, `/api/products`, `/api/sales`, and `/api/store`.
