'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  generateSalt,
  deriveKey,
  computeVerifier,
  checkCode,
  encryptValue,
  decryptValue,
  decryptDecimalOrZero,
  createUnlockSession,
  getUnlockKey,
  revokeUnlockSession,
} = require('../../services/paie/salaryCrypto');

test('encrypt then decrypt round-trips the original value', () => {
  const key = deriveKey('correct-horse-battery-staple', generateSalt());
  const ciphertext = encryptValue('1234.567', key);
  assert.notEqual(ciphertext, '1234.567');
  assert.equal(decryptValue(ciphertext, key), '1234.567');
});

test('null/undefined values are never encrypted', () => {
  const key = deriveKey('code', generateSalt());
  assert.equal(encryptValue(null, key), null);
  assert.equal(encryptValue(undefined, key), null);
});

test('decrypting with the wrong key fails closed (null), never throws', () => {
  const salt = generateSalt();
  const key = deriveKey('the-real-code', salt);
  const wrongKey = deriveKey('a-different-code', salt);
  const ciphertext = encryptValue('999.000', key);
  assert.equal(decryptValue(ciphertext, wrongKey), null);
});

test('decrypting with no key (locked) returns null, never throws', () => {
  const ciphertext = encryptValue('50.000', deriveKey('code', generateSalt()));
  assert.equal(decryptValue(ciphertext, null), null);
});

test('decrypting a non-ciphertext string (e.g. unmigrated legacy value) returns null', () => {
  const key = deriveKey('code', generateSalt());
  assert.equal(decryptValue('1000.000', key), null);
});

test('decryptDecimalOrZero falls back to 0 when locked, matches real value when unlocked', () => {
  const key = deriveKey('code', generateSalt());
  const ciphertext = encryptValue('275.500', key);
  assert.ok(decryptDecimalOrZero(ciphertext, key).equals('275.500'));
  assert.ok(decryptDecimalOrZero(ciphertext, null).equals('0'));
});

test('checkCode returns the derived key for the correct code, null otherwise', () => {
  const salt = generateSalt();
  const key = deriveKey('test-unlock-secret', salt);
  const verifier = computeVerifier(key);

  const correct = checkCode('test-unlock-secret', salt, verifier);
  assert.ok(Buffer.isBuffer(correct));
  assert.ok(correct.equals(key));

  assert.equal(checkCode('wrong-code', salt, verifier), null);
});

test('unlock sessions: valid token returns the key, unknown/revoked token does not', async () => {
  const key = deriveKey('code', generateSalt());
  const { token } = await createUnlockSession(key);

  assert.ok(getUnlockKey(token).equals(key));
  revokeUnlockSession(token);
  assert.equal(getUnlockKey(token), null);
  assert.equal(getUnlockKey('not-a-real-token'), null);
});

test('createUnlockSession reports an expiresAt in the future', async () => {
  const key = deriveKey('code', generateSalt());
  const { expiresAt } = await createUnlockSession(key);
  assert.ok(expiresAt > Date.now());
});

// Minimal stand-in for the pg Pool, just enough for paie_unlock_sessions.
function fakeSessionPool() {
  const rows = new Map();
  return {
    rows,
    async query(sql, params = []) {
      if (/INSERT INTO public\.paie_unlock_sessions/.test(sql)) {
        rows.set(params[0], { wrapped_key: params[1], expires_at: new Date(params[2]) });
      } else if (/SELECT wrapped_key/.test(sql)) {
        const row = rows.get(params[0]);
        return { rows: row && row.expires_at > new Date() ? [row] : [] };
      } else if (/DELETE FROM public\.paie_unlock_sessions WHERE token_hash/.test(sql)) {
        rows.delete(params[0]);
      } else if (/^DELETE FROM public\.paie_unlock_sessions$/.test(sql.trim())) {
        rows.clear();
      }
      return { rows: [] };
    },
  };
}

function freshSalaryCrypto() {
  delete require.cache[require.resolve('../../services/paie/salaryCrypto')];
  return require('../../services/paie/salaryCrypto');
}

test('unlock sessions survive a backend restart via the DB, without storing the key or token', async () => {
  const pool = fakeSessionPool();
  const before = freshSalaryCrypto();
  await before.attachUnlockSessionStore(pool);
  const key = before.deriveKey('code', before.generateSalt());
  const { token } = await before.createUnlockSession(key);

  // What's stored can't give back the key or the token.
  const [[hash, row]] = [...pool.rows.entries()];
  assert.ok(!hash.includes(token) && !row.wrapped_key.includes(token));
  assert.ok(!row.wrapped_key.includes(key.toString('hex')));

  // "Restart": a brand new module instance with empty memory, same DB.
  const after = freshSalaryCrypto();
  await after.attachUnlockSessionStore(pool);
  assert.equal(after.getUnlockKey(token), null);
  await after.restoreUnlockSession(token);
  assert.ok(after.getUnlockKey(token).equals(key));

  // A wrong token restores nothing; lock removes it from the DB too.
  await after.restoreUnlockSession('f'.repeat(48));
  assert.equal(after.getUnlockKey('f'.repeat(48)), null);
  after.revokeUnlockSession(token);
  await new Promise((r) => setImmediate(r));
  assert.equal(pool.rows.size, 0);
});
