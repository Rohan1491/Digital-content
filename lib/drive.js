// ── Google Drive — save every generated image ───────────────────
// Service-account auth (no per-click OAuth): the key file is local-only,
// gitignored, and the target folder must be shared with the service
// account's client_email as Editor before uploads will succeed.
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { google } = require('googleapis');

const KEY_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || path.join(__dirname, '..', 'google-service-account.json');
const FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;

let driveClient = null;
function getDrive() {
  if (driveClient) return driveClient;
  if (!fs.existsSync(KEY_PATH)) return null;
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_PATH,
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  });
  driveClient = google.drive({ version: 'v3', auth });
  return driveClient;
}

// Returns { id, link } on success, or null if Drive isn't configured yet
// (missing key file or folder id) — callers should treat that as a no-op,
// not an error, so image generation keeps working before Drive is set up.
async function uploadImageFromUrl(url, filename) {
  const drive = getDrive();
  if (!drive || !FOLDER_ID) return null;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download generated image (${res.status})`);
  const buffer = Buffer.from(await res.arrayBuffer());

  const file = await drive.files.create({
    requestBody: { name: filename, parents: [FOLDER_ID] },
    media: { mimeType: res.headers.get('content-type') || 'image/png', body: Readable.from(buffer) },
    fields: 'id, webViewLink',
  });
  return { id: file.data.id, link: file.data.webViewLink };
}

module.exports = { uploadImageFromUrl };
