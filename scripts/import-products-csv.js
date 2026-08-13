// One-off/re-runnable CLI to bulk-load the product catalog from a CSV export (the
// source spreadsheet's columns: Category, subcategory_1..10, Product, description,
// part_number, Retail Price, Vendor Cost, taxable, unit_of_measure,
// material_markup_enabled, Margin %, Amazon Link). Only subcategory_1/_2 are used
// (as vendor/product_line) — deeper levels weren't used in the real data.
// Upserts on (category, name) so re-running with an updated export is safe.
//
// Usage: node scripts/import-products-csv.js "C:\path\to\catalog.csv"
require('dotenv').config();
const fs = require('fs');
const { parse } = require('csv-parse/sync');
const db = require('../config/db');

function parseMoney(value) {
  if (!value) return 0;
  const num = parseFloat(String(value).replace(/[$,]/g, ''));
  return Number.isFinite(num) ? num : 0;
}

async function main() {
  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error('Usage: node scripts/import-products-csv.js <path-to-csv> [orgId]');
    process.exit(1);
  }

  // Which tenant's catalog to import into; defaults to 1 (Connected Home Outfitters).
  const orgId = Number(process.argv[3] || 1);
  const [orgs] = await db.execute('SELECT id, name FROM orgs WHERE id = ?', [orgId]);
  if (!orgs[0]) {
    console.error(`No org with id ${orgId}.`);
    process.exit(1);
  }
  console.log(`Importing into org ${orgId} — ${orgs[0].name}`);

  const rows = parse(fs.readFileSync(csvPath, 'utf8'), { columns: true, skip_empty_lines: true });

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    const category = row['Category']?.trim();
    const name = row['Product']?.trim();
    if (!category || !name) {
      skipped++;
      continue;
    }

    const subcategories = [];
    for (let i = 1; i <= 10; i++) {
      const value = row[`subcategory_${i}`]?.trim();
      if (value) subcategories.push(value);
    }

    const product = {
      category,
      vendor: subcategories[0] || null,
      product_line: subcategories[1] || null,
      name,
      description: row['description']?.trim() || null,
      part_number: row['part_number']?.trim() || null,
      vendor_cost: parseMoney(row['Vendor Cost']),
      retail_price: parseMoney(row['Retail Price']),
      markup_percent: parseFloat(row['Margin %']) || null,
      markup_enabled: row['material_markup_enabled']?.trim().toUpperCase() === 'TRUE',
      taxable: row['taxable']?.trim().toUpperCase() === 'TRUE',
      unit_of_measure: row['unit_of_measure']?.trim() || 'Each',
      reference_url: row['Amazon Link']?.trim() || null,
    };

    const [existing] = await db.execute(
      'SELECT id FROM products WHERE org_id = ? AND category = ? AND name = ?',
      [orgId, product.category, product.name]
    );

    if (existing[0]) {
      await db.execute(
        `UPDATE products SET vendor=?, product_line=?, description=?, part_number=?,
          vendor_cost=?, retail_price=?, markup_percent=?, markup_enabled=?, taxable=?,
          unit_of_measure=?, reference_url=? WHERE id=? AND org_id=?`,
        [product.vendor, product.product_line, product.description, product.part_number,
          product.vendor_cost, product.retail_price, product.markup_percent,
          product.markup_enabled, product.taxable, product.unit_of_measure,
          product.reference_url, existing[0].id, orgId]
      );
      updated++;
    } else {
      await db.execute(
        `INSERT INTO products
          (org_id, category, vendor, product_line, name, description, part_number, vendor_cost,
           retail_price, markup_percent, markup_enabled, taxable, unit_of_measure, reference_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [orgId, product.category, product.vendor, product.product_line, product.name,
          product.description, product.part_number, product.vendor_cost, product.retail_price,
          product.markup_percent, product.markup_enabled, product.taxable,
          product.unit_of_measure, product.reference_url]
      );
      inserted++;
    }
  }

  console.log(`Import complete: ${inserted} inserted, ${updated} updated, ${skipped} skipped.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
