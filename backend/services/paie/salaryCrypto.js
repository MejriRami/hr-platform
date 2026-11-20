'use strict';

/**
 * AES-256-GCM encryption for Tunisia salary/allowance fields, keyed by a
 * secret code only Jamie and the developer know (per PAIE_SALARY_AUTHORIZED_EMAILS
 * in middleware/tenantScope.cjs). The code itself is NEVER stored -- see
 * paie_encryption_config (services/paie/schema.js) for the salt + verifier
 * used to confirm a submitted code without persisting it, and
 * scripts/setup-salary-encryption.js for the one-time setup/migration that
 * populates that table.
 *
 * The derived AES key lives ONLY in the in-memory unlock-session map below
 * and is lost on server restart -- deliberate: nothing that could
 * reconstruct the key ever touches disk. There is no code-recovery or
 * rotation mechanism (see the plan notes) -- if the code is lost, encrypted
 * values are permanently unreadable, by explicit choice.
 */

const crypto = require('crypto');
const Decimal = require('decimal.js');

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 12; // standard for GCM
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1 };
const VERIFIER_PLAINTEXT = 'paie-encryption-verifier-v1';
const UNLOCK_SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours, sliding on use

function generateSalt() {
  return crypto.randomBytes(16).toString('hex');
}

function deriveKey(code, saltHex) {
  const salt = Buffer.from(saltHex, 'hex');
  return crypto.scryptSync(String(code), salt, KEY_LENGTH, SCRYPT_OPTIONS);
}

function computeVerifier(key) {
  return crypto.createHmac('sha256', key).update(VERIFIER_PLAINTEXT).digest('hex');
}

/** Returns the derived key if `code` matches the stored verifier, else null. */
function checkCode(code, saltHex, verifierHex) {
  const key = deriveKey(code, saltHex);
  const expected = Buffer.from(computeVerifier(key), 'hex');
  const received = Buffer.from(String(verifierHex || ''), 'hex');
  const matches = expected.length === received.length && crypto.timingSafeEqual(expected, received);
  return matches ? key : null;
}

function encryptValue(value, key) {
  if (value === null || value === undefined) return null;
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
}

/** Returns the decrypted string, or null if locked/corrupted/wrong key -- never throws. */
function decryptValue(stored, key) {
  if (stored === null || stored === undefined) return null;
  if (!key) return null;
  const parts = String(stored).split(':');
  if (parts.length !== 3) return null;
  const [ivHex, authTagHex, ciphertextHex] = parts;
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextHex, 'hex')), decipher.final()]);
    return plaintext.toString('utf8');
  } catch (err) {
    return null;
  }
}

/** Convenience: decrypt straight into a Decimal, matching decimalOrZero's shape. Locked/missing -> Decimal(0). */
function decryptDecimalOrZero(stored, key) {
  const raw = decryptValue(stored, key);
  return raw === null ? new Decimal(0) : new Decimal(raw);
}

// --- Unlock sessions ---------------------------------------------------------
//
// Kept in memory for speed AND in public.paie_unlock_sessions so an unlock
// survives a backend restart/deploy and works on every Azure instance --
// before, a restart silently locked Jamie out mid-session and the app looked
// like it had "refused" his code.
//
// What the table holds is safe to leak: never the secret code (it's thrown
// away right after deriveKey), only
//   token_hash  = SHA-256 of the session token (can't be reversed), and
//   wrapped_key = the data key encrypted (AES-256-GCM) with a key derived
//                 from the session token.
// The token itself (192 random bits) lives only in the user's browser, so
// the database alone can't recover the data key.

const unlockSessions = new Map(); // token -> { key: Buffer, expiresAt: number, persistedAt: number }
const SESSION_DB_REFRESH_MS = 5 * 60 * 1000; // push the sliding expiry to the DB at most every 5 min

let sessionStore = null; // pg Pool, set by attachUnlockSessionStore()

const tokenHash = (token) => crypto.createHash('sha256').update(`paie-session-id:${token}`).digest('hex');
const tokenWrapKey = (token) => crypto.createHash('sha256').update(`paie-session-wrap:${token}`).digest();

function wrapKey(key, token) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, tokenWrapKey(token), iv);
  const ciphertext = Buffer.concat([cipher.update(key), cipher.final()]);
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${ciphertext.toString('hex')}`;
}

function unwrapKey(wrapped, token) {
  try {
    const [ivHex, tagHex, ctHex] = String(wrapped).split(':');
    const decipher = crypto.createDecipheriv(ALGORITHM, tokenWrapKey(token), Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(ctHex, 'hex')), decipher.final()]);
  } catch {
    return null;
  }
}

async function attachUnlockSessionStore(pool) {
  sessionStore = pool;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.paie_unlock_sessions (
        token_hash TEXT PRIMARY KEY,
        wrapped_key TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query('DELETE FROM public.paie_unlock_sessions WHERE expires_at < NOW()');
  } catch (err) {
    console.error('❌ paie_unlock_sessions:', err.message);
  }
}

function persistExpiry(token, expiresAt) {
  if (!sessionStore) return Promise.resolve();
  return sessionStore
    .query('UPDATE public.paie_unlock_sessions SET expires_at = to_timestamp($2 / 1000.0) WHERE token_hash = $1', [tokenHash(token), expiresAt])
    .catch((err) => console.error('❌ paie_unlock_sessions refresh:', err.message));
}

/** Creates a session, saved to the DB before resolving (so any instance can use it right away). */
async function createUnlockSession(key) {
  const token = crypto.randomBytes(24).toString('hex');
  const expiresAt = Date.now() + UNLOCK_SESSION_TTL_MS;
  unlockSessions.set(token, { key, expiresAt, persistedAt: Date.now() });
  if (sessionStore) {
    try {
      await sessionStore.query(
        'INSERT INTO public.paie_unlock_sessions (token_hash, wrapped_key, expires_at) VALUES ($1, $2, to_timestamp($3 / 1000.0))',
        [tokenHash(token), wrapKey(key, token), expiresAt]
      );
      sessionStore.query('DELETE FROM public.paie_unlock_sessions WHERE expires_at < NOW()').catch(() => {});
    } catch (err) {
      // Still works on this instance (in memory), just won't survive a restart.
      console.error('❌ paie_unlock_sessions insert:', err.message);
    }
  }
  return { token, expiresAt };
}

/**
 * Loads a session this instance doesn't know (restart, other instance) from
 * the DB into memory. Called by a middleware before the routes run, so the
 * synchronous getUnlockKey() below keeps working everywhere unchanged.
 */
async function restoreUnlockSession(token) {
  if (!token || !sessionStore || unlockSessions.has(token)) return;
  try {
    const result = await sessionStore.query(
      'SELECT wrapped_key, expires_at FROM public.paie_unlock_sessions WHERE token_hash = $1 AND expires_at > NOW()',
      [tokenHash(token)]
    );
    if (result.rows.length === 0) return;
    const key = unwrapKey(result.rows[0].wrapped_key, token);
    if (!key) return;
    unlockSessions.set(token, { key, expiresAt: new Date(result.rows[0].expires_at).getTime(), persistedAt: Date.now() });
  } catch (err) {
    console.error('❌ paie_unlock_sessions restore:', err.message);
  }
}

/** Returns the session's key and extends its expiry, or null if missing/expired. */
function getUnlockKey(token) {
  if (!token) return null;
  const session = unlockSessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    unlockSessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + UNLOCK_SESSION_TTL_MS;
  if (Date.now() - session.persistedAt > SESSION_DB_REFRESH_MS) {
    session.persistedAt = Date.now();
    persistExpiry(token, session.expiresAt);
  }
  return session.key;
}

function revokeUnlockSession(token) {
  unlockSessions.delete(token);
  if (sessionStore && token) {
    sessionStore.query('DELETE FROM public.paie_unlock_sessions WHERE token_hash = $1', [tokenHash(token)])
      .catch((err) => console.error('❌ paie_unlock_sessions delete:', err.message));
  }
}

/** After a code rotation every existing session holds the OLD key -- drop them all. */
async function revokeAllUnlockSessions() {
  unlockSessions.clear();
  if (sessionStore) {
    await sessionStore.query('DELETE FROM public.paie_unlock_sessions')
      .catch((err) => console.error('❌ paie_unlock_sessions clear:', err.message));
  }
}

module.exports = {
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
  attachUnlockSessionStore,
  restoreUnlockSession,
  revokeAllUnlockSessions,
};
