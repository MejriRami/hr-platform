// config/dbEnv.cjs
// Lets a run override the database from the command line with a single
// DATABASE_URL (e.g. a local Postgres copy) instead of the DB_* values in
// .env / .env.local, which point at production.
//
//   DATABASE_URL=postgresql://user:pass@localhost:5433/rh_application npm start
//
// When DATABASE_URL is set it wins over DB_USER/DB_PASSWORD/DB_HOST/DB_PORT/
// DB_NAME, so every pool built from those vars (main pool, routes, KPI pools)
// follows it. SSL is disabled automatically for localhost hosts; force it with
// DB_SSL=true|false.

function applyDatabaseUrl() {
  const raw = process.env.DATABASE_URL;
  if (!raw) return;
  const url = new URL(raw);
  process.env.DB_USER = decodeURIComponent(url.username);
  process.env.DB_PASSWORD = decodeURIComponent(url.password);
  process.env.DB_PASS = process.env.DB_PASSWORD;
  process.env.DB_HOST = url.hostname;
  process.env.DB_PORT = url.port || '5432';
  process.env.DB_NAME = decodeURIComponent(url.pathname.replace(/^\//, ''));
}

function dbSsl() {
  const flag = String(process.env.DB_SSL || '').toLowerCase();
  if (flag === 'false' || flag === '0' || flag === 'off') return false;
  if (flag === 'true' || flag === '1' || flag === 'on') return { require: true, rejectUnauthorized: false };
  const host = String(process.env.DB_HOST || '').toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;
  return { require: true, rejectUnauthorized: false };
}

applyDatabaseUrl();

module.exports = { applyDatabaseUrl, dbSsl };
