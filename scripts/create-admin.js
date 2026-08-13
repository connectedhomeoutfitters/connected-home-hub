// One-off CLI to create/reset a staff login. Break-glass fallback — day-to-day staff
// management lives at /admin/settings/users.
// Usage: node scripts/create-admin.js you@connectedhomeoutfitters.com 'somePassword' "Your Name" [orgId]
//
// orgId defaults to 1 (Connected Home Outfitters). Since migration 030 made users unique
// per-org rather than globally, the ON DUPLICATE KEY UPDATE below keys off
// UNIQUE(org_id, email) — running this for the same email in a different org creates a
// separate staff account rather than overwriting the first.
require('dotenv').config();
const bcrypt = require('bcrypt');
const db = require('../config/db');

async function main() {
  const [email, password, name, orgArg] = process.argv.slice(2);
  if (!email || !password || !name) {
    console.error('Usage: node scripts/create-admin.js <email> <password> <name> [orgId]');
    process.exit(1);
  }

  const orgId = Number(orgArg || 1);
  if (!Number.isInteger(orgId) || orgId <= 0) {
    console.error(`Invalid orgId: ${orgArg}`);
    process.exit(1);
  }

  const [orgs] = await db.execute('SELECT id, name FROM orgs WHERE id = ?', [orgId]);
  if (!orgs[0]) {
    console.error(`No org with id ${orgId}. Existing orgs:`);
    const [all] = await db.execute('SELECT id, name, slug FROM orgs ORDER BY id');
    for (const o of all) console.error(`  ${o.id}  ${o.name} (${o.slug})`);
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 12);
  await db.execute(
    `INSERT INTO users (org_id, email, password_hash, name, role) VALUES (?, ?, ?, ?, 'admin')
     ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), name = VALUES(name)`,
    [orgId, email, hash, name]
  );
  console.log(`Admin user ready: ${email} (org ${orgId} — ${orgs[0].name})`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
