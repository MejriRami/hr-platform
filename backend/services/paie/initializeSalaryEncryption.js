'use strict';

/**
 * One-time initial setup of Tunisia salary/allowance encryption -- widens
 * the target columns from NUMERIC to TEXT and encrypts every existing value
 * under a freshly chosen code. Shared by the in-app POST
 * /api/paie/initialize-code endpoint (server.js) and
 * scripts/setup-salary-encryption.js (CLI, for anyone who prefers it), so
 * the two can't drift out of sync.
 *
 * Originally CLI-only, on the reasoning that the code shouldn't transit
 * HTTP before any protection exists yet. Revisited: the code already
 * transits this same authenticated HTTPS connection on every /unlock and
 * /rotate-code call, so gating the very first setup any more strictly than
 * those doesn't add real security -- it just made the one HR manager who
 * actually needs to do this (no technical background) depend on someone
 * else to run a terminal command for them.
 */

const { generateSalt, deriveKey, computeVerifier, encryptValue } = require('./salaryCrypto');
const { PUBLIC_EMPLOYEES_COLUMNS, PAIE_EMPLOYEE_CONFIG_COLUMNS } = require('./salaryCryptoColumns');

const MIN_CODE_LENGTH = 8;

/** Widens `columns` to TEXT (values become their plaintext string form first, still readable), then encrypts every row's values under `key`. */
async function encryptTableInPlace(client, tableName, idColumn, columns, key) {
  for (const col of columns) {
    await client.query(`ALTER TABLE ${tableName} ALTER COLUMN ${col} TYPE TEXT USING ${col}::text`);
  }

  const rows = (await client.query(`SELECT ${idColumn}, ${columns.join(', ')} FROM ${tableName}`)).rows;
  for (const row of rows) {
    const setClauses = columns.map((col, i) => `${col} = $${i + 2}`).join(', ');
    const values = columns.map((col) => encryptValue(row[col], key));
    await client.query(`UPDATE ${tableName} SET ${setClauses} WHERE ${idColumn} = $1`, [row[idColumn], ...values]);
  }

  return rows.length;
}

/**
 * Refuses (with a `.statusCode`) if encryption is already configured, or if
 * `code` is missing/too short. Otherwise widens + encrypts both target
 * tables and stores the new salt/verifier, all inside one transaction on a
 * dedicated client checked out from `pool`.
 */
async function initializeSalaryEncryption(pool, code) {
  const client = await pool.connect();
  try {
    const existing = await client.query('SELECT id FROM public.paie_encryption_config LIMIT 1');
    if (existing.rows.length > 0) {
      throw Object.assign(new Error('Le chiffrement des données de paie est déjà configuré.'), { statusCode: 409 });
    }
    if (!code || typeof code !== 'string' || code.length < MIN_CODE_LENGTH) {
      throw Object.assign(new Error(`Le code doit contenir au moins ${MIN_CODE_LENGTH} caractères.`), { statusCode: 400 });
    }

    const salt = generateSalt();
    const key = deriveKey(code, salt);
    const verifier = computeVerifier(key);

    await client.query('BEGIN');
    const employeesCount = await encryptTableInPlace(client, 'public.employees', 'id', PUBLIC_EMPLOYEES_COLUMNS, key);
    const configCount = await encryptTableInPlace(client, 'schema_tn.paie_employee_config', 'id', PAIE_EMPLOYEE_CONFIG_COLUMNS, key);
    await client.query(
      'INSERT INTO public.paie_encryption_config (salt, verifier) VALUES ($1, $2)',
      [salt, verifier]
    );
    await client.query('COMMIT');

    return { employeesCount, configCount, key };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      // No transaction was open yet (e.g. the "already configured" check
      // failed before BEGIN) -- not worth surfacing over the real error.
    }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { initializeSalaryEncryption, encryptTableInPlace, MIN_CODE_LENGTH };
