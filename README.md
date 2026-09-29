# Digital Content — Arambhika Enablers

Content Generator for Instagram/LinkedIn: generates on-brand product images
(BytePlus ModelArk), drafts captions/posts (Claude), and publishes directly
to Instagram and LinkedIn. Every generated image is also saved to Google
Drive automatically.

## Pages

- `login.html` — password gate (session-based)
- `image-generator.html` — Content Generator (Instagram + LinkedIn)
- `products.html` — product catalog used as generation reference images

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in:
   - `ANTHROPIC_API_KEY`, `BYTEPLUS_API_KEY`
   - Instagram (`IG_ACCESS_TOKEN`, `IG_USER_ID`) and LinkedIn OAuth app credentials
   - `DB_PATH` — point at the shared product-catalog SQLite DB (same one the CRM app uses), or leave unset to create a local `shopmanager.db`
3. Google Drive (image backup):
   - Create a Google Cloud service account, enable the Drive API, download its JSON key
   - Save that key locally at the path set in `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` (default `./google-service-account.json`) — **never commit this file**, it's gitignored
   - Share the target Drive folder with the key's `client_email` as Editor
   - Set `GOOGLE_DRIVE_FOLDER_ID` to that folder's ID
4. `npm start` — runs on `http://localhost:$PORT` (default 3000)

Until the Drive service-account key is in place, image generation still
works — the Drive save step is skipped silently.
