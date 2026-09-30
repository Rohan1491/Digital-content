// ── Google Drive — save every generated image ───────────────────
// OAuth (drive.file scope), not a service-account key: this Google account's
// org policy (iam.managed.disableServiceAccountKeyCreation) blocks creating
// service-account keys entirely. The refresh token below comes from the
// one-time /auth/google consent flow in server.js and is stored in .env.
const { Readable } = require('stream');
const { google } = require('googleapis');

const FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;

function getDrive() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) return null;

  const auth = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  auth.setCredentials({ refresh_token: refreshToken });
  return google.drive({ version: 'v3', auth });
}

// Returns { id, link } on success, or null if Drive isn't connected yet
// (missing OAuth credentials, refresh token, or folder id) — callers should
// treat that as a no-op, not an error, so image generation keeps working
// before Drive is connected.
async function uploadImageBuffer(buffer, filename, mimeType) {
  const drive = getDrive();
  if (!drive || !FOLDER_ID) return null;

  const file = await drive.files.create({
    requestBody: { name: filename, parents: [FOLDER_ID] },
    media: { mimeType: mimeType || 'image/jpeg', body: Readable.from(buffer) },
    fields: 'id, webViewLink',
  });
  return { id: file.data.id, link: file.data.webViewLink };
}

module.exports = { uploadImageBuffer };
