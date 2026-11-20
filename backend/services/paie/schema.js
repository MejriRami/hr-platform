'use strict';

/**
 * Payroll tables, created idempotently at startup — same convention this
 * app already uses for schema evolution (see ensureVisaGeneratedColumns()
 * etc. in server.js), rather than a separate migration tool.
 *
 * Deliberately NOT touching the shared `employees` table (used by 8 other
 * country schemas and every other HR feature): payroll-only fields live
 * in their own table, FK'd to employees.id. `salaire_base` gets its own
 * NUMERIC(12,3) here because the existing `employees.salaire_brute` is
 * only DECIMAL(10,2) — 2 decimals, not the 3 (millimes) the dinar needs.
 */

// Every tenant schema (2026-11-18: same modules for every tenant).
// NB: the payroll engine itself implements Tunisian rules (CNSS/IRPP/CSS),
// so figures for the other countries follow those rules too.
const { ALL_EMPLOYEE_SCHEMAS } = require('../../middleware/tenantScope.cjs');
const PAIE_SCHEMAS = ALL_EMPLOYEE_SCHEMAS;

async function ensurePaieTablesForSchema(pool, schema) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${schema}.paie_employee_config (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER NOT NULL REFERENCES ${schema}.employees(id) ON DELETE CASCADE,
      matricule VARCHAR(50) NOT NULL,
      contract_type VARCHAR(10) NOT NULL DEFAULT 'CDI',
      chef_famille BOOLEAN NOT NULL DEFAULT false,
      nb_enfants INTEGER NOT NULL DEFAULT 0,
      salaire_base NUMERIC(12,3) NOT NULL DEFAULT 0,
      indemnites_imposables NUMERIC(12,3) NOT NULL DEFAULT 0,
      indemnites_non_imposables NUMERIC(12,3) NOT NULL DEFAULT 0,
      acompte NUMERIC(12,3) NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (employee_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${schema}.paie_imported_period (
      id SERIAL PRIMARY KEY,
      periode_debut DATE NOT NULL,
      periode_fin DATE NOT NULL,
      expected_hours NUMERIC(8,1) NOT NULL,
      day_columns_count INTEGER NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (periode_debut, periode_fin)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${schema}.paie_attendance_period (
      id SERIAL PRIMARY KEY,
      periode_debut DATE NOT NULL,
      periode_fin DATE NOT NULL,
      matricule VARCHAR(50) NOT NULL,
      employe VARCHAR(200) NOT NULL,
      employee_id INTEGER REFERENCES ${schema}.employees(id) ON DELETE SET NULL,
      payable_minutes INTEGER NOT NULL,
      conge_days NUMERIC(6,1) NOT NULL,
      feries_days NUMERIC(6,1) NOT NULL,
      jours_presents NUMERIC(6,1) NOT NULL DEFAULT 0,
      retards INTEGER NOT NULL DEFAULT 0,
      file_total_heures_minutes INTEGER,
      file_total_conges_days NUMERIC(6,1),
      file_total_feries_days NUMERIC(6,1),
      unparsed_count INTEGER NOT NULL DEFAULT 0,
      requires_manual_review BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (periode_debut, periode_fin, matricule)
    )
  `);

  // Ad-hoc column addition for tables created before employee_id existed
  // -- same "ALTER TABLE IF NOT EXISTS" convention this app already uses
  // elsewhere instead of a formal migration tool.
  await pool.query(`
    ALTER TABLE ${schema}.paie_attendance_period
      ADD COLUMN IF NOT EXISTS employee_id INTEGER REFERENCES ${schema}.employees(id) ON DELETE SET NULL
  `);

  // jours_presents: the discrete WORKED/MISSION/CONGE_DEMI day-kind count
  // presenceFraction is now computed from (see computePresenceFraction in
  // services/paie/paie.js) -- CONFIRMED 2026-09-28 against a real
  // September 2026 source workbook that this, not summed hours divided by
  // 8, is what the real "J. PRESENCE" figure actually is. DEFAULT 0 so the
  // ADD COLUMN succeeds on an already-populated table; existing rows will
  // read as 0 presence until their period is re-imported.
  await pool.query(`
    ALTER TABLE ${schema}.paie_attendance_period
      ADD COLUMN IF NOT EXISTS jours_presents NUMERIC(6,1) NOT NULL DEFAULT 0
  `);

  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_${schema}_paie_attendance_period_lookup
       ON ${schema}.paie_attendance_period (periode_debut, periode_fin)`
  );

  // "Journal de paie" validation (Jamie, 2026-10-26: a verification report
  // before payslips may be printed). One row per validation; the latest row
  // for a period is the one that counts. No amounts here -- only a SHA-256
  // fingerprint of the validated figures (see services/paie/journal.js), so
  // a recalculation whose numbers differ no longer counts as validated.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${schema}.paie_journal_validation (
      id SERIAL PRIMARY KEY,
      periode_debut DATE NOT NULL,
      periode_fin DATE NOT NULL,
      mois_paie VARCHAR(7) NOT NULL,
      fingerprint CHAR(64) NOT NULL,
      nb_bulletins INTEGER NOT NULL,
      validated_by TEXT NOT NULL,
      validated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_${schema}_paie_journal_validation_period
       ON ${schema}.paie_journal_validation (periode_debut, periode_fin, validated_at DESC)`
  );

  // Solde de tout compte: one row per departing employee whose LAST period
  // is paid in the settlement cheque instead of the month's payroll (HR's
  // choice on the Solde de tout compte screen, "cas B"). /calculer leaves
  // these employees out of that month's journal/bulletins so the worked
  // days are never paid twice. No row = the month is paid in the normal
  // payroll ("cas A"). No amounts here.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${schema}.paie_solde_tout_compte (
      id SERIAL PRIMARY KEY,
      matricule VARCHAR(50) NOT NULL,
      periode_debut DATE NOT NULL,
      periode_fin DATE NOT NULL,
      mois_paie VARCHAR(7) NOT NULL,
      updated_by TEXT NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (matricule, periode_debut, periode_fin)
    )
  `);
}

async function ensurePaieTables(pool) {
  for (const schema of PAIE_SCHEMAS) {
    try {
      await ensurePaieTablesForSchema(pool, schema);
      console.log(`✅ Tables paie prêtes (${schema})`);
    } catch (err) {
      console.error(`❌ Erreur création tables paie (${schema}):`, err.message);
    }
  }
}

// Prime de Gratification -- SAHEL (public) only, per Jamie's memo: this is an
// SAHEL collective-agreement bonus, not shared with CARTHAGE/schema_tn like the
// rest of the paie module. Deliberately not looped over PAIE_SCHEMAS.
// note_total (0-20) is intentionally NOT stored -- it's the sum of the 4
// sub-scores below, computed on read so it can never drift from them.
//
// `role` ('hierarchique' | 'fonctionnel') was added 2026-09-30 (the developer: the
// two managers' notes should be combined, not one silently overwriting the
// other) -- each manager role now gets its OWN row per (employee, annee),
// so both can submit independently. The final note used in the prime
// calculation is the average of both roles' totals when an employee has
// both managers on file, or the lone role's total when only one manager
// is assigned -- see routes/gratification.cjs.
async function ensureGratificationTable(pool) {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.paie_gratification_evaluations (
        id SERIAL PRIMARY KEY,
        employee_id INTEGER NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
        annee INTEGER NOT NULL,
        role VARCHAR(20) NOT NULL DEFAULT 'hierarchique',
        note_delais NUMERIC(3,1) NOT NULL,
        note_qualite NUMERIC(3,1) NOT NULL,
        note_attitude NUMERIC(3,1) NOT NULL,
        note_rigueur NUMERIC(3,1) NOT NULL,
        submitted_by_email TEXT NOT NULL,
        submitted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (employee_id, annee, role)
      )
    `);
    // Ad-hoc migration for a table created before `role` existed -- same
    // "ALTER TABLE IF NOT EXISTS" convention used elsewhere in this app.
    // No real submissions existed yet when this was added, so there's no
    // data to reconcile -- just widen the schema.
    await pool.query(`
      ALTER TABLE public.paie_gratification_evaluations
        ADD COLUMN IF NOT EXISTS role VARCHAR(20) NOT NULL DEFAULT 'hierarchique'
    `);
    await pool.query(`
      ALTER TABLE public.paie_gratification_evaluations
        DROP CONSTRAINT IF EXISTS paie_gratification_evaluations_employee_id_annee_key
    `);
    // Postgres has no "ADD CONSTRAINT IF NOT EXISTS" -- check first so this
    // stays safe to run on every server start, same as everything else in
    // this function.
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'paie_gratification_evaluations_employee_id_annee_role_key'
        ) THEN
          ALTER TABLE public.paie_gratification_evaluations
            ADD CONSTRAINT paie_gratification_evaluations_employee_id_annee_role_key
            UNIQUE (employee_id, annee, role);
        END IF;
      END $$;
    `);
    console.log('✅ Table paie_gratification_evaluations prête (public)');
  } catch (err) {
    console.error('❌ Erreur création table paie_gratification_evaluations:', err.message);
  }
}

// Holds ONLY crypto metadata (a random salt + a verifier hash) for the
// secret code that unlocks Tunisia salary/allowance decryption -- never the
// code itself, never a key. Safe to auto-create like every other table
// here: an empty row here reveals nothing. Populated once by
// scripts/setup-salary-encryption.js, which also converts the salary
// columns themselves from NUMERIC to TEXT (ciphertext) -- this function
// does NOT do that conversion, since it must only ever run once, manually,
// with a fresh backup, never on every server start like the tables above.
async function ensureEncryptionConfigTable(pool) {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.paie_encryption_config (
        id SERIAL PRIMARY KEY,
        salt TEXT NOT NULL,
        verifier TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Table paie_encryption_config prête (public)');
  } catch (err) {
    console.error('❌ Erreur création table paie_encryption_config:', err.message);
  }
}

module.exports = { ensurePaieTables, ensureGratificationTable, ensureEncryptionConfigTable, PAIE_SCHEMAS };
