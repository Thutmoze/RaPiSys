/** RaPiSys — encrypted secrets repository (SMTP password, etc.). */

import { encrypt, decrypt, hasSecretKey } from '../core/crypto.js';

export function createSecretsRepo(db) {
  function set(key, plaintext) {
    const { ciphertext, iv, tag } = encrypt(plaintext);
    db.prepare(`INSERT OR REPLACE INTO secrets (key, ciphertext, iv, tag) VALUES (?, ?, ?, ?)`)
      .run(key, ciphertext, iv, tag);
  }
  function get(key) {
    const row = db.prepare(`SELECT ciphertext, iv, tag FROM secrets WHERE key = ?`).get(key);
    if (!row) return null;
    return decrypt(row);
  }
  function has(key) {
    return !!db.prepare(`SELECT 1 FROM secrets WHERE key = ?`).get(key);
  }
  function remove(key) {
    db.prepare(`DELETE FROM secrets WHERE key = ?`).run(key);
  }
  return { set, get, has, remove, encryptionAvailable: hasSecretKey };
}
