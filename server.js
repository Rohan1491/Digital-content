require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const Database = require('better-sqlite3');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const compression = require('compression');
const { uploadImageBuffer, listFiles } = require('./lib/drive');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Database ───────────────────────────────────────────────────
// DB_PATH lets local dev point the db outside OneDrive-synced folders —
// background sync can lock/truncate a SQLite file mid-write. Points at the
// same shopmanager.db as the CRM app so the product catalog (with images)
// is shared rather than duplicated.
const dbPath = process.env.DB_PATH || path.join(__dirname, 'shopmanager.db');
const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sku TEXT, category TEXT, name TEXT,
    price TEXT, new_price TEXT,
    availability TEXT DEFAULT 'yes',
    unit TEXT, min_quantity INTEGER DEFAULT 1,
    dimensions TEXT, details TEXT,
    specs TEXT DEFAULT '{}',
    applications TEXT,
    images TEXT DEFAULT '[]',
    flag_for_website INTEGER DEFAULT 0,
    flag_available INTEGER DEFAULT 0,
    flag_out_of_stock INTEGER DEFAULT 0,
    quantity REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);
// Added after the table above was already live in the shared CRM db, so it
// needs its own migration rather than just living in the CREATE TABLE.
try { db.exec("ALTER TABLE products ADD COLUMN flag_reference_image INTEGER DEFAULT 0"); } catch (e) {}

app.use(compression());
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname), {
  maxAge: '1h',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    else if (filePath.match(/\.(css|js)$/)) res.setHeader('Cache-Control', 'public, max-age=3600');
    else if (filePath.match(/\.(png|jpg|jpeg|webp|svg|ico)$/)) res.setHeader('Cache-Control', 'public, max-age=86400');
  }
}));

// ── Image upload setup ────────────────────────────────────────
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
app.use('/uploads', express.static(uploadsDir));

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9.]/g, '-')),
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

// ── Auth: single-password login ─────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  const password = (req.body && req.body.password || '').trim();
  if (!password) return res.status(400).json({ success: false, error: 'Password required' });
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin';
  if (password === adminPassword) return res.json({ success: true, role: 'admin', name: 'Admin' });
  res.status(401).json({ success: false, error: 'Incorrect password' });
});

// ── Products ─────────────────────────────────────────────────────
app.get('/api/products', (req, res) => {
  const { category, search } = req.query;
  let sql = 'SELECT * FROM products';
  const params = [], conds = [];
  if (category) { conds.push('category = ?'); params.push(category); }
  if (search) { conds.push('(name LIKE ? OR sku LIKE ? OR category LIKE ? OR details LIKE ?)'); params.push(...Array(4).fill(`%${search}%`)); }
  if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
  sql += ' ORDER BY category, CAST(sku AS INTEGER)';
  res.json({ data: db.prepare(sql).all(...params) });
});

app.get('/api/products/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  res.json(p);
});

// Available / Out of Stock are read from inventory, not set by hand: they're
// a pure function of quantity, except for flag_for_website products (not
// inventory-tracked at all — "On Request" instead, so neither flag applies).
function syncAvailabilityFlags(productId) {
  const p = db.prepare('SELECT quantity, flag_for_website FROM products WHERE id=?').get(productId);
  if (!p) return;
  const available = !p.flag_for_website && (p.quantity || 0) > 0;
  const outOfStock = !p.flag_for_website && (p.quantity || 0) <= 0;
  db.prepare('UPDATE products SET flag_available=?, flag_out_of_stock=? WHERE id=?')
    .run(available ? 1 : 0, outOfStock ? 1 : 0, productId);
}

app.post('/api/products', (req, res) => {
  const p = req.body;
  // New products aren't in inventory until someone explicitly adds them there
  // (client confirmation workflow) -- default flag_for_website to 1 unless the
  // caller says otherwise.
  const flagForWebsite = p.flag_for_website === undefined ? 1 : (p.flag_for_website ? 1 : 0);
  const r = db.prepare(`INSERT INTO products (sku,category,name,price,new_price,availability,unit,min_quantity,dimensions,details,specs,applications,images,flag_for_website,flag_reference_image) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(p.sku, p.category, p.name, p.price, p.new_price || '', p.availability || 'yes', p.unit, p.min_quantity || 1, p.dimensions || '', p.details || '', JSON.stringify(p.specs || {}), p.applications || '', '[]', flagForWebsite, p.flag_reference_image ? 1 : 0);
  syncAvailabilityFlags(r.lastInsertRowid);
  res.json({ success: true, id: r.lastInsertRowid });
});

app.put('/api/products/:id', (req, res) => {
  const p = req.body;
  db.prepare(`UPDATE products SET sku=?,category=?,name=?,price=?,new_price=?,availability=?,unit=?,min_quantity=?,dimensions=?,details=?,specs=?,applications=?,flag_for_website=?,flag_reference_image=?,updated_at=datetime('now') WHERE id=?`)
    .run(p.sku, p.category, p.name, p.price, p.new_price || '', p.availability, p.unit, p.min_quantity, p.dimensions || '', p.details || '', JSON.stringify(p.specs || {}), p.applications || '', p.flag_for_website ? 1 : 0, p.flag_reference_image ? 1 : 0, req.params.id);
  syncAvailabilityFlags(req.params.id);
  res.json({ success: true });
});

app.patch('/api/products/:id/flags', (req, res) => {
  const { flag_for_website, flag_reference_image } = req.body;
  const updates = [], params = [];
  if (flag_for_website !== undefined) { updates.push('flag_for_website=?'); params.push(flag_for_website ? 1 : 0); }
  if (flag_reference_image !== undefined) { updates.push('flag_reference_image=?'); params.push(flag_reference_image ? 1 : 0); }
  if (!updates.length) return res.status(400).json({ error: 'No flags provided' });
  params.push(req.params.id);
  db.prepare(`UPDATE products SET ${updates.join(', ')}, updated_at=datetime('now') WHERE id=?`).run(...params);
  if (flag_for_website !== undefined) syncAvailabilityFlags(req.params.id);
  res.json({ success: true });
});

app.delete('/api/products/:id', (req, res) => {
  const p = db.prepare('SELECT images FROM products WHERE id=?').get(req.params.id);
  if (p) {
    JSON.parse(p.images || '[]').forEach(f => {
      const fp = path.join(uploadsDir, f);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    });
  }
  db.prepare('DELETE FROM products WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// Image upload
app.post('/api/products/:id/images', upload.array('images', 10), (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Product not found' });
  const existing = JSON.parse(p.images || '[]');
  const safeId = String(p.id);
  const safeSku = (p.sku || 'sku').replace(/[^a-zA-Z0-9]/g, '_');
  const safeCat = (p.category || 'cat').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 20);
  const safeName = (p.name || 'product').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30);
  const newFiles = req.files.map((f, i) => {
    const ext = path.extname(f.originalname).toLowerCase() || '.jpg';
    const idx = existing.length + i + 1;
    const newName = `${safeId}_${safeSku}_${safeCat}_${safeName}_${idx}${ext}`;
    try {
      fs.renameSync(path.join(uploadsDir, f.filename), path.join(uploadsDir, newName));
      return newName;
    } catch (e) {
      console.error('Image rename failed:', e.message);
      return f.filename;
    }
  });
  const all = [...existing, ...newFiles];
  db.prepare('UPDATE products SET images=? WHERE id=?').run(JSON.stringify(all), req.params.id);
  res.json({ success: true, images: all });
});

app.delete('/api/products/:id/images/:filename', (req, res) => {
  const p = db.prepare('SELECT images FROM products WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const images = JSON.parse(p.images || '[]').filter(f => f !== req.params.filename);
  db.prepare('UPDATE products SET images=? WHERE id=?').run(JSON.stringify(images), req.params.id);
  const fp = path.join(uploadsDir, req.params.filename);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  res.json({ success: true });
});

// ── Image rename to id_sku_category_name_N ───────────────────────────
app.post('/api/products/:id/rename-images', (req, res) => {
  try {
    const p = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    const images = JSON.parse(p.images || '[]');
    const safeId = String(p.id);
    const safeSku = (p.sku || 'sku').replace(/[^a-zA-Z0-9]/g, '_');
    const safeCat = (p.category || 'cat').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 20);
    const safeName = (p.name || 'product').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30);
    const newImages = images.map((oldFile, i) => {
      const ext = path.extname(oldFile).toLowerCase() || '.jpg';
      const newFile = `${safeId}_${safeSku}_${safeCat}_${safeName}_${i + 1}${ext}`;
      const oldPath = path.join(uploadsDir, oldFile);
      const newPath = path.join(uploadsDir, newFile);
      if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) fs.renameSync(oldPath, newPath);
      return fs.existsSync(newPath) ? newFile : oldFile;
    });
    db.prepare('UPDATE products SET images=? WHERE id=?').run(JSON.stringify(newImages), req.params.id);
    res.json({ success: true, images: newImages });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════
// Instagram — direct content publishing (feed post / carousel)
// https://developers.facebook.com/docs/instagram-platform/content-publishing/
// Only ever called by a human clicking Approve & Post in image-generator.html.
// image_url must be publicly reachable — BytePlus's own result URLs work
// directly (valid 24h), no re-hosting needed.
// ══════════════════════════════════════════════════════════════════
const IG_TOKEN = process.env.IG_ACCESS_TOKEN || process.env.INSTAGRAM_ACCESS_TOKEN;
const IG_USER_ID = process.env.IG_USER_ID || process.env.INSTAGRAM_USER_ID;
const IG_API = 'https://graph.instagram.com/v21.0'; // Instagram Login product, not graph.facebook.com

async function igCreateContainer(params) {
  const r = await fetch(`${IG_API}/${IG_USER_ID}/media?access_token=${IG_TOKEN}`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'Instagram container creation failed');
  return j.id;
}

app.post('/api/instagram/publish', async (req, res) => {
  try {
    if (!IG_TOKEN || !IG_USER_ID) return res.status(400).json({ error: 'Instagram not configured (IG_ACCESS_TOKEN/IG_USER_ID)' });
    const { images, caption } = req.body;
    if (!Array.isArray(images) || !images.length) return res.status(400).json({ error: 'images array required' });
    if (images.length > 10) return res.status(400).json({ error: 'Max 10 images per carousel' });

    let creationId;
    if (images.length === 1) {
      creationId = await igCreateContainer({ image_url: images[0], caption: caption || '', is_ai_generated: 'true' });
    } else {
      const childIds = [];
      for (const url of images) {
        childIds.push(await igCreateContainer({ image_url: url, is_carousel_item: 'true' }));
      }
      creationId = await igCreateContainer({ media_type: 'CAROUSEL', children: childIds.join(','), caption: caption || '', is_ai_generated: 'true' });
    }

    const pubRes = await fetch(`${IG_API}/${IG_USER_ID}/media_publish?access_token=${IG_TOKEN}`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ creation_id: creationId }).toString(),
    });
    const pubJ = await pubRes.json();
    if (pubJ.error) throw new Error(pubJ.error.message || 'Instagram publish failed');
    res.json({ success: true, mediaId: pubJ.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── BytePlus ModelArk — image generation ───────────────────────
// REST API docs: https://docs.byteplus.com/en/docs/ModelArk/1541523
const BYTEPLUS_REGIONS = {
  'ap-southeast-1': 'https://ark.ap-southeast.bytepluses.com/api/v3/images/generations',
  'eu-west-1': 'https://ark.eu-west.bytepluses.com/api/v3/images/generations',
};

const BYTEPLUS_MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp' };

// Real logo, always fed in as a reference — never let the model invent or
// approximate the wordmark. Copied into assets/ (not read from outside the
// app) so the path still resolves once this is deployed.
const LOGO_PATH = path.join(__dirname, 'assets', 'arambhika-logo.jpeg');

app.post('/api/byteplus/generate-image', async (req, res) => {
  try {
    const key = process.env.BYTEPLUS_API_KEY;
    if (!key) return res.status(400).json({ error: 'BYTEPLUS_API_KEY not set in .env' });
    const { model, size, response_format, region, referenceImages, imageUrl } = req.body;
    let { prompt } = req.body;
    if (!model || !prompt) return res.status(400).json({ error: 'model and prompt are required' });

    // Base64-encode local references (works on localhost and once deployed,
    // since BytePlus's servers can never reach localhost). imageUrl is used
    // as-is instead — the "regenerate with feedback" flow passes the previous
    // BytePlus result URL straight through; that image already has the logo
    // baked in from its own generation, so the logo isn't re-added there.
    let image;
    if (imageUrl) {
      image = imageUrl;
    } else {
      const refs = [];
      const noteLines = [];
      if (fs.existsSync(LOGO_PATH)) {
        refs.push(`data:image/jpeg;base64,${fs.readFileSync(LOGO_PATH).toString('base64')}`);
        noteLines.push(`Reference image ${refs.length} is the exact Arambhika Enablers logo (wordmark + bolt icon) — reproduce it exactly as shown, do not redraw, restyle, or approximate it.`);
      }
      const refImageList = Array.isArray(referenceImages) ? referenceImages : (referenceImages ? [referenceImages] : []);
      for (const referenceImage of refImageList) {
        const safeName = path.basename(referenceImage);
        const filePath = path.join(uploadsDir, safeName);
        if (!fs.existsSync(filePath)) return res.status(400).json({ error: `Reference image ${safeName} not found` });
        const ext = path.extname(safeName).toLowerCase();
        const mime = BYTEPLUS_MIME[ext];
        if (!mime) return res.status(400).json({ error: `Unsupported reference image format: ${ext}` });
        refs.push(`data:${mime};base64,${fs.readFileSync(filePath).toString('base64')}`);
        noteLines.push(`Reference image ${refs.length} is an exact product photo — keep it accurate and unaltered.`);
      }
      if (refs.length) {
        image = refs.length === 1 ? refs[0] : refs;
        prompt = noteLines.join(' ') + '\n\n' + prompt;
      }
    }

    const url = BYTEPLUS_REGIONS[region] || BYTEPLUS_REGIONS['ap-southeast-1'];
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model,
        prompt,
        ...(image ? { image } : {}),
        size: size || '2K',
        watermark: false, // BytePlus's own "AI generated" disclosure stamp — we stamp our own logo instead, below
        response_format: response_format || 'url',
      }),
    });
    const j = await r.json();
    if (!r.ok || j.error) return res.status(r.status || 500).json({ error: j.error?.message || j.error || 'BytePlus request failed' });

    // Save a durable local + Drive copy of every generated image — BytePlus's
    // own result URLs are only valid 24h. No compositing here: the only
    // logo in the image is the one the model draws in per the prompt
    // (top-left) — we no longer stamp a second one on top. rawUrl and url
    // end up identical here, but rawUrl is kept so "regenerate with
    // feedback" always has an explicit source to edit from. Never let a
    // save/Drive hiccup fail the generation the user is waiting on.
    if (Array.isArray(j.data)) {
      const publicBase = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
      await Promise.all(j.data.map(async (item, i) => {
        if (!item.url) return;
        item.rawUrl = item.url;
        try {
          const sourceRes = await fetch(item.url);
          if (!sourceRes.ok) throw new Error(`Failed to download generated image (${sourceRes.status})`);
          const sourceBuffer = Buffer.from(await sourceRes.arrayBuffer());
          const contentType = sourceRes.headers.get('content-type') || 'image/jpeg';
          const ext = contentType.includes('png') ? 'png' : 'jpg';
          const filename = `generated-${Date.now()}-${i}.${ext}`;
          fs.writeFileSync(path.join(uploadsDir, filename), sourceBuffer);
          item.url = `${publicBase}/uploads/${filename}`;
          try {
            const drive = await uploadImageBuffer(sourceBuffer, filename, contentType);
            if (drive) item.driveLink = drive.link;
          } catch (e) {
            console.error('Drive upload failed:', e.message);
          }
        } catch (e) {
          console.error('Saving local/Drive copy failed, using raw BytePlus url:', e.message);
        }
      }));
    }

    res.json(j);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Anthropic — Instagram caption / LinkedIn post generation ───
// Claude Haiku 4.5 — the cheapest current Claude model — is plenty for a
// short social caption/post and keeps this cheap to run on every click.
app.post('/api/anthropic/generate-caption', async (req, res) => {
  try {
    const { prompt, productContext } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 300,
      system: 'You write Instagram captions for Arambhika Enablers, a B2B manufacturer of nickel strips, copper busbars, and battery connectors for EV/ESS battery pack makers in India. Write one caption: 2-4 short sentences, confident and technical (not gimmicky), end with a CTA line using these real contact details verbatim: "WhatsApp +91-9315545821 for Bulk Quote — 2hr response  ·  www.arambhika.com", then 4-6 relevant hashtags on a new line. Do not invent specific numbers, percentages, certifications, or customer names/counts that were not given to you — if no product facts are supplied, keep any technical claims general and qualitative instead of fabricating specifics; the WhatsApp number and website above are the only contact details you should use, and always use them exactly as given. Return ONLY the caption text, no preamble, no quotes, no markdown.',
      messages: [{
        role: 'user',
        content: `Write an Instagram caption for this image.\n\nImage brief: ${prompt}${productContext ? `\n\nProduct facts to reference accurately (do not invent numbers): ${productContext}` : ''}`,
      }],
    });
    res.json({ caption: msg.content[0].text.trim() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/anthropic/generate-linkedin-post', async (req, res) => {
  try {
    const { topic, productContext } = req.body;
    if (!topic) return res.status(400).json({ error: 'topic is required' });
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 500,
      system: 'You write LinkedIn posts for the Arambhika Enablers company page — a B2B manufacturer of nickel strips, copper busbars, and battery connectors for EV and energy storage (ESS) battery pack makers in India. Audience: procurement managers, battery pack engineers, EV/ESS OEMs. Tone: professional, confident, specific — no hype, no emoji spam (at most 1-2 tasteful emoji), no clickbait. Structure: a strong opening line, 2-4 short paragraphs or a brief bulleted list of specifics, a clear CTA (e.g. "DM us or WhatsApp for a bulk quote"), then 3-5 relevant hashtags on their own line at the end. Never invent specific numbers, percentages, certifications, customer names/counts, testimonials, or contact details (phone numbers, placeholders like "[your number]") that were not given to you — if no product facts are supplied, keep technical claims general and qualitative and let the CTA be a plain "DM us" / "WhatsApp us" with no fabricated number. Return ONLY the post text — no preamble, no quotes, no markdown formatting (the trailing hashtags are fine).',
      messages: [{
        role: 'user',
        content: `Write a LinkedIn post about: ${topic}${productContext ? `\n\nProduct facts to reference accurately (do not invent numbers): ${productContext}` : ''}`,
      }],
    });
    res.json({ post: msg.content[0].text.trim() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── LinkedIn — OAuth + Posts API (personal-profile posting) ────
// Docs (fetched live, not from training memory — LinkedIn's API changes
// often): learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2
// and learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api
const LINKEDIN_API_VERSION = '202507'; // YYYYMM, required on every Posts API call
let linkedinOAuthState = null; // single-user internal tool — one pending flow at a time is fine

// Persists a token to .env (and the running process) so it survives a
// restart without needing the OAuth flow again. .env is gitignored.
function updateEnvVar(key, value) {
  const envPath = path.join(__dirname, '.env');
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  content = re.test(content) ? content.replace(re, line) : (content.replace(/\n?$/, '\n') + line + '\n');
  fs.writeFileSync(envPath, content);
  process.env[key] = value;
}

app.get('/auth/linkedin', (req, res) => {
  const clientId = process.env.LINKEDIN_CLIENT_ID;
  const redirectUri = process.env.LINKEDIN_REDIRECT_URI;
  if (!clientId || !redirectUri) return res.status(400).send('LinkedIn not configured — set LINKEDIN_CLIENT_ID/LINKEDIN_CLIENT_SECRET/LINKEDIN_REDIRECT_URI in .env');
  linkedinOAuthState = crypto.randomBytes(16).toString('hex');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'openid profile w_member_social', // personal-profile posting; w_organization_social needs LinkedIn's separate Company Page review
    state: linkedinOAuthState,
  });
  res.redirect(`https://www.linkedin.com/oauth/v2/authorization?${params.toString()}`);
});

app.get('/auth/linkedin/callback', async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;
    if (error) return res.status(400).send(`LinkedIn authorization failed: ${error_description || error}`);
    if (!code) return res.status(400).send('Missing authorization code');
    if (!state || state !== linkedinOAuthState) return res.status(400).send('State mismatch — start the connection again from the Content Generator page.');
    linkedinOAuthState = null;

    const tokenRes = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.LINKEDIN_REDIRECT_URI,
        client_id: process.env.LINKEDIN_CLIENT_ID,
        client_secret: process.env.LINKEDIN_CLIENT_SECRET,
      }).toString(),
    });
    const tokenJ = await tokenRes.json();
    if (!tokenRes.ok || tokenJ.error) throw new Error(tokenJ.error_description || tokenJ.error || 'Token exchange failed');

    const meRes = await fetch('https://api.linkedin.com/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenJ.access_token}` },
    });
    const meJ = await meRes.json();
    if (!meRes.ok || !meJ.sub) throw new Error('Could not fetch LinkedIn member profile');

    updateEnvVar('LINKEDIN_ACCESS_TOKEN', tokenJ.access_token);
    updateEnvVar('LINKEDIN_PERSON_URN', `urn:li:person:${meJ.sub}`);

    res.send(`<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;padding:60px 20px;text-align:center;color:#1e293b">
      <h2 style="color:#16a34a">LinkedIn connected</h2>
      <p>Signed in as <strong>${meJ.name || meJ.given_name || 'LinkedIn member'}</strong>.</p>
      <p>You can close this tab and go back to the Content Generator page.</p>
    </body></html>`);
  } catch (e) {
    res.status(500).send(`LinkedIn connection failed: ${e.message}`);
  }
});

app.get('/api/linkedin/status', (req, res) => {
  res.json({
    connected: !!(process.env.LINKEDIN_ACCESS_TOKEN && process.env.LINKEDIN_PERSON_URN),
    configured: !!(process.env.LINKEDIN_CLIENT_ID && process.env.LINKEDIN_REDIRECT_URI),
  });
});

// Only ever called by a human clicking Approve & Post in image-generator.html.
app.post('/api/linkedin/publish', async (req, res) => {
  try {
    const token = process.env.LINKEDIN_ACCESS_TOKEN;
    const author = process.env.LINKEDIN_PERSON_URN;
    if (!token || !author) return res.status(400).json({ error: 'LinkedIn not connected yet — click "Connect LinkedIn" first' });
    const { text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'text is required' });

    const r = await fetch('https://api.linkedin.com/rest/posts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Restli-Protocol-Version': '2.0.0',
        'Linkedin-Version': LINKEDIN_API_VERSION,
      },
      body: JSON.stringify({
        author,
        commentary: text,
        visibility: 'PUBLIC',
        distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
        lifecycleState: 'PUBLISHED',
        isReshareDisabledByAuthor: false,
      }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error((j.message || j.error_description) ? (j.message || j.error_description) : `LinkedIn publish failed (${r.status})`);
    }
    const postUrn = r.headers.get('x-restli-id');
    res.json({ success: true, postUrn, permalink: postUrn ? `https://www.linkedin.com/feed/update/${postUrn}/` : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Google Drive — OAuth (drive.file scope) ─────────────────────
// Same pattern as LinkedIn above. Service-account keys were blocked by an
// org policy (iam.managed.disableServiceAccountKeyCreation), so this uses
// a one-time user consent flow instead — the refresh token it returns is
// persisted to .env and used indefinitely (googleapis auto-refreshes the
// short-lived access token from it on every call).
let googleOAuthState = null; // single-user internal tool — one pending flow at a time is fine

app.get('/auth/google', (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!clientId || !redirectUri) return res.status(400).send('Google Drive not configured — set GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REDIRECT_URI in .env');
  googleOAuthState = crypto.randomBytes(16).toString('hex');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'https://www.googleapis.com/auth/drive.file',
    access_type: 'offline', // required to get a refresh_token back
    prompt: 'consent', // force a fresh refresh_token even if already granted before
    state: googleOAuthState,
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;
    if (error) return res.status(400).send(`Google authorization failed: ${error_description || error}`);
    if (!code) return res.status(400).send('Missing authorization code');
    if (!state || state !== googleOAuthState) return res.status(400).send('State mismatch — start the connection again from the Content Generator page.');
    googleOAuthState = null;

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.GOOGLE_REDIRECT_URI,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
      }).toString(),
    });
    const tokenJ = await tokenRes.json();
    if (!tokenRes.ok || tokenJ.error) throw new Error(tokenJ.error_description || tokenJ.error || 'Token exchange failed');
    if (!tokenJ.refresh_token) throw new Error('No refresh token returned — Google only issues one on first consent. Remove this app\'s access at myaccount.google.com/permissions, then connect again.');

    updateEnvVar('GOOGLE_REFRESH_TOKEN', tokenJ.refresh_token);

    res.send(`<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;padding:60px 20px;text-align:center;color:#1e293b">
      <h2 style="color:#16a34a">Google Drive connected</h2>
      <p>You can close this tab and go back to the Content Generator page.</p>
    </body></html>`);
  } catch (e) {
    res.status(500).send(`Google Drive connection failed: ${e.message}`);
  }
});

app.get('/api/google/status', (req, res) => {
  res.json({
    connected: !!process.env.GOOGLE_REFRESH_TOKEN,
    configured: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_REDIRECT_URI),
  });
});

app.get('/api/google/drive-files', async (req, res) => {
  try {
    res.json({ files: await listFiles() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`Digital Content server running on http://localhost:${PORT}`));
