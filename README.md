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
3. Google Drive (image backup) — OAuth, not a service-account key (blocked by
   org policy on this account):
   - In Google Cloud Console, create an OAuth client ID (Application type: Web application)
   - Add `GOOGLE_REDIRECT_URI` (e.g. `http://localhost:4000/auth/google/callback`) as an authorized redirect URI on that client
   - Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `GOOGLE_DRIVE_FOLDER_ID` in `.env`
   - Start the server, open the Content Generator page, click **Connect Google Drive** — this fills in `GOOGLE_REFRESH_TOKEN` automatically
4. `npm start` — runs on `http://localhost:$PORT` (default 3000)

Until Google Drive is connected, image generation still works — the Drive
save step is skipped silently.
