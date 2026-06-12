/**
 * RaPiSys — TOTP (RFC 6238) with zero dependencies
 * ------------------------------------------------
 * Standard 30s/6-digit HMAC-SHA1 codes, compatible with Google
 * Authenticator, Authy, 1Password, Bitwarden, Apple Passwords, etc.
 */

import crypto from 'crypto';

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32_ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = str.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32_ALPHABET.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

export function generateSecret() {
  return base32Encode(crypto.randomBytes(20)); // 160-bit, RFC 4226 recommended
}

export function totpCode(secretB32, t = Date.now(), step = 30, digits = 6) {
  const counter = Math.floor(t / 1000 / step);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', base32Decode(secretB32)).update(msg).digest();
  const off = hmac[hmac.length - 1] & 0xf;
  const bin = ((hmac[off] & 0x7f) << 24) | (hmac[off + 1] << 16) | (hmac[off + 2] << 8) | hmac[off + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/** Verify with a ±1 step window for clock drift. */
export function verifyTotp(secretB32, code, t = Date.now()) {
  const c = String(code || '').trim();
  if (!/^\d{6}$/.test(c)) return false;
  for (const dt of [-30000, 0, 30000]) {
    const expect = totpCode(secretB32, t + dt);
    if (crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(c))) return true;
  }
  return false;
}

export function otpauthUri(secretB32, username, issuer = 'RaPiSys') {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(username)}`
    + `?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
