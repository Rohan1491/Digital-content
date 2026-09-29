// One-off: delete all products and reload from Products.xlsx (exported to
// JSON first, see the accompanying shell step). Run with node against a
// running server so it reuses the API's own image-cleanup/flag-default logic
// instead of touching the shared DB directly.
const fs = require('fs');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4000';
const rows = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));

async function main() {
  const listRes = await fetch(`${BASE}/api/products`);
  const { data: existing } = await listRes.json();
  console.log(`Deleting ${existing.length} existing products...`);
  for (const p of existing) {
    const r = await fetch(`${BASE}/api/products/${p.id}`, { method: 'DELETE' });
    if (!r.ok) throw new Error(`Failed to delete product ${p.id}`);
  }

  console.log(`Inserting ${rows.length} products from Excel...`);
  for (const row of rows) {
    const payload = {
      sku: row.SKU,
      category: row.Category,
      name: row.ProductCode,
      price: String(row.MRP),
      new_price: '',
      unit: 'Piece',
      min_quantity: 1,
      availability: 'yes',
      dimensions: '',
      details: '',
      applications: '',
      specs: {},
    };
    const r = await fetch(`${BASE}/api/products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (!r.ok || !j.success) throw new Error(`Failed to insert ${row.SKU}: ${JSON.stringify(j)}`);
  }

  const finalRes = await fetch(`${BASE}/api/products`);
  const finalJ = await finalRes.json();
  console.log(`Done. Product count now: ${finalJ.data.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
