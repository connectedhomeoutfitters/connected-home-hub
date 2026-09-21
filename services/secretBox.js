'use strict';
// Authenticated encryption for secrets we are obliged to hold at rest — today, tenants'
// Square OAuth tokens (services/squareAccounts.js).
//
// AES-256-GCM with a random 96-bit IV per value; the auth tag means a tampered or
// truncated blob fails to open rather than decrypting to garbage. The key is 32 random
// bytes, hex-encoded, in SQUARE_TOKEN_ENCRYPTION_KEY. Losing the key loses every stored
// token — the tenant simply reconnects Square — so it is a nuisance, not a data loss.
//
// Blob format: v1:<iv b64>:<tag b64>:<ciphertext b64>. The version prefix is what lets a
// future key rotation tell old blobs from new ones.

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';

function loadKey(envName = 'SQUARE_TOKEN_ENCRYPTION_KEY') {
  const hex = (process.env[envName] || '').trim();
  if (!hex) return null;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`${envName} must be 32 bytes as 64 hex characters`);
  }
  return Buffer.from(hex, 'hex');
}

function isConfigured() {
  return !!loadKey();
}

function seal(plaintext, key = loadKey()) {
  if (!key) throw new Error('secretBox: no encryption key configured');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

function open(blob, key = loadKey()) {
  if (!key) throw new Error('secretBox: no encryption key configured');
  const parts = String(blob || '').split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('secretBox: unrecognised blob');
  const [, ivB64, tagB64, ctB64] = parts;
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}

module.exports = { seal, open, isConfigured, loadKey };
