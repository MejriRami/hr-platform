'use strict';

/**
 * HR <-> KPI role sync, hosted by the HR app (2026-10-26). It used to
 * run as Python background threads in External_certifcation_backend, then in
 * Audit-Management-Backend -- unrelated apps that only hosted it.
 *
 *   worker.js            live sync over LISTEN/NOTIFY (poste <-> primary role,
 *                        archive -> assignments ended, manager -> reports_to)
 *   identityMapBuild.js  daily HR employee <-> KPI person matching
 *
 * Both talk to the HR database (this app's DB_*) and the KPI database
 * (KPI_DB_NAME, default KPI_DB_Final) on the same server. Advisory locks
 * keep a single active copy across every instance -- and across a Python
 * copy still running elsewhere, which uses the same lock keys.
 *
 * Runs only against the production HR database (rh_application). A local or
 * test run (e.g. rh_application_test from .env.local) stays off unless
 * HR_KPI_SYNC=on, and is refused if it would pair a test HR database with
 * the production KPI one (or the reverse). HR_KPI_SYNC=off disables it.
 */

const identityMapBuild = require('./identityMapBuild');
const worker = require('./worker');

const PROD_HR_DB = 'rh_application';
const PROD_KPI_DB = 'KPI_DB_Final';

function syncConfigs(dbConfig) {
  const { user, host, password, port, ssl } = dbConfig;
  const base = { user, host, password, port, ssl, connectionTimeoutMillis: 10000 };
  return {
    hrConfig: { ...base, database: dbConfig.database },
    kpiConfig: { ...base, database: process.env.KPI_DB_NAME || PROD_KPI_DB }
  };
}

// Returns a stop function, or null when the sync is disabled. Never throws:
// a broken sync config must not take the HR app down with it.
function startHrKpiSync(dbConfig) {
  try {
    const mode = String(process.env.HR_KPI_SYNC || '').trim().toLowerCase();
    const { hrConfig, kpiConfig } = syncConfigs(dbConfig);
    const hrIsProd = hrConfig.database === PROD_HR_DB;
    const kpiIsProd = kpiConfig.database === PROD_KPI_DB;

    if (mode === 'off') {
      console.log('[hr-kpi-sync] disabled (HR_KPI_SYNC=off)');
      return null;
    }
    if (!hrIsProd && mode !== 'on') {
      console.log(`[hr-kpi-sync] disabled: HR database is ${hrConfig.database}, not ${PROD_HR_DB} (HR_KPI_SYNC=on to run it against test databases)`);
      return null;
    }
    if (hrIsProd !== kpiIsProd) {
      console.error(`[hr-kpi-sync] refused: HR database ${hrConfig.database} and KPI database ${kpiConfig.database} must both be production or both be test copies`);
      return null;
    }

    console.log(`[hr-kpi-sync] starting: HR=${hrConfig.database} KPI=${kpiConfig.database}`);
    const stopIdentityMap = identityMapBuild.start(hrConfig, kpiConfig);
    const stopWorker = worker.start(hrConfig, kpiConfig);
    return () => {
      stopIdentityMap();
      stopWorker();
    };
  } catch (err) {
    console.error('[hr-kpi-sync] could not start:', err.message);
    return null;
  }
}

module.exports = { startHrKpiSync, syncConfigs };
