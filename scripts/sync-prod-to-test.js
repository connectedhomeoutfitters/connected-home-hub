// Refreshes the TEST database with a copy of PRODUCTION, so test mirrors real data.
//
// Direction is strictly prod -> test. It pulls a fresh dump from the VPS over SSH
// (root, MariaDB unix_socket auth — no DB password anywhere) and loads it into the test
// DB configured in .env (the NAS at 192.168.4.199:3307). This REPLACES the test DB's
// contents (the dump carries DROP TABLE), so any test-only scratch data is discarded.
//
// Safety: refuses to run unless the destination is the LAN test NAS, so this can never
// accidentally overwrite production. Run manually with `node scripts/sync-prod-to-test.js`
// or on a schedule (see scripts/sync-prod-to-test.bat + the Windows scheduled task).
require('dotenv').config();
const { execSync } = require('child_process');
const mysql = require('mysql2/promise');

const VPS = 'root@2.25.186.172';
const TEST_HOST = '192.168.4.199';

if (process.env.DB_HOST !== TEST_HOST) {
  console.error(`REFUSING: DB_HOST is "${process.env.DB_HOST}", not the test NAS (${TEST_HOST}). ` +
    'This script only ever writes to the test DB — aborting so production is never touched.');
  process.exit(1);
}

(async () => {
  console.log(`[${new Date().toISOString()}] prod -> test sync starting`);
  console.log(`Pulling fresh dump from ${VPS}...`);
  // --skip-add-locks: the test DB user lacks the LOCK TABLES privilege, and mysqldump's
  // default LOCK TABLES wrappers around inserts would otherwise fail the load.
  const dump = execSync(
    `ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new ${VPS} "mysqldump --single-transaction --quick --skip-add-locks --routines --triggers --events choHub"`,
    { maxBuffer: 512 * 1024 * 1024 }
  ).toString();
  if (!/CREATE TABLE/.test(dump)) {
    throw new Error('Prod dump looks empty/invalid — aborting before touching the test DB.');
  }
  console.log(`Pulled ${(dump.length / 1024).toFixed(1)} KB of SQL.`);

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME, multipleStatements: true,
  });
  console.log(`Loading into test DB ${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME} (replaces existing data)...`);
  await conn.query(dump);

  const [[{ customers }]] = await conn.query('SELECT COUNT(*) AS customers FROM customers');
  const [[{ products }]] = await conn.query('SELECT COUNT(*) AS products FROM products');
  console.log(`Done — test now mirrors prod: ${customers} customers, ${products} products.`);
  await conn.end();
})().catch((err) => { console.error('SYNC FAILED:', err.message); process.exit(1); });
