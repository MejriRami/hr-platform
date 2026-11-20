'use strict';

/**
 * Shared re-encryption logic used by both scripts/rotate-salary-encryption-code.js
 * (CLI, interactive) and the in-app POST /api/paie/rotate-code endpoint
 * (server.js). Kept here so the two call sites can't drift out of sync on
 * what "rotate" actually does.
 */

const { generateSalt, deriveKey, computeVerifier, checkCode, encryptValue, decryptValue } = require('./salaryCrypto');
const { PUBLIC_EMPLOYEES_COLUMNS, PAIE_EMPLOYEE_CONFIG_COLUMNS } = require('./salaryCryptoColumns');

/** Re-encrypts one table's target columns under `newKey`. Throws (never partially applies within the row loop) if any non-null value fails to decrypt with `oldKey`. */
async function rotateTable(client, tableName, idColumn, columns, oldKey, newKey) {
  const rows = (await client.query(`SELECT ${idColumn}, ${columns.join(', ')} FROM ${tableName}`)).rows;

  for (const row of rows) {
    const reencrypted = {};
    for (const col of columns) {
      const stored = row[col];
      if (stored === null || stored === undefined) {
        reencrypted[col] = null;
        continue;
      }
      const plaintext = decryptValue(stored, oldKey);
      if (plaintext === null) {
        throw new Error(`Failed to decrypt ${tableName}.${col} for ${idColumn}=${row[idColumn]} with the current code.`);
      }
      reencrypted[col] = encryptValue(plaintext, newKey);
    }

    const setClauses = columns.map((col, i) => `${col} = $${i + 2}`).join(', ');
    const values = columns.map((col) => reencrypted[col]);
    await client.query(`UPDATE ${tableName} SET ${setClauses} WHERE ${idColumn} = $1`, [row[idColumn], ...values]);
  }

  return rows.length;
}

/**
 * Verifies `oldCode` against the stored salt/verifier, then re-encrypts
 * every Tunisia salary/allowance value under a freshly generated key
 * derived from `newCode` -- all inside one transaction on a dedicated
 * client checked out from `pool`. Throws (with a `.statusCode`) rather than
 * partially applying if the old code is wrong, the new code is invalid, or
 * any value fails to decrypt.
 */
async function rotateSalaryEncryptionCode(pool, oldCode, newCode) {
  const client = await pool.connect();
  try {
    const configResult = await client.query(
      'SELECT id, salt, verifier FROM public.paie_encryption_config ORDER BY id DESC LIMIT 1'
    );
    if (configResult.rows.length === 0) {
      throw Object.assign(new Error("Le chiffrement des données de paie n'a pas encore été configuré."), { statusCode: 409 });
    }
    const { id: configId, salt: oldSalt, verifier: oldVerifier } = configResult.rows[0];

    const oldKey = checkCode(oldCode, oldSalt, oldVerifier);
    if (!oldKey) {
      throw Object.assign(new Error('Le code actuel est incorrect.'), { statusCode: 401 });
    }
    if (!newCode || typeof newCode !== 'string' || newCode === oldCode) {
      throw Object.assign(new Error('Le nouveau code doit être non vide et différent du code actuel.'), { statusCode: 400 });
    }

    const newSalt = generateSalt();
    const newKey = deriveKey(newCode, newSalt);
    const newVerifier = computeVerifier(newKey);

    await client.query('BEGIN');
    const employeesCount = await rotateTable(client, 'public.employees', 'id', PUBLIC_EMPLOYEES_COLUMNS, oldKey, newKey);
    const configCount = await rotateTable(client, 'schema_tn.paie_employee_config', 'id', PAIE_EMPLOYEE_CONFIG_COLUMNS, oldKey, newKey);
    await client.query(
      'UPDATE public.paie_encryption_config SET salt = $1, verifier = $2, created_at = CURRENT_TIMESTAMP WHERE id = $3',
      [newSalt, newVerifier, configId]
    );
    await client.query('COMMIT');

    return { employeesCount, configCount, newKey };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      // No transaction was open yet (e.g. the old-code check failed before
      // BEGIN) -- Postgres just notices this, it's not an error worth
      // surfacing over the original one.
    }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { rotateTable, rotateSalaryEncryptionCode };
