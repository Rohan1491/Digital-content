// One-off: for every product with a matching SKU in the given folder,
// delete its current image(s) and replace with the new file — a true
// replace, unlike upload-product-images.js which only appends. Matching
// is by leading SKU token in the filename (e.g. "NP1 Nickel Strip....jpeg"
// -> NP1), same convention as upload-product-images.js.
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4000';
const dirs = process.argv.slice(2);

function walk(dir) {
  let out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out = out.concat(walk(full));
    else out.push(full);
  }
  return out;
}

function extractSku(filename) {
  const base = path.basename(filename, path.extname(filename));
  return base.trim().split(/\s+/)[0];
}

async function main() {
  const listRes = await fetch(`${BASE}/api/products`);
  const { data: products } = await listRes.json();
  const bySku = new Map(products.map(p => [p.sku, p]));

  const files = dirs.flatMap(walk).filter(f => /\.(jpe?g|png|webp|gif|bmp)$/i.test(f));

  const matched = [], unmatchedFiles = [];
  for (const file of files) {
    const sku = extractSku(file);
    if (bySku.has(sku)) matched.push({ file, sku, product: bySku.get(sku) });
    else unmatchedFiles.push(file);
  }

  console.log(`Found ${files.length} image files. ${matched.length} matched a SKU, ${unmatchedFiles.length} did not.`);

  for (const { file, sku, product } of matched) {
    const existing = JSON.parse(product.images || '[]');
    for (const oldFile of existing) {
      const r = await fetch(`${BASE}/api/products/${product.id}/images/${encodeURIComponent(oldFile)}`, { method: 'DELETE' });
      if (!r.ok) throw new Error(`Failed to delete old image ${oldFile} for ${sku}`);
    }

    const buffer = fs.readFileSync(file);
    const form = new FormData();
    form.append('images', new Blob([buffer]), path.basename(file));
    const r = await fetch(`${BASE}/api/products/${product.id}/images`, { method: 'POST', body: form });
    const j = await r.json();
    if (!r.ok || !j.success) throw new Error(`Upload failed for ${sku}: ${JSON.stringify(j)}`);
    console.log(`  replaced -> ${sku} (${product.name}) [${existing.length} old image(s) removed]`);
  }

  const skusReplaced = new Set(matched.map(m => m.sku));
  const productsNotTouched = products.filter(p => !skusReplaced.has(p.sku));

  console.log('\n--- Unmatched files (no product with this SKU) ---');
  unmatchedFiles.forEach(f => console.log('  ' + f));

  console.log('\n--- Products left untouched (no matching file in this folder) ---');
  productsNotTouched.forEach(p => console.log(`  ${p.sku} — ${p.name}`));
}

main().catch(e => { console.error(e); process.exit(1); });
