// One-off CLI to create/reset a staff login.
// Usage: node scripts/create-admin.js you@connectedhomeoutfitters.com 'somePassword' "Your Name"
require('dotenv').config();
const bcrypt = require('bcrypt');
const db = require('../config/db');

async function main() {
  const [email, password, name] = process.argv.slice(2);
  if (!email || !password || !name) {
    console.error('Usage: node scripts/create-admin.js <email> <password> <name>');
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 12);
  await db.execute(
    `INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, 'admin')
     ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), name = VALUES(name)`,
    [email, hash, name]
  );
  console.log(`Admin user ready: ${email}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
