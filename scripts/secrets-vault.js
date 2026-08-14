#!/usr/bin/env node
'use strict';
// Encrypted offline copy of every environment's .env.
//
// WHY: prod's .env files are the only copy of the live Stripe keys, both webhook signing
// secrets, the Google OAuth client secret, the Gmail app password, the DB password and
// SESSION_SECRET. Losing them means re-fetching each one by hand, and rotating
// SESSION_SECRET logs every user out. Plaintext .bak files sitting on the server were the
// wrong answer; this is an authenticated-encrypted bundle that lives ONLY on the dev
// machine.
//
// THE VAULT FILE MUST NEVER LEAVE N:. It is excluded from git (.gitignore `*.vault`) and
// from the NAS sync (gulpfile.js `!*.vault`). Committing it would push every production
// secret to GitHub; syncing it would put them on the NAS web share.
//
// Crypto: scrypt (N=2^17) to stretch the passphrase, then AES-256-GCM. GCM is
// authenticated, so a corrupted or tampered vault fails to open rather than returning
// garbage. No dependencies — Node's built-in crypto only.
//
// Usage (run these yourself so the passphrase never passes through anything else):
//   node scripts/secrets-vault.js seal     — collect the .env files and encrypt
//   node scripts/secrets-vault.js list     — show what's inside
//   node scripts/secrets-vault.js open     — print everything
//   node scripts/secrets-vault.js open <name>
//   node scripts/secrets-vault.js restore <name> <dest-file>
//
// There is NO passphrase recovery. If you forget it the vault is unrecoverable — which is
// the point. Put the passphrase in your password manager.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execFileSync } = require('child_process');

const VAULT = path.join(__dirname, '..', 'secrets.vault');

// Where each environment's .env lives. `ssh` entries run remotely; `local` reads a file.
const SOURCES = [
  { name: 'prod-cho-hub.env', desc: 'VPS /var/www/cho-hub/.env (LIVE Stripe, prod DB)',
    ssh: ['root@2.25.186.172', 'cat /var/www/cho-hub/.env'] },
  { name: 'prod-chl.env', desc: 'VPS /var/www/chl/.env (Connected Home Ledger, LIVE)',
    ssh: ['root@2.25.186.172', 'cat /var/www/chl/.env'] },
  { name: 'nas-cho-hub.env', desc: 'NAS /volume1/web/choHubProject/.env (test/sandbox)',
    ssh: ['-p', '2222', 'nostrus@192.168.4.199', 'cat /volume1/web/choHubProject/.env'] },
  { name: 'dev-cho-hub.env', desc: 'this machine N:\\choHubProject\\.env',
    local: path.join(__dirname, '..', '.env') },
];

const SCRYPT = { N: 1 << 17, r: 8, p: 1, keylen: 32, maxmem: 256 * 1024 * 1024 };

function deriveKey(passphrase, salt) {
  return crypto.scryptSync(passphrase, salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem,
  });
}

// Reads a passphrase without echoing it.
function askSecret(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    rl._writeToOutput = function (s) {
      if (!muted || s.includes(question)) rl.output.write(s);
    };
    rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
    muted = true;
  });
}

function encrypt(plaintext, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    v: 1,
    kdf: { name: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p },
    cipher: 'aes-256-gcm',
    sealedAt: new Date().toISOString(),
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

function decrypt(vault, passphrase) {
  const key = deriveKey(passphrase, Buffer.from(vault.salt, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(vault.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(vault.tag, 'base64'));
  // Throws if the passphrase is wrong or the file was altered — GCM authenticates.
  return Buffer.concat([
    decipher.update(Buffer.from(vault.data, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function readVault() {
  if (!fs.existsSync(VAULT)) {
    console.error(`No vault at ${VAULT}. Run: node scripts/secrets-vault.js seal`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(VAULT, 'utf8'));
}

async function openVault() {
  const vault = readVault();
  const passphrase = await askSecret('Passphrase: ');
  try {
    return JSON.parse(decrypt(vault, passphrase));
  } catch {
    console.error('\nWrong passphrase, or the vault file has been altered.');
    process.exit(1);
  }
}

async function seal() {
  console.log('Collecting .env files…\n');
  const bundle = {};
  for (const s of SOURCES) {
    try {
      const content = s.local
        ? fs.readFileSync(s.local, 'utf8')
        : execFileSync('ssh', ['-o', 'BatchMode=yes', ...s.ssh], { encoding: 'utf8' });
      const keys = (content.match(/^[A-Z_]+=/gm) || []).length;
      bundle[s.name] = content;
      console.log(`  ok    ${s.name.padEnd(20)} ${keys} keys   ${s.desc}`);
    } catch (err) {
      console.log(`  SKIP  ${s.name.padEnd(20)} unreachable — ${err.message.split('\n')[0].slice(0, 60)}`);
    }
  }
  if (!Object.keys(bundle).length) { console.error('\nNothing collected; aborting.'); process.exit(1); }

  console.log('\nChoose a passphrase. There is no recovery if you lose it —');
  console.log('store it in your password manager now.\n');
  const p1 = await askSecret('Passphrase: ');
  if (p1.length < 12) { console.error('Too short — use at least 12 characters.'); process.exit(1); }
  const p2 = await askSecret('Confirm:    ');
  if (p1 !== p2) { console.error('Passphrases do not match.'); process.exit(1); }

  const payload = JSON.stringify({ sealedAt: new Date().toISOString(), files: bundle }, null, 2);
  fs.writeFileSync(VAULT, JSON.stringify(encrypt(payload, p1), null, 2) + '\n', { mode: 0o600 });

  // Prove it round-trips before declaring success — a vault that can't be opened is worse
  // than no vault, because you'd stop worrying about the backup.
  try {
    const check = JSON.parse(decrypt(JSON.parse(fs.readFileSync(VAULT, 'utf8')), p1));
    const names = Object.keys(check.files);
    console.log(`\nSealed ${VAULT}`);
    console.log(`  verified: reopened and read back ${names.length} file(s) — ${names.join(', ')}`);
    console.log('  permissions: 600 (owner only)');
    console.log('\nThis file must stay on N:. It is excluded from git and from the NAS sync.');
  } catch {
    console.error('\nWrote the vault but could NOT reopen it — do not rely on this file.');
    process.exit(1);
  }
}

async function main() {
  const [cmd, arg1, arg2] = process.argv.slice(2);

  if (cmd === 'seal') return seal();

  if (cmd === 'list') {
    const { sealedAt, files } = await openVault();
    console.log(`\nSealed ${sealedAt}`);
    for (const [name, content] of Object.entries(files)) {
      console.log(`  ${name.padEnd(20)} ${(content.match(/^[A-Z_]+=/gm) || []).length} keys`);
    }
    return;
  }

  if (cmd === 'open') {
    const { files } = await openVault();
    if (arg1) {
      if (!files[arg1]) { console.error(`No such entry: ${arg1}`); process.exit(1); }
      return process.stdout.write(files[arg1]);
    }
    for (const [name, content] of Object.entries(files)) {
      console.log(`\n===== ${name} =====\n${content}`);
    }
    return;
  }

  if (cmd === 'restore') {
    if (!arg1 || !arg2) { console.error('Usage: restore <name> <dest-file>'); process.exit(1); }
    const { files } = await openVault();
    if (!files[arg1]) { console.error(`No such entry: ${arg1}`); process.exit(1); }
    if (fs.existsSync(arg2)) { console.error(`${arg2} already exists — refusing to overwrite.`); process.exit(1); }
    fs.writeFileSync(arg2, files[arg1], { mode: 0o600 });
    console.log(`Wrote ${arg1} -> ${arg2} (mode 600)`);
    return;
  }

  console.log(`Usage:
  node scripts/secrets-vault.js seal                  collect the .env files and encrypt
  node scripts/secrets-vault.js list                  show what's inside
  node scripts/secrets-vault.js open [name]           print everything, or one entry
  node scripts/secrets-vault.js restore <name> <dest> write one entry back to a file`);
}

// Only run the CLI when invoked directly, so test/secretsVault.test.js can import the
// crypto and verify it round-trips without triggering a prompt.
if (require.main === module) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { encrypt, decrypt, deriveKey, SCRYPT, VAULT, SOURCES };
