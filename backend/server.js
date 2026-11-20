// server.js
require('dotenv').config({ path: __dirname + '/.env' });
// .env.local is gitignored (never committed, never deployed) -- lets a
// developer point their own local run at a different database (e.g.
// rh_application_test, see scripts/) without touching the tracked .env
// file, which is pushed to Azure. override:true so it takes priority over
// .env; on Azure this file simply doesn't exist, so this line is a no-op
// in production.
require('dotenv').config({ path: __dirname + '/.env.local', override: true });
// DATABASE_URL passed on the command line overrides the DB_* values above.
const { dbSsl } = require('./config/dbEnv.cjs');

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const compression = require('compression');
const path = require('path');
const fs = require('fs');
const PDFKitDocument = require('pdfkit');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const app = express();
const PORT = Number(process.env.PORT || 5000);

// =========================
// LOG BUFFER EN MÉMOIRE (lecture via /api/logs)
// =========================
const LOG_BUFFER_MAX = 1000;
const logBuffer = [];
function pushLog(level, args) {
  const message = args
    .map(a => {
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a); } catch { return String(a); }
    })
    .join(' ');
  logBuffer.push({ timestamp: new Date().toISOString(), level, message });
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
}
['log', 'error', 'warn', 'info'].forEach(level => {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    pushLog(level, args);
    original(...args);
  };
});

// =========================
// CONFIGURATION FIXE POUR OUTLOOK
// =========================
const SMTP_HOST = "northwind-com.mail.protection.outlook.com";
const SMTP_PORT = 25;
const EMAIL_FROM_NAME = "Administration SAHEL";
const EMAIL_FROM = "morgan.martin@example.com";
const RH_ADMIN_EMAIL = "noel.rossi@example.com";
const DEMANDE_STATUS_ANNULEE = "annulee";

console.log('📧 Configuration SMTP Outlook:', {
  host: SMTP_HOST,
  port: SMTP_PORT,
  from: EMAIL_FROM,
  fromName: EMAIL_FROM_NAME
});

// Configuration du transporteur email
const emailTransporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: false,
  tls: { 
    ciphers: 'SSLv3',
    rejectUnauthorized: false 
  },
  connectionTimeout: 10000,
  greetingTimeout: 10000,
  socketTimeout: 10000,
  debug: process.env.NODE_ENV === 'development'
});
// =========================
// JOB PLANIFIÉ POUR LES ALERTES
// =========================

// Vérifier les alertes au démarrage
setTimeout(() => {
  checkContractEndAlerts();
}, 10000); // Attendre 10s après le démarrage

// Vérifier les alertes chaque jour à 8h00
setInterval(() => {
  const now = new Date();
  if (now.getHours() === 8 && now.getMinutes() === 0) {
    checkContractEndAlerts();
  }
}, 60000); // Vérifier chaque minute
// =========================
// Configuration de la base
// =========================

const dbConfig = {
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: Number(process.env.DB_PORT || 5432),
  ssl: dbSsl(),
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000
};

console.log('🔧 Configuration de la base de données:', {
  user: dbConfig.user,
  host: dbConfig.host,
  database: dbConfig.database,
  port: dbConfig.port,
  ssl: dbConfig.ssl ? 'Activé' : 'Désactivé',
  password: dbConfig.password ? '✅ Présent' : '❌ Manquant'
});

const pool = new Pool(dbConfig);

// pg emits 'error' on an idle client whenever the connection drops (Azure
// resets idle connections periodically) -- with no listener, that's an
// unhandled EventEmitter error and Node kills the whole process on the next
// one, taking down every in-flight request, not just the affected query.
pool.on('error', (err) => {
  console.error('⚠️ Erreur inattendue sur une connexion PostgreSQL inactive:', err.message);
});

// =========================
// Logs de configuration
// =========================

console.log('🔧 Variables d\'environnement:', {
  DB_USER: process.env.DB_USER || '❌ Manquant',
  DB_HOST: process.env.DB_HOST || '❌ Manquant',
  DB_NAME: process.env.DB_NAME || '❌ Manquant',
  DB_PORT: process.env.DB_PORT || '5432 (défaut)',
  JWT_SECRET: process.env.JWT_SECRET ? '✅ Défini' : '❌ Manquant',
  FRONTEND_URL: process.env.FRONTEND_URL || '❌ Non défini',
  NODE_ENV: process.env.NODE_ENV || 'development'
});

// JWT secret
const JWT_SECRET = process.env.JWT_SECRET;

if (!process.env.JWT_SECRET) {
  console.warn('⚠️  JWT_SECRET non défini dans .env - utilisation d\'un secret de développement');
}

// =========================
// Middleware globaux
// =========================

const allowedOrigins = [
  'http://localhost:3000',
  'https://your-app.azurewebsites.net'
];

if (process.env.FRONTEND_URL && !allowedOrigins.includes(process.env.FRONTEND_URL)) {
  allowedOrigins.push(process.env.FRONTEND_URL);
}

const corsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    } else {
      console.warn('🚫 Origin non autorisée par CORS:', origin);
      return callback(null, false);
    }
  },
  credentials: true
};

app.use(cors(corsOptions));
// gzip JSON responses: the group HR employee list is ~1.8 MB raw, ~10x less gzipped.
app.use(compression());
app.options('*', cors(corsOptions));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Paie unlock sessions also live in the DB (services/paie/salaryCrypto.js)
// so they survive restarts/deploys and work on every instance. If this
// instance doesn't know the request's unlock token yet, load it before any
// route runs -- every route then uses the synchronous getUnlockKey() as before.
app.use(async (req, res, next) => {
  const token = req.headers['x-paie-unlock-token'];
  if (token) await require('./services/paie/salaryCrypto.js').restoreUnlockSession(String(token));
  next();
});

// =========================
// Configuration des dossiers
// =========================

const uploadTempDir = path.join(__dirname, 'uploads', 'temp');
const pdfStorageDir = path.join(__dirname, 'uploads', 'pdfs');
const employeePhotoDir = path.join(__dirname, 'uploads', 'employee-photos');
const archivePdfDir = path.join(__dirname, 'uploads', 'archive-pdfs');
const uploadPaieDir = path.join(__dirname, 'uploads', 'paie');

// Créer les dossiers s'ils n'existent pas
[uploadTempDir, pdfStorageDir, employeePhotoDir, archivePdfDir, uploadPaieDir].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`📁 Dossier créé: ${dir}`);
  }
});

// =========================
// Configuration Multer pour les PDF d'archive
// =========================

const archivePdfStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, archivePdfDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, 'archive-' + uniqueSuffix + '.pdf');
  }
});

const archivePdfUpload = multer({
  storage: archivePdfStorage,
  limits: {
    fileSize: 2000 * 1024 * 1024 // 200MB max
  },
  fileFilter: function (req, file, cb) {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Seuls les fichiers PDF sont autorisés!'), false);
    }
  }
});

// =========================
// Configuration Multer upload (Dossier RH)
// =========================

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadTempDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, 'photo-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5000 * 1024 * 1024 // 1000MB max
  },
  fileFilter: function (req, file, cb) {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Seules les images sont autorisées!'), false);
    }
  }
});
// Nouvelle configuration Multer pour accepter images ET PDFs
const dossierFileStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadTempDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, 'dossier-file-' + uniqueSuffix + ext);
  }
});

const dossierFileUpload = multer({
  storage: dossierFileStorage,
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB max
  },
  fileFilter: function (req, file, cb) {
    // Accepter images ET PDFs
    if (
      file.mimetype.startsWith('image/') ||
      file.mimetype === 'application/pdf' ||
      file.originalname.toLowerCase().endsWith('.pdf')
    ) {
      cb(null, true);
    } else {
      cb(new Error('Seules les images et les fichiers PDF sont autorisés!'), false);
    }
  }
});


// =========================
// Configuration pour photos employés
// =========================

const employeePhotoStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, employeePhotoDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, 'employee-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const employeePhotoUpload = multer({
  storage: employeePhotoStorage,
  limits: {
    fileSize: 2000 * 1024 * 1024 //100MB max
  },
  fileFilter: function (req, file, cb) {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Seules les images sont autorisées!'), false);
    }
  }
});

// =========================
// Configuration pour fiches de paie
// =========================

const uploadPaie = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadPaieDir),
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
      cb(null, 'paie-' + uniqueSuffix + '.pdf');
    }
  }),
  limits: { fileSize: 2000 * 1024 * 1024 }, // 200MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Seuls les fichiers PDF sont autorisés!'), false);
    }
  }
});

// =========================
// Test connexion BDD
// =========================

// Deliberately pool.query() (checks out AND releases a client internally),
// not pool.connect() -- that used to check out a client here and never
// release it, leaking one connection for the app's whole lifetime. An
// abandoned checked-out client sitting idle is exactly what Azure resets
// after a while, and that reset was surfacing as an unhandled 'error'
// event on the raw Client instance (not reliably caught by pool.on('error')
// below, which is for clients the pool itself still has checked in),
// crashing the entire process.
pool
  .query('SELECT version(), current_database()')
  .then(result => {
    console.log('✅ Connexion à PostgreSQL réussie pour RH Application');
    console.log('📊 Base de données:', result.rows[0]);
    return pool.query('SELECT 1');
  })
  .then(() => console.log('✅ Pool PostgreSQL opérationnel'))
  .catch(err => {
    console.error('❌ ERREUR DE CONNEXION PostgreSQL:', {
      message: err.message,
      code: err.code,
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      stack: err.stack
    });
  });

pool.on('error', err => {
  console.error('❌ Erreur inattendue du pool PostgreSQL:', err);
});

async function ensureVisaGeneratedColumns() {
  try {
    await pool.query(`ALTER TABLE visa_documents ADD COLUMN IF NOT EXISTS generated_file_url TEXT`);
    await pool.query(`ALTER TABLE visa_documents ADD COLUMN IF NOT EXISTS generated_original_filename TEXT`);
    console.log("✅ Colonnes VISA generated prêtes");
  } catch (err) {
    console.error("❌ Erreur ajout colonnes VISA generated:", err.message);
  }
}

ensureVisaGeneratedColumns();

async function ensureApprovedAtColumn() {
  try {
    await pool.query(`
      ALTER TABLE demande_rh 
      ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP
    `);
    console.log('✅ Colonne approved_at prête');
  } catch (err) {
    console.error('❌ Erreur ajout colonne approved_at:', err.message);
  }
}

ensureApprovedAtColumn();

// Indexes on columns filtered/joined on in hot paths (employee lists by
// statut, manager lookups by adresse_mail, payroll attendance by
// employee_id). IF NOT EXISTS + to_regclass guard: safe on every start and
// on schemas that don't have the table. Tables are small, so creation is
// near-instant.
async function ensurePerformanceIndexes() {
  const schemas = ['public', 'schema_cn', 'schema_de', 'schema_fr', 'schema_in',
                   'schema_kr', 'schema_lu', 'schema_mx', 'schema_tn'];
  const indexes = [
    { table: 'employees', name: 'statut', column: 'statut' },
    { table: 'employees', name: 'adresse_mail', column: 'adresse_mail' },
    { table: 'paie_attendance_period', name: 'employee_id', column: 'employee_id' }
  ];
  for (const schema of schemas) {
    for (const { table, name, column } of indexes) {
      try {
        const exists = await pool.query('SELECT to_regclass($1) IS NOT NULL AS ok', [`${schema}.${table}`]);
        if (!exists.rows[0].ok) continue;
        // Skip if any index (whatever its name) already starts with this column.
        const covered = await pool.query(
          `SELECT 1 FROM pg_index i
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
           WHERE i.indrelid = to_regclass($1) AND a.attname = $2 LIMIT 1`,
          [`${schema}.${table}`, column]
        );
        if (covered.rows.length > 0) continue;
        await pool.query(
          `CREATE INDEX IF NOT EXISTS idx_${schema}_${table}_${name} ON ${schema}.${table} (${column})`
        );
      } catch (err) {
        console.error(`❌ Index ${schema}.${table}(${column}):`, err.message);
      }
    }
  }
  console.log('✅ Index de performance prêts');
}

ensurePerformanceIndexes();

async function ensureResponsableFonctionnelColumn() {
  try {
    await pool.query(`
      ALTER TABLE public.employees
      ADD COLUMN IF NOT EXISTS mail_responsable_fonctionnel TEXT
    `);
    console.log('✅ Colonne mail_responsable_fonctionnel prête (Tunisia/public)');
  } catch (err) {
    console.error('❌ Erreur ajout colonne mail_responsable_fonctionnel:', err.message);
  }
}
ensureResponsableFonctionnelColumn();

// Payroll rubriques requested by Jamie Lambert (email "Calcul de paie",
// 2026-09-01), entered once on the employee record itself rather than in a
// second, separately-edited payroll table -- the developer's explicit call, to have
// a single place to edit this data. Tunisia (public) ONLY; CARTHAGE/ATLAS
// (schema_tn) keeps using its existing paie_employee_config table
// unchanged, per the same instruction. Consumed by GET/POST in
// routes/paie.cjs when schema === 'public'.
// indemnites_imposables_autres/indemnites_non_imposables_autres are a
// catch-all bucket for anything not covered by the named rubriques below.
// All named rubriques (including transport/panier/vetement) are taxable by
// default -- CONFIRMED 2026-09-14 via live verification against a real
// August 2026 payslip; see the classification note in routes/paie.cjs.
// Per the developer's 2026-09 instruction, indemnites_non_imposables_autres is also
// taxable now despite its name -- there is no tax-exempt bonus bucket.
async function ensurePaieRubriquesColumns() {
  try {
    await pool.query(`
      ALTER TABLE public.employees
        ADD COLUMN IF NOT EXISTS chef_famille BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS nb_enfants INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS salaire_base NUMERIC(12,3) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS indemnites_imposables_autres NUMERIC(12,3) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS indemnites_non_imposables_autres NUMERIC(12,3) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS acompte NUMERIC(12,3) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS indemnite_transport NUMERIC(12,3) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS indemnite_presence NUMERIC(12,3) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS prime_panier NUMERIC(12,3) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS prime_exceptionnelle NUMERIC(12,3) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS prime_exceptionnelle_mois VARCHAR(7),
        ADD COLUMN IF NOT EXISTS prime_fonction NUMERIC(12,3) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS prime_ramadhan NUMERIC(12,3) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS prime_ramadhan_mois VARCHAR(7),
        ADD COLUMN IF NOT EXISTS prime_aid NUMERIC(12,3) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS prime_aid_mois VARCHAR(7),
        ADD COLUMN IF NOT EXISTS prime_vetement_travail NUMERIC(12,3) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS prime_vetement_travail_mois VARCHAR(21),
        ADD COLUMN IF NOT EXISTS rubrique_libre_1_label VARCHAR(100),
        ADD COLUMN IF NOT EXISTS rubrique_libre_1_montant NUMERIC(12,3) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS rubrique_libre_1_mois VARCHAR(7),
        ADD COLUMN IF NOT EXISTS rubrique_libre_2_label VARCHAR(100),
        ADD COLUMN IF NOT EXISTS rubrique_libre_2_montant NUMERIC(12,3) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS rubrique_libre_2_mois VARCHAR(7),
        ADD COLUMN IF NOT EXISTS rubrique_libre_3_label VARCHAR(100),
        ADD COLUMN IF NOT EXISTS rubrique_libre_3_montant NUMERIC(12,3) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS rubrique_libre_3_mois VARCHAR(7),
        ADD COLUMN IF NOT EXISTS situation_familiale VARCHAR(20),
        ADD COLUMN IF NOT EXISTS nb_enfants_etudiants INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS nb_enfants_handicapes INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS note_gratification_depart NUMERIC(5,2)
    `);
    // note_gratification_depart (0-20): entered by HR when archiving, used
    // for the prorated gratification in the solde de tout compte (see
    // loadSoldeToutCompte in routes/paie.cjs). NULL = not entered.
    // nb_enfants_etudiants / nb_enfants_handicapes are SUBSETS of
    // nb_enfants (students < 25 without a bourse, and handicapped children)
    // -- they get the larger IRPP déductions familiales, see
    // deductionsFamiliales in services/paie/irpp.js.
    // situation_familiale is display-only (the bulletin's "SIT FAMILIALE"
    // label) and intentionally independent of chef_famille, which stays
    // the sole IRPP deductionsFamiliales input -- see calculerBulletinCdi.
    // Bootstrap NULL rows from chef_famille as a one-time best-effort seed
    // (per the developer's 2026-09-28 instruction) so existing employees show a
    // reasonable value immediately; HR corrects individual mismatches via
    // the employee modal afterwards. Only ever fills NULLs, so it never
    // clobbers a value HR has already set.
    await pool.query(`
      UPDATE public.employees
      SET situation_familiale = CASE WHEN chef_famille THEN 'marie' ELSE 'celibataire' END
      WHERE situation_familiale IS NULL
    `);
    // These legacy "*_mois" columns now store an exact ISO date range as
    // YYYY-MM-DD|YYYY-MM-DD. Widening preserves existing YYYY-MM values so
    // already-planned bonuses remain backward compatible.
    await pool.query(`
      ALTER TABLE public.employees
        ALTER COLUMN prime_exceptionnelle_mois TYPE VARCHAR(21),
        ALTER COLUMN prime_ramadhan_mois TYPE VARCHAR(21),
        ALTER COLUMN prime_aid_mois TYPE VARCHAR(21),
        ALTER COLUMN rubrique_libre_1_mois TYPE VARCHAR(21),
        ALTER COLUMN rubrique_libre_2_mois TYPE VARCHAR(21),
        ALTER COLUMN rubrique_libre_3_mois TYPE VARCHAR(21)
    `);
    console.log('✅ Colonnes rubriques de paie prêtes (Tunisia/public, sur employees)');
  } catch (err) {
    console.error('❌ Erreur ajout colonnes rubriques de paie:', err.message);
  }
}
ensurePaieRubriquesColumns();

async function ensureLoginTokenColumns() {
  try {
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS login_token_hash TEXT`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS login_token_expires TIMESTAMP`);
    console.log('✅ Colonnes login_token prêtes (auto-login)');
  } catch (err) {
    console.error('❌ Erreur ajout colonnes login_token:', err.message);
  }
}
ensureLoginTokenColumns();

const { ensurePaieTables, ensureGratificationTable, ensureEncryptionConfigTable } = require('./services/paie/schema.js');
ensurePaieTables(pool);
ensureGratificationTable(pool);
ensureEncryptionConfigTable(pool);
const salaryCrypto = require('./services/paie/salaryCrypto.js');
salaryCrypto.attachUnlockSessionStore(pool);
const { rotateSalaryEncryptionCode } = require('./services/paie/rotateSalaryEncryption.js');
const { initializeSalaryEncryption } = require('./services/paie/initializeSalaryEncryption.js');
const { checkManagerRoleHierarchy, checkKpiRoleName, listKpiRoles, getKpiPool } = require('./services/kpiRoleHierarchy.js');
const { buildOrgChartLinks, buildGroupChart } = require('./services/orgChart.js');
const { notifyM365Change } = require('./services/m365/changeNotify.cjs');
const { notifyJobChange } = require('./services/jobChangeNotify.cjs');
const { startDepartmentSync, normalizeDepartment } = require('./services/kpiDepartmentSync.js');

// =========================
// Middleware d'authentification
// =========================

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (token == null) {
    return res.sendStatus(401);
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      console.error('❌ Erreur vérification token:', err.message);
      return res.sendStatus(403);
    }
    req.user = user;
    next();
  });
};

function resolveEmployeeSchemaForRequest(user, requestedSchema) {
  const fallbackSchema = getSchemaForUser(user);
  if (!requestedSchema) return fallbackSchema;

  if (isGroupRole(user?.role)) {
    const allowedSchemas = getAccessibleEmployeeSchemas(user);
    return allowedSchemas.includes(requestedSchema) ? requestedSchema : fallbackSchema;
  }

  return fallbackSchema;
}

// Site-restricted accounts (tenantScope.cjs's getUserSiteScope) get null --
// i.e. "employee not found" -- for an employee outside their sites.
async function resolveEmployeeSchemaById(user, employeeId, requestedSchema) {
  const schema = await resolveEmployeeSchemaByIdAnySite(user, employeeId, requestedSchema);
  if (!schema || (await isEmployeeIdInSiteScope(user, schema, employeeId))) return schema;
  return null;
}

async function isEmployeeIdInSiteScope(user, schema, employeeId) {
  if (!getUserSiteScope(user)) return true;
  const result = await pool.query(`SELECT site_dep FROM ${schema}.employees WHERE id = $1`, [employeeId]);
  return result.rows.length > 0 && isEmployeeInSiteScope(user, result.rows[0]);
}

async function isDemandeInSiteScope(user, schema, demandeId) {
  if (!getUserSiteScope(user)) return true;
  const result = await pool.query(
    `SELECT e.site_dep FROM ${schema}.demande_rh d JOIN ${schema}.employees e ON e.id = d.employe_id WHERE d.id = $1`,
    [demandeId]
  );
  return result.rows.length > 0 && isEmployeeInSiteScope(user, result.rows[0]);
}

// For /api/demandes/:id-style routes: a request outside the user's sites
// answers 404, like one that doesn't exist. Site-restricted users are never
// group roles, so their requests always live in their home schema.
async function requireDemandeInSiteScope(req, res, next) {
  try {
    if (await isDemandeInSiteScope(req.user, getSchemaForUser(req.user), req.params.id)) return next();
    return res.status(404).json({ success: false, error: 'Demande non trouvée' });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}

// " AND <column> IN (employees of the user's sites)", for demande_rh queries.
function demandeSiteScopeSql(user, schema, employeeIdColumn, paramIndex) {
  const scope = siteScopeSql(user, 'se', paramIndex);
  return scope.sql
    ? { sql: ` AND ${employeeIdColumn} IN (SELECT se.id FROM ${schema}.employees se WHERE 1=1${scope.sql})`, params: scope.params }
    : scope;
}

async function resolveEmployeeSchemaByIdAnySite(user, employeeId, requestedSchema) {
  if (requestedSchema) {
    if (isGroupRole(user?.role)) {
      const allowedSchemas = getAccessibleEmployeeSchemas(user);
      if (!allowedSchemas.includes(requestedSchema)) {
        const error = new Error('Tenant schema not allowed for this user');
        error.statusCode = 403;
        error.code = 'TENANT_SCHEMA_FORBIDDEN';
        throw error;
      }
    }
    return resolveEmployeeSchemaForRequest(user, requestedSchema);
  }

  if (!isGroupRole(user?.role)) {
    return resolveEmployeeSchemaForRequest(user);
  }

  const schemas = getAccessibleEmployeeSchemas(user);
  // Check every schema in parallel (was one after the other); order is kept.
  const found = await Promise.all(schemas.map((schema) =>
    pool.query(`SELECT 1 FROM ${schema}.employees WHERE id = $1 LIMIT 1`, [employeeId])
      .then((result) => result.rows.length > 0)
  ));
  const matches = schemas.filter((_, i) => found[i]);

  if (matches.length === 1) {
    return matches[0];
  }

  if (matches.length > 1) {
    const error = new Error('Multiple employees match this id across schemas');
    error.statusCode = 409;
    error.code = 'AMBIGUOUS_TENANT_SCHEMA';
    error.matches = matches;
    throw error;
  }

  return null;
}

const createTenantApi = require('./routes/tenant-api.cjs');
const { sendPendingTrainingRequests } = require('./services/pendingTrainingRequest.cjs');

// Fire-and-forget: the employee save must not wait on (or fail because of)
// the parked onboarding training email.
const flushPendingTrainingRequests = (schema, employeeId, workEmail) => {
  sendPendingTrainingRequests({
    pool,
    emailTransporter,
    from: `"${EMAIL_FROM_NAME}" <${EMAIL_FROM}>`,
    schema,
    employeeId,
    workEmail
  }).catch((error) => console.error('❌ Pending training request check failed:', error.message));
};
// Microsoft 365: change notifications to Group IT and account / licence
// requests approved by the plant manager (see routes/m365Requests.cjs).
// Mounted on its own prefix: /api/m365-requests/decision/* is a no-login page.
require('./services/m365/mail.cjs').setMailer({
  transporter: emailTransporter,
  from: `"${EMAIL_FROM_NAME}" <${EMAIL_FROM}>`
});
const m365Requests = require('./routes/m365Requests.cjs')({
  pool,
  authenticateToken,
  getKpiPool,
  dbConfig,
  resolveItContact: (site) => resolveItContact(site),
  resolveEmployeeSchemaById
});
app.use('/api/m365-requests', m365Requests);

app.use('/api/v2', createTenantApi({
  pool,
  authenticateToken,
  emailTransporter,
  EMAIL_FROM,
  EMAIL_FROM_NAME,
  createM365Request: m365Requests.createRequest
}));

const createPaieApi = require('./routes/paie.cjs');
app.use('/api/paie', createPaieApi({ pool, authenticateToken }));

// A distinct top-level prefix, deliberately NOT /api/paie/* or a prefix of
// /api/gratification-eval/* below -- those no-login token routes must NEVER
// pass through this router's (or paie.cjs's) authenticateToken middleware,
// which Express would apply to any path sharing a mounted prefix.
const createGratificationApi = require('./routes/gratification.cjs');
app.use('/api/gratification', createGratificationApi({ pool, authenticateToken }));

const createChatbotApi = require('./routes/chatbot.cjs');
app.use('/api/chatbot', createChatbotApi({ pool, authenticateToken }));
const {
  getAccessibleEmployeeSchemas,
  getSchemaForUser,
  inferCountryKey,
  isGroupRole,
  isPaieSalaryAuthorized,
  getUserSiteScope,
  isEmployeeInSiteScope,
  filterEmployeesBySiteScope,
  siteScopeSql,
  ALL_EMPLOYEE_SCHEMAS
} = require('./middleware/tenantScope.cjs');

// =========================
// Every module for every tenant (2026-11-18)
// =========================
// Visa, Solde congé, attestation/ordre de mission, onboarding/offboarding...
// used to be Tunisia-only (requireTunisiaTenant) or non-Tunisia-only. They are
// now available to every tenant, each one working on ITS OWN schema's data.

// Same pool API (query/connect), but unqualified table names (visa_dossiers,
// employees, ...) resolve to the caller's tenant schema first, then public
// (for shared tables like users). Tunisia (public) gets the plain pool, so its
// behaviour is unchanged.
function tenantDb(req) {
  const schema = getSchemaForUser(req.user);
  if (!schema || schema === 'public' || !ALL_EMPLOYEE_SCHEMAS.includes(schema)) return pool;
  const setPath = (client) => client.query(`SET search_path TO "${schema}", public`);
  const resetPath = (client) => client.query('RESET search_path').catch(() => {});
  return {
    schema,
    async query(...args) {
      const client = await pool.connect();
      try {
        await setPath(client);
        return await client.query(...args);
      } finally {
        await resetPath(client);
        client.release();
      }
    },
    async connect() {
      const client = await pool.connect();
      await setPath(client);
      const release = client.release;
      client.release = (...args) => {
        client.release = release; // restore before the client goes back to the pool
        resetPath(client).finally(() => release.apply(client, args));
      };
      return client;
    }
  };
}

// Brings every tenant schema to the same table set: the non-Tunisia schemas
// get the columns Tunisia's tables gained over time (visa reminders,
// generated documents, leave-balance anchors...), and Tunisia (public) gets
// the onboarding/offboarding/emergency-contact tables the other tenants have.
// Idempotent; copies existing definitions instead of hardcoding them.
async function ensureUnifiedTenantSchemas() {
  const SHARED_TABLES = ['visa_dossiers', 'visa_documents', 'leave_balances'];
  const TABLES_FROM_TENANTS = ['onboarding_records', 'onboarding_tasks', 'offboarding_records', 'offboarding_tasks', 'emergency_contacts'];
  // (paie_* tables for every schema: services/paie/schema.js PAIE_SCHEMAS)
  const columnsOf = async (schema, table) => (await pool.query(
    `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped`,
    [schema, table]
  )).rows;
  try {
    for (const table of SHARED_TABLES) {
      const reference = await columnsOf('public', table);
      for (const schema of ALL_EMPLOYEE_SCHEMAS.filter((s) => s !== 'public')) {
        const existing = new Set((await columnsOf(schema, table)).map((c) => c.name));
        if (!existing.size) continue; // table absent in this schema
        for (const col of reference.filter((c) => !existing.has(c.name))) {
          await pool.query(`ALTER TABLE "${schema}"."${table}" ADD COLUMN IF NOT EXISTS "${col.name}" ${col.type}`);
        }
      }
    }
    // Same for enum values: the other schemas' visa enums were created with a
    // different workflow (VALIDE/REJETE...) than the one the app code uses
    // (Tunisia's VISA_ACCORDE/RECEIVED_PHYSICAL...). Add the missing labels
    // (additive -- existing values stay valid).
    const { rows: enumLabels } = await pool.query(
      `SELECT t.typname, e.enumlabel
         FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public' AND t.typname IN ('mode_document', 'statut_document', 'statut_dossier')
        ORDER BY t.typname, e.enumsortorder`);
    for (const schema of ALL_EMPLOYEE_SCHEMAS.filter((s) => s !== 'public')) {
      for (const { typname, enumlabel } of enumLabels) {
        const exists = await pool.query(
          `SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = $1 AND t.typname = $2`,
          [schema, typname]);
        if (!exists.rows.length) continue;
        await pool.query(`ALTER TYPE "${schema}"."${typname}" ADD VALUE IF NOT EXISTS '${enumlabel.replace(/'/g, "''")}'`);
      }
    }
    const source = ALL_EMPLOYEE_SCHEMAS.find((s) => s !== 'public');
    for (const table of TABLES_FROM_TENANTS) {
      await pool.query(`CREATE TABLE IF NOT EXISTS public."${table}" (LIKE "${source}"."${table}" INCLUDING ALL)`);
      // LIKE copies the id default as nextval('<source>.<table>_id_seq') --
      // give public its own sequence instead of sharing the other tenant's.
      const { rows } = await pool.query(
        `SELECT column_default FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'id'`, [table]);
      if (rows[0]?.column_default && !rows[0].column_default.includes(`public.${table}_id_seq`)
          && rows[0].column_default.includes(`${source}.`)) {
        await pool.query(`CREATE SEQUENCE IF NOT EXISTS public."${table}_id_seq" OWNED BY public."${table}".id`);
        await pool.query(`SELECT setval('public."${table}_id_seq"', COALESCE((SELECT MAX(id) FROM public."${table}"), 0) + 1, false)`);
        await pool.query(`ALTER TABLE public."${table}" ALTER COLUMN id SET DEFAULT nextval('public."${table}_id_seq"'::regclass)`);
      }
    }
    console.log('✅ Schémas tenants alignés (tous les modules pour tous les tenants)');
  } catch (err) {
    console.error('❌ Alignement des schémas tenants:', err.message);
  }
}
ensureUnifiedTenantSchemas();

// Tunisia (public schema) payroll amounts on the employee record --
// restricted to isPaieSalaryAuthorized() AND (since salaryCrypto encryption)
// a valid unlock code for this session. Split into two lists: the AMOUNT
// fields are actually encrypted at rest (services/paie/salaryCrypto.js) and
// need decrypting when unlocked, null otherwise; the *_mois fields are plain
// date-range text (never encrypted) but still role-gated like before, purely
// because they reveal which seasonal bonus period is configured. Masked to
// null (never sent over the wire at all, not just hidden client-side) for
// anyone who isn't both authorized and unlocked, exactly like routes/paie.cjs
// does for the Calcul de paie module. salaire_brute is included here even
// though it's the one field shared with every other tenant's employee
// record -- see server.js's schema-conditional PUT/POST handlers, which only
// ever encrypt/decrypt it for schema === 'public' rows.
const TUNISIA_SALARY_AMOUNT_FIELDS = [
  'salaire_base',
  'salaire_brute',
  'indemnites_imposables_autres',
  'indemnites_non_imposables_autres',
  'acompte',
  'indemnite_transport',
  'indemnite_presence',
  'prime_panier',
  'prime_exceptionnelle',
  'prime_fonction',
  'prime_ramadhan',
  'prime_aid',
  'prime_vetement_travail',
  'rubrique_libre_1_montant',
  'rubrique_libre_2_montant',
  'rubrique_libre_3_montant',
];

const TUNISIA_SALARY_MOIS_FIELDS = [
  'prime_exceptionnelle_mois',
  'prime_ramadhan_mois',
  'prime_aid_mois',
  'prime_vetement_travail_mois',
  'rubrique_libre_1_mois',
  'rubrique_libre_2_mois',
  'rubrique_libre_3_mois',
];

function maskTunisiaSalaryFields(row, user, unlockKey) {
  if (!row || row.tenant_schema !== 'public') return row;
  const authorized = isPaieSalaryAuthorized(user);
  const unlocked = authorized && !!unlockKey;

  const masked = { ...row };
  for (const field of TUNISIA_SALARY_AMOUNT_FIELDS) {
    if (masked[field] === undefined) continue;
    masked[field] = unlocked ? salaryCrypto.decryptValue(masked[field], unlockKey) : null;
  }
  for (const field of TUNISIA_SALARY_MOIS_FIELDS) {
    if (masked[field] !== undefined && !authorized) masked[field] = null;
  }
  if (!unlocked) masked.paie_salary_masked = true;
  return masked;
}

function maskTunisiaSalaryFieldsList(rows, user, unlockKey) {
  return rows.map((row) => maskTunisiaSalaryFields(row, user, unlockKey));
}

// An authorized account still sending an unlock token the server no longer
// knows (expired after 45 min idle, or lost on a backend restart -- unlock
// sessions are in-memory only). Same 423 as routes/paie.cjs's
// staleUnlockToken: without it these routes silently answered with masked
// amounts (Team page showed empty salaries while the panel still claimed to
// be unlocked) and silently dropped salary edits on save. The frontend
// interceptor clears the dead token on 423 and re-prompts for the code.
function rejectStalePaieUnlock(req, res, next) {
  const token = req.headers['x-paie-unlock-token'];
  if (token && isPaieSalaryAuthorized(req.user) && !salaryCrypto.getUnlockKey(token)) {
    return res.status(423).json({ error: 'Session de déverrouillage expirée -- veuillez ressaisir le code.' });
  }
  next();
}

function isTunisiaTenantUser(user) {
  const tenantText = [
    user?.country,
    user?.plant,
    user?.tenant_schema,
    user?.tenant_id
  ].filter(Boolean).join(' ').toLowerCase();

  return (
    inferCountryKey(user) === 'tunisia' ||
    tenantText.includes('tunisia') ||
    tenantText.includes('public') ||
    tenantText.includes('sahel')
  );
}

// Was a Tunisia-only gate. Every module is now available to every tenant
// (2026-11-18); the routes that used it read the caller's own tenant
// schema through tenantDb(req). Kept as a pass-through so the route
// declarations stay unchanged.
function requireTunisiaTenant(req, res, next) {
  next();
}

// =========================
// Multi-tenant plant approval workflow (ported from demande_rh_backend
// to keep in-app approval consistent with the email/portal approval path)
// =========================
const OTHER_PLANTS_FALLBACK_EMAIL_APP = process.env.OTHER_PLANTS_FALLBACK_EMAIL || 'noel.dupuis@example.com';
const TIANJIN_PLANT_MANAGER_EMAIL_APP = process.env.TIANJIN_PLANT_MANAGER_EMAIL || OTHER_PLANTS_FALLBACK_EMAIL_APP;
const APPROVAL_FLAG_COLUMNS_APP = ['approuve_responsable1', 'approuve_responsable2', 'approuve_responsable3', 'approuve_responsable4'];
const DEMANDE_RH_PORTAL_BASE_URL = process.env.DEMANDE_RH_PORTAL_BASE_URL || 'https://your-app.azurewebsites.net';

const TENANT_RH_ADMIN_EMAIL_APP = {
  china: process.env.CHINA_RH_ADMIN_EMAIL || OTHER_PLANTS_FALLBACK_EMAIL_APP,
  india: process.env.INDIA_RH_ADMIN_EMAIL || OTHER_PLANTS_FALLBACK_EMAIL_APP,
  mexico: process.env.MEXICO_RH_ADMIN_EMAIL || OTHER_PLANTS_FALLBACK_EMAIL_APP,
  luxembourg: process.env.LUXEMBOURG_RH_ADMIN_EMAIL || OTHER_PLANTS_FALLBACK_EMAIL_APP,
  korea: process.env.KOREA_RH_ADMIN_EMAIL || OTHER_PLANTS_FALLBACK_EMAIL_APP,
  france: process.env.FRANCE_RH_ADMIN_EMAIL || OTHER_PLANTS_FALLBACK_EMAIL_APP
};

const SCHEMA_TO_TENANT_KEY_APP = {
  public: 'tunisia',
  schema_tn: 'atlas_carthage',
  schema_fr: 'france',
  schema_cn: 'china',
  schema_de: 'germany',
  schema_in: 'india',
  schema_lu: 'luxembourg',
  schema_mx: 'mexico',
  schema_kr: 'korea'
};

function getWorkflowTenantKey(user) {
  const key = inferCountryKey(user);
  if (key === 'south korea') return 'korea';
  return key || 'tunisia';
}

function normalizeTextApp(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizePlantKeyApp(value) {
  const normalized = normalizeTextApp(value)
    .replace(/[àáâãäå]/g, 'a')
    .replace(/[èéêë]/g, 'e')
    .replace(/[ìíîï]/g, 'i')
    .replace(/[òóôõö]/g, 'o')
    .replace(/[ùúûü]/g, 'u');

  if (['loire', 'poitiers'].includes(normalized)) return normalized;
  if (['mexco'].includes(normalized)) return 'mexco';
  if (['northwind india', 'india', 'in'].includes(normalized)) return 'india';
  if (['northwind kunshan', 'kunshan', 'china', 'cn'].includes(normalized)) return 'kunshan';
  if (['northwind germany', 'germany', 'deutschland', 'de'].includes(normalized)) return 'germany';
  if (['northwind tianjin', 'tianjin'].includes(normalized)) return 'tianjin';
  return normalized;
}

function getEmployeePlantApp(employee) {
  return normalizePlantKeyApp(employee?.site_dep || employee?.plant || employee?.site || employee?.site_dep_name);
}

function getApproverRoleLabelApp(role) {
  const labels = {
    supervisor: 'direct supervisor',
    plant_director: 'plant director',
    hierarchical_manager: 'hierarchical manager',
    department_manager: 'department manager',
    plant_manager: 'plant manager',
    manager: 'manager',
    hr_manager: 'HR manager',
    team_leader: 'team leader',
    hr_notification: 'HR'
  };
  return labels[role] || role;
}

function getApproverEmailFromEmployeeApp(employee, role) {
  if (role === 'plant_manager' && getEmployeePlantApp(employee) === 'tianjin') {
    return TIANJIN_PLANT_MANAGER_EMAIL_APP;
  }

  const fallback = [];
  if (employee?.mail_responsable1) fallback.push(employee.mail_responsable1);
  if (employee?.mail_responsable2) fallback.push(employee.mail_responsable2);
  if (employee?.mail_responsable3) fallback.push(employee.mail_responsable3);

  const explicit = {
    supervisor: employee?.mail_responsable1,
    plant_director: employee?.mail_responsable2,
    hierarchical_manager: employee?.mail_responsable2,
    department_manager: employee?.mail_responsable2,
    plant_manager: employee?.mail_responsable2,
    manager: employee?.mail_responsable2,
    hr_manager: employee?.mail_responsable2,
    team_leader: employee?.mail_responsable3,
    hr_notification: null
  }[role];

  return explicit || fallback[0] || null;
}

function getPlantWorkflowApp(employee, requestType, requestData) {
  const plant = getEmployeePlantApp(employee);
  const requestKey = normalizeTextApp(requestType);
  const grade = normalizeTextApp(employee?.grade || employee?.grade_level || employee?.niveau || employee?.job_grade);
  const days = Number(requestData?.nombre_jours || 0);

  if (plant === 'tianjin') {
    const isOfficeStaff = ['office', 'office staff', 'staff office'].includes(grade);
    const isManager = ['manager', 'managers'].includes(grade);
    const isDirectIndirect = ['direct', 'indirect', 'direct staff', 'indirect staff'].includes(grade);

    if (isManager) {
      return [
        { role: 'plant_manager', required: true },
        { role: 'hr_notification', required: true }
      ];
    }

    if (isOfficeStaff && requestKey === 'conges') {
      const steps = [
        { role: 'supervisor', required: true },
        { role: 'manager', required: true }
      ];
      if (days >= 3) steps.push({ role: 'plant_manager', required: true });
      steps.push({ role: 'hr_notification', required: true });
      return steps;
    }

    if (isDirectIndirect && requestKey === 'conges') {
      const steps = [
        { role: 'team_leader', required: true },
        { role: 'supervisor', required: true },
        { role: 'manager', required: true }
      ];
      if (days >= 3) steps.push({ role: 'plant_manager', required: true });
      if (days >= 2) steps.push({ role: 'hr_notification', required: true });
      return steps;
    }

    return [
      { role: 'supervisor', required: true },
      { role: 'manager', required: true },
      { role: 'hr_notification', required: true }
    ];
  }

  if (['loire', 'poitiers'].includes(plant)) {
    return [
      { role: 'supervisor', required: true },
      { role: 'hr_notification', required: true }
    ];
  }

  if (plant === 'mexco') {
    return [
      { role: 'supervisor', required: true },
      { role: 'plant_director', required: true },
      { role: 'hr_notification', required: true }
    ];
  }

  if (plant === 'india') {
    return [
      { role: 'supervisor', required: true },
      { role: 'hierarchical_manager', required: true },
      { role: 'hr_notification', required: true }
    ];
  }

  if (plant === 'kunshan') {
    return [
      { role: 'supervisor', required: true },
      { role: 'department_manager', required: true },
      { role: 'hr_notification', required: true }
    ];
  }

  return null;
}

function resolveRequestWorkflowApp(tenantKey, employee, requestData) {
  if (tenantKey === 'germany') return { mode: 'sage' };
  if (tenantKey === 'tunisia') return { mode: 'tunisia', legacy: true };

  const workflow = getPlantWorkflowApp(employee, requestData?.type_demande, requestData);
  if (!workflow) return { mode: 'plant_based', legacy: true };
  return { mode: 'plant_based', workflow };
}

function buildDemandeDetailsHtmlApp(demande) {
  const typeLabel =
    demande.type_demande === 'conges' ? 'Congé' :
    demande.type_demande === 'autorisation' ? 'Autorisation' : 'Mission';
  const typeCongeLabel = getTypeCongeTextApp(demande.type_conge, demande.type_conge_autre);
  return `
    <p><strong>Type :</strong> ${typeLabel}</p>
    <p><strong>Motif :</strong> ${demande.titre || ''}</p>
    ${typeCongeLabel ? `<p><strong>Type de congé :</strong> ${typeCongeLabel}</p>` : ''}
    <p><strong>Date de départ :</strong> ${formatDateShortApp(demande.date_depart)}</p>
    ${demande.date_retour ? `<p><strong>Date de retour :</strong> ${formatDateShortApp(demande.date_retour)}</p>` : ''}
    ${demande.heure_depart ? `<p><strong>Heure de départ :</strong> ${demande.heure_depart}</p>` : ''}
    ${demande.heure_retour ? `<p><strong>Heure de retour :</strong> ${demande.heure_retour}</p>` : ''}
    ${demande.nombre_jours ? `<p><strong>Durée :</strong> ${demande.nombre_jours} jour(s)</p>` : ''}
  `;
}

async function sendEmployeeApprovedEmailApp(demande) {
  if (!demande.adresse_mail) return;
  try {
    await sendEmail(demande.adresse_mail, '✅ Votre demande RH a été approuvée', `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #16a34a; border-bottom: 3px solid #16a34a; padding-bottom: 10px;">✅ Votre demande a été approuvée</h2>
        <p><strong>Bonjour ${demande.prenom} ${demande.nom},</strong></p>
        <div style="background: #f8fafc; padding: 20px; border-radius: 8px; margin: 20px 0;">
          ${buildDemandeDetailsHtmlApp(demande)}
        </div>
      </div>
    `);
    console.log(`📧 Email approbation (multi-tenant) envoyé à ${demande.adresse_mail}`);
  } catch (e) {
    console.error('❌ Erreur email employé (approbation multi-tenant):', e.message);
  }
}

async function sendHrFinalNotificationEmailApp(demande, tenantKey) {
  const hrEmail = TENANT_RH_ADMIN_EMAIL_APP[tenantKey] || OTHER_PLANTS_FALLBACK_EMAIL_APP;
  try {
    await sendEmail(hrEmail, `📋 Demande RH approuvée - ${demande.nom} ${demande.prenom}`, `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #16a34a; border-bottom: 3px solid #16a34a; padding-bottom: 10px;">✅ Demande RH approuvée</h2>
        <div style="background: #f0fdf4; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <p><strong>Employé :</strong> ${demande.nom} ${demande.prenom}</p>
          <p><strong>Matricule :</strong> ${demande.matricule || 'N/A'}</p>
          <p><strong>Site :</strong> ${demande.site_dep || 'Non spécifié'}</p>
          ${buildDemandeDetailsHtmlApp(demande)}
        </div>
      </div>
    `);
    console.log(`📧 Email RH finale (multi-tenant) envoyé à ${hrEmail}`);
  } catch (e) {
    console.error('❌ Erreur email RH finale (multi-tenant):', e.message);
  }
}

async function notifyNextApproverApp(demande, approverEmail, tenantKey, niveau) {
  const portalUrl = `${DEMANDE_RH_PORTAL_BASE_URL}/approuver-demande?id=${demande.id}&niveau=${niveau}&tenant=${tenantKey}`;
  try {
    await sendEmail(approverEmail, `Demande RH à traiter - ${demande.nom} ${demande.prenom}`, `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2563eb; border-bottom: 2px solid #2563eb; padding-bottom: 10px;">📋 Demande RH en attente de votre approbation</h2>
        <div style="background: #f0f9ff; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <p><strong>Employé :</strong> ${demande.nom} ${demande.prenom}</p>
          ${buildDemandeDetailsHtmlApp(demande)}
        </div>
        <p>Vous pouvez traiter cette demande en cliquant sur le lien ci-dessous, ou en vous connectant à l'application RH Manager.</p>
        <a href="${portalUrl}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:white;text-decoration:none;border-radius:6px;font-weight:bold;">Traiter la demande</a>
      </div>
    `);
    console.log(`📧 Notification prochain approbateur envoyée à ${approverEmail}`);
  } catch (e) {
    console.error('❌ Erreur notification prochain approbateur:', e.message);
  }
}

function resolveActionSchemaAndTenantApp(req) {
  const requestedSchema = req.body?.schema || req.query?.schema;
  const accessibleSchemas = getAccessibleEmployeeSchemas(req.user);
  const schema = requestedSchema && accessibleSchemas.includes(requestedSchema)
    ? requestedSchema
    : getSchemaForUser(req.user);
  const tenantKey = SCHEMA_TO_TENANT_KEY_APP[schema] || 'tunisia';
  return { schema, tenantKey };
}

function getCurrentRequiredApproverEmailApp(workflowResolution, demande) {
  if (workflowResolution.legacy) {
    return !demande.approuve_responsable1 ? demande.mail_responsable1 : demande.mail_responsable2;
  }
  const steps = workflowResolution.workflow || [];
  const realSteps = steps.filter(s => s.role !== 'hr_notification');
  const currentStepIndex = APPROVAL_FLAG_COLUMNS_APP.reduce((count, col) => count + (demande[col] ? 1 : 0), 0);
  const currentStep = realSteps[currentStepIndex];
  if (!currentStep) return null;
  return getApproverEmailFromEmployeeApp(demande, currentStep.role);
}

function isRequestingUserCurrentApproverApp(req, workflowResolution, demande) {
  const expectedEmail = getCurrentRequiredApproverEmailApp(workflowResolution, demande);
  const userEmail = String(req.user?.email || '').trim().toLowerCase();
  return !!expectedEmail && String(expectedEmail).trim().toLowerCase() === userEmail;
}

async function handleNonTunisiaApprove(req, res, id, tenantKey, schema) {
  try {
    if (tenantKey === 'germany') {
      return res.status(400).json({ success: false, error: 'Ce tenant est géré dans SAGE et ne suit pas le workflow RH standard.' });
    }

    const result = await pool.query(
      `SELECT d.*, e.nom, e.prenom, e.adresse_mail, e.poste, e.matricule, e.grade, e.site_dep,
              e.mail_responsable1, e.mail_responsable2${schema === 'schema_cn' ? ', e.mail_responsable3' : ''}
       FROM ${schema}.demande_rh d
       JOIN ${schema}.employees e ON d.employe_id = e.id
       WHERE d.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Demande non trouvée' });
    }

    const demande = result.rows[0];

    if (demande.statut !== 'en_attente') {
      return res.status(400).json({ success: false, error: `Cette demande a déjà été traitée (statut: ${demande.statut})` });
    }

    const workflowResolution = resolveRequestWorkflowApp(tenantKey, demande, demande);

    if (!isRequestingUserCurrentApproverApp(req, workflowResolution, demande)) {
      return res.status(403).json({ success: false, error: "Vous n'êtes pas le responsable actuel de cette étape." });
    }

    if (workflowResolution.legacy) {
      if (!demande.approuve_responsable1) {
        await pool.query(
          `UPDATE ${schema}.demande_rh SET approuve_responsable1 = true, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [id]
        );
        if (demande.mail_responsable2) {
          await notifyNextApproverApp(demande, demande.mail_responsable2, tenantKey, 2);
        }
        return res.json({ success: true, message: 'Demande approuvée par le premier responsable, en attente du second' });
      }

      await pool.query(
        `UPDATE ${schema}.demande_rh SET statut = 'approuve', approuve_responsable2 = true, updated_at = CURRENT_TIMESTAMP, approved_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [id]
      );
      await sendEmployeeApprovedEmailApp(demande);
      if (tenantKey === 'korea') {
        await sendHrFinalNotificationEmailApp(demande, tenantKey);
      }
      return res.json({ success: true, message: 'Demande approuvée avec succès' });
    }

    const steps = workflowResolution.workflow || [];
    const realSteps = steps.filter(s => s.role !== 'hr_notification');
    const currentStepIndex = APPROVAL_FLAG_COLUMNS_APP.reduce((count, col) => count + (demande[col] ? 1 : 0), 0);
    const currentStep = realSteps[currentStepIndex];

    if (!currentStep) {
      return res.status(400).json({ success: false, error: 'Aucune étape restante pour cette demande.' });
    }

    const currentFlag = APPROVAL_FLAG_COLUMNS_APP[currentStepIndex];
    if (!currentFlag) {
      return res.status(500).json({ success: false, error: 'Trop d\'étapes pour ce workflow (limite atteinte).' });
    }
    await pool.query(`UPDATE ${schema}.demande_rh SET ${currentFlag} = true, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [id]);

    const nextRealStep = realSteps[currentStepIndex + 1];

    if (nextRealStep) {
      const nextEmail = getApproverEmailFromEmployeeApp(demande, nextRealStep.role);
      if (nextEmail) {
        await notifyNextApproverApp(demande, nextEmail, tenantKey, currentStepIndex + 2);
      }
      return res.json({
        success: true,
        message: `Demande approuvée par ${getApproverRoleLabelApp(currentStep.role)}. En attente de ${getApproverRoleLabelApp(nextRealStep.role)}.`
      });
    }

    await pool.query(`UPDATE ${schema}.demande_rh SET statut = 'approuve', updated_at = CURRENT_TIMESTAMP, approved_at = CURRENT_TIMESTAMP WHERE id = $1`, [id]);

    await sendEmployeeApprovedEmailApp(demande);

    const shouldNotifyHr = steps.some(s => s.role === 'hr_notification');
    if (shouldNotifyHr) {
      await sendHrFinalNotificationEmailApp(demande, tenantKey);
    }

    return res.json({ success: true, message: shouldNotifyHr ? 'Demande approuvée et RH notifié.' : 'Demande approuvée.' });
  } catch (err) {
    console.error('❌ Erreur approbation demande (multi-tenant):', err);
    return res.status(500).json({ success: false, error: 'Erreur lors de l\'approbation', details: err.message });
  }
}

async function handleNonTunisiaRefuse(req, res, id, tenantKey, schema, commentaire) {
  try {
    if (tenantKey === 'germany') {
      return res.status(400).json({ success: false, error: 'Ce tenant est géré dans SAGE et ne suit pas le workflow RH standard.' });
    }

    const result = await pool.query(
      `SELECT d.*, e.nom, e.prenom, e.adresse_mail, e.poste, e.matricule, e.grade, e.site_dep,
              e.mail_responsable1, e.mail_responsable2${schema === 'schema_cn' ? ', e.mail_responsable3' : ''}
       FROM ${schema}.demande_rh d
       JOIN ${schema}.employees e ON d.employe_id = e.id
       WHERE d.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Demande non trouvée' });
    }

    const demande = result.rows[0];

    if (demande.statut !== 'en_attente') {
      return res.status(400).json({ success: false, error: `Cette demande a déjà été traitée (statut: ${demande.statut})` });
    }

    const workflowResolutionForRefuse = resolveRequestWorkflowApp(tenantKey, demande, demande);
    if (!isRequestingUserCurrentApproverApp(req, workflowResolutionForRefuse, demande)) {
      return res.status(403).json({ success: false, error: "Vous n'êtes pas le responsable actuel de cette demande." });
    }

    const resetCols = schema === 'schema_cn'
      ? 'approuve_responsable1 = false, approuve_responsable2 = false, approuve_responsable3 = false, approuve_responsable4 = false'
      : 'approuve_responsable1 = false, approuve_responsable2 = false';

    await pool.query(
      `UPDATE ${schema}.demande_rh SET statut = 'refuse', ${resetCols}, commentaire_refus = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [commentaire.trim(), id]
    );

    if (demande.adresse_mail) {
      try {
        await sendEmail(demande.adresse_mail, '❌ Votre demande RH a été refusée', `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #dc2626; border-bottom: 3px solid #dc2626; padding-bottom: 10px;">❌ Votre demande a été refusée</h2>
            <p><strong>Bonjour ${demande.prenom} ${demande.nom},</strong></p>
            <div style="background: #f8fafc; padding: 20px; border-radius: 8px; margin: 20px 0;">
              ${buildDemandeDetailsHtmlApp(demande)}
            </div>
            <div style="background: #fef2f2; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #dc2626;">
              <p style="margin: 0;"><strong>💬 Motif du refus :</strong></p>
              <p style="margin: 8px 0 0 0;">${commentaire.trim()}</p>
            </div>
          </div>
        `);
        console.log(`📧 Email refus (multi-tenant) envoyé à ${demande.adresse_mail}`);
      } catch (e) {
        console.error('❌ Erreur email refus (multi-tenant):', e.message);
      }
    }

    return res.json({ success: true, message: 'Demande refusée avec succès' });
  } catch (err) {
    console.error('❌ Erreur refus demande (multi-tenant):', err);
    return res.status(500).json({ success: false, error: 'Erreur lors du refus', details: err.message });
  }
}

// =========================
// Utilitaires
// =========================

function isValidUrl(string) {
  try {
    new URL(string);
    return true;
  } catch (_) {
    return false;
  }
}

function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

function normalizeEmailAddress(value) {
  return String(value || '').trim().toLowerCase();
}

function resolveTunisiaDemandeApprover(demande, user) {
  const currentEmail = normalizeEmailAddress(user?.email);
  const responsable1Email = normalizeEmailAddress(demande?.mail_responsable1);
  const responsable2Email = normalizeEmailAddress(demande?.mail_responsable2);
  const role = String(user?.role || '').trim().toLowerCase();

  if (currentEmail && responsable1Email && currentEmail === responsable1Email) {
    return 'responsable1';
  }

  if (currentEmail && responsable2Email && currentEmail === responsable2Email) {
    return 'responsable2';
  }

  if (!responsable2Email && responsable1Email && ['manager', 'responsable1'].includes(role)) {
    return 'responsable1';
  }

  if (!responsable1Email && responsable2Email && role === 'responsable2') {
    return 'responsable2';
  }

  return null;
}

function computeTunisiaDemandeStatus(demande, approverStates) {
  const hasResponsable1 = !!normalizeEmailAddress(demande?.mail_responsable1);
  const hasResponsable2 = !!normalizeEmailAddress(demande?.mail_responsable2);

  if (approverStates.approuve_responsable1 === false || approverStates.approuve_responsable2 === false) {
    return 'refuse';
  }

  if (hasResponsable1 && hasResponsable2) {
    return approverStates.approuve_responsable1 === true && approverStates.approuve_responsable2 === true
      ? 'approuve'
      : 'en_attente';
  }

  if (hasResponsable1) {
    return approverStates.approuve_responsable1 === true ? 'approuve' : 'en_attente';
  }

  if (hasResponsable2) {
    return approverStates.approuve_responsable2 === true ? 'approuve' : 'en_attente';
  }

  return 'approuve';
}

function getDefaultAvatar(nom, prenom) {
  const initiales = (prenom.charAt(0) + nom.charAt(0)).toUpperCase();
  const colors = [
    'FF6B6B',
    '4ECDC4',
    '45B7D1',
    '96CEB4',
    'FFEAA7',
    'DDA0DD',
    '98D8C8',
    'F7DC6F',
    'BB8FCE',
    '85C1E9'
  ];
  const color = colors[Math.floor(Math.random() * colors.length)];
  return `https://ui-avatars.com/api/?name=${initiales}&background=${color}&color=fff&size=150`;
}

// Fonction pour générer un mot de passe aléatoire
function generateRandomPassword(length = 10) {
  const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lowercase = 'abcdefghijklmnopqrstuvwxyz';
  const numbers = '0123456789';
  const specials = '!@#$%^&*';
  
  let password = '';
  
  // Assurer au moins un caractère de chaque type
  password += uppercase.charAt(Math.floor(Math.random() * uppercase.length));
  password += lowercase.charAt(Math.floor(Math.random() * lowercase.length));
  password += numbers.charAt(Math.floor(Math.random() * numbers.length));
  password += specials.charAt(Math.floor(Math.random() * specials.length));
  
  // Remplir le reste
  const allChars = uppercase + lowercase + numbers + specials;
  for (let i = 4; i < length; i++) {
    password += allChars.charAt(Math.floor(Math.random() * allChars.length));
  }
  
  // Mélanger le mot de passe
  return password.split('').sort(() => 0.5 - Math.random()).join('');
}

// Fonction pour envoyer un email avec Outlook
async function sendEmail(to, subject, html) {
  try {
    const mailOptions = {
      from: {
        name: EMAIL_FROM_NAME,
        address: EMAIL_FROM
      },
      to: to,
      subject: subject,
      html: html,
      text: html.replace(/<[^>]*>/g, ''), // Version texte pour compatibilité
      headers: {
        'X-Mailer': 'RH Manager Application',
        'X-Priority': '3',
        'X-MSMail-Priority': 'Normal'
      }
    };

    console.log('📧 Tentative d\'envoi email à:', to);
    
    const info = await emailTransporter.sendMail(mailOptions);
    console.log('✅ Email envoyé avec succès:', info.messageId);
    return true;
  } catch (error) {
    console.error('❌ Erreur envoi email:', {
      message: error.message,
      code: error.code,
      response: error.response
    });
    throw error;
  }
}
// Utilitaires demandes RH
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getDemandeTypeLabel(typeDemande) {
  if (typeDemande === 'conges' || typeDemande === 'congé') return 'Congé';
  if (typeDemande === 'autorisation' || typeDemande === 'autorisation_absence') return 'Autorisation';
  if (typeDemande === 'mission') return 'Mission';
  return typeDemande || 'Demande RH';
}

function getDemandeCancelToken(demandeId) {
  const signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(`cancel-demande-rh:${demandeId}`)
    .digest('hex');

  return `${demandeId}.${signature}`;
}

function isValidDemandeCancelToken(demandeId, token) {
  const [tokenDemandeId, signature] = String(token || '').split('.');
  if (tokenDemandeId !== String(demandeId) || !signature || !/^[a-f0-9]{64}$/i.test(signature)) {
    return false;
  }

  const expectedSignature = getDemandeCancelToken(demandeId).split('.')[1];
  const received = Buffer.from(signature, 'hex');
  const expected = Buffer.from(expectedSignature, 'hex');

  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

function getBackendPublicUrl(req) {
  if (process.env.BACKEND_PUBLIC_URL) {
    return process.env.BACKEND_PUBLIC_URL.replace(/\/+$/, '');
  }

  const forwardedProto = req.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const forwardedHost = req.get('x-forwarded-host')?.split(',')[0]?.trim();
  const protocol = forwardedProto || (process.env.NODE_ENV === 'production' ? 'https' : req.protocol);
  const host = forwardedHost || req.get('host');

  return `${protocol}://${host}`.replace(/\/+$/, '');
}

function getDemandeCancelUrl(req, demandeId) {
  const token = getDemandeCancelToken(demandeId);
  return `${getBackendPublicUrl(req)}/api/demandes/${encodeURIComponent(demandeId)}/annuler?token=${encodeURIComponent(token)}`;
}

// Prime de Gratification -- SAHEL-only, no-login evaluation link for an
// employee's manager (mail_responsable1 or mail_responsable_fonctionnel),
// same HMAC-signed-token pattern as getDemandeCancelToken above (no real
// "manager login scoped to their reports" exists in this app to build on
// instead -- see the plan notes).
//
// `role` ('hierarchique' | 'fonctionnel') added 2026-09-30 so the two
// managers' evaluations are tracked and combined separately instead of one
// silently overwriting the other -- see ensureGratificationTable's comment
// in services/paie/schema.js. It's embedded in the signed payload (not
// just a plain query param) so a link can't be replayed for the other
// role by editing the URL.
const GRATIFICATION_ROLES = ['hierarchique', 'fonctionnel'];

function getGratificationEvalToken(employeeId, annee, role) {
  const signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(`gratification-eval:${employeeId}:${annee}:${role}`)
    .digest('hex');

  return `${employeeId}.${annee}.${role}.${signature}`;
}

function isValidGratificationEvalToken(employeeId, annee, role, token) {
  const [tokenEmployeeId, tokenAnnee, tokenRole, signature] = String(token || '').split('.');
  if (
    tokenEmployeeId !== String(employeeId) ||
    tokenAnnee !== String(annee) ||
    tokenRole !== String(role) ||
    !GRATIFICATION_ROLES.includes(tokenRole) ||
    !signature ||
    !/^[a-f0-9]{64}$/i.test(signature)
  ) {
    return false;
  }

  const expectedSignature = getGratificationEvalToken(employeeId, annee, role).split('.')[3];
  const received = Buffer.from(signature, 'hex');
  const expected = Buffer.from(expectedSignature, 'hex');

  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

function getGratificationEvalUrl(req, employeeId, annee, role) {
  const token = getGratificationEvalToken(employeeId, annee, role);
  return `${getBackendPublicUrl(req)}/api/gratification-eval/${encodeURIComponent(employeeId)}?annee=${encodeURIComponent(annee)}&role=${encodeURIComponent(role)}&token=${encodeURIComponent(token)}`;
}

function getDemandeEndDate(demande) {
  const rawDate = demande?.date_retour || demande?.date_depart;
  if (!rawDate) return null;

  const date = new Date(rawDate);
  if (isNaN(date.getTime())) return null;

  date.setHours(0, 0, 0, 0);
  return date;
}

function isDemandeCancellationAllowed(demande) {
  if (!demande || demande.statut !== 'approuve') return false;

  const endDate = getDemandeEndDate(demande);
  if (!endDate) return false;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return endDate >= today;
}

function getDemandeCancellationBlockReason(demande) {
  if (!demande) return 'Demande introuvable.';
  if (demande.statut === DEMANDE_STATUS_ANNULEE) return 'Cette demande est déjà annulée.';
  if (demande.statut !== 'approuve') return `Cette demande ne peut pas être annulée car son statut actuel est "${demande.statut}".`;
  if (!isDemandeCancellationAllowed(demande)) return 'Cette demande ne peut plus être annulée car sa période est déjà passée.';
  return null;
}

function renderDemandeCancellationPage({ title, message, details = '', actionHtml = '', status = 200, color = '#2563eb' }) {
  return {
    status,
    html: `
      <!DOCTYPE html>
      <html lang="fr">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${escapeHtml(title)}</title>
        <style>
          body { font-family: Arial, sans-serif; background: #f8fafc; color: #111827; margin: 0; padding: 32px 16px; }
          .card { max-width: 640px; margin: 0 auto; background: white; border: 1px solid #e5e7eb; border-radius: 12px; box-shadow: 0 12px 30px rgba(15, 23, 42, 0.08); overflow: hidden; }
          .header { background: ${color}; color: white; padding: 24px; }
          .header h1 { margin: 0; font-size: 24px; }
          .content { padding: 24px; line-height: 1.6; }
          .details { background: #f3f4f6; border-radius: 8px; padding: 16px; margin: 20px 0; }
          .details p { margin: 6px 0; }
          .actions { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 24px; }
          button, .link-button { border: 0; border-radius: 8px; padding: 12px 18px; font-weight: 700; cursor: pointer; text-decoration: none; display: inline-block; }
          .danger { background: #dc2626; color: white; }
          .secondary { background: #e5e7eb; color: #111827; }
          .footer { color: #6b7280; font-size: 13px; margin-top: 20px; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="header"><h1>${escapeHtml(title)}</h1></div>
          <div class="content">
            <p>${escapeHtml(message)}</p>
            ${details}
            ${actionHtml}
            <p class="footer">Ce lien est sécurisé et ne permet d'annuler que la demande concernée.</p>
          </div>
        </div>
      </body>
      </html>
    `
  };
}

function getDemandeDetailsHtml(demande) {
  return `
    <div class="details">
      <p><strong>Employé :</strong> ${escapeHtml(`${demande.prenom || ''} ${demande.nom || ''}`.trim())}</p>
      <p><strong>Type :</strong> ${escapeHtml(getDemandeTypeLabel(demande.type_demande))}</p>
      <p><strong>Motif :</strong> ${escapeHtml(demande.titre)}</p>
      <p><strong>Date de départ :</strong> ${escapeHtml(formatDateShortApp(demande.date_depart))}</p>
      ${demande.date_retour ? `<p><strong>Date de retour :</strong> ${escapeHtml(formatDateShortApp(demande.date_retour))}</p>` : ''}
      ${demande.heure_depart ? `<p><strong>Heure de départ :</strong> ${escapeHtml(demande.heure_depart)}</p>` : ''}
      ${demande.heure_retour ? `<p><strong>Heure de retour :</strong> ${escapeHtml(demande.heure_retour)}</p>` : ''}
    </div>
  `;
}

function getDemandeCancellationRecipients(demande) {
  const recipients = [
    demande.mail_responsable1,
    demande.mail_responsable2
  ];

  return [...new Set(recipients.filter(email => email && isValidEmail(email)))];
}

async function sendDemandeCancellationNotification(demande) {
  const recipients = getDemandeCancellationRecipients(demande);
  const typeLabel = getDemandeTypeLabel(demande.type_demande);
  const employeeName = `${demande.prenom || ''} ${demande.nom || ''}`.trim();

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #dc2626; border-bottom: 3px solid #dc2626; padding-bottom: 10px;">
        Demande RH annulée
      </h2>
      <div style="background: #fef2f2; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #dc2626;">
        <p>Une demande RH approuvée vient d'être annulée par l'employé.</p>
      </div>
      <div style="background: #f8fafc; padding: 20px; border-radius: 8px; margin: 20px 0;">
        <p><strong>Employé :</strong> ${escapeHtml(employeeName)}</p>
        <p><strong>Matricule :</strong> ${escapeHtml(demande.matricule || 'Non spécifié')}</p>
        <p><strong>Type :</strong> ${escapeHtml(typeLabel)}</p>
        <p><strong>Motif :</strong> ${escapeHtml(demande.titre)}</p>
        <p><strong>Date de départ :</strong> ${escapeHtml(formatDateShortApp(demande.date_depart))}</p>
        ${demande.date_retour ? `<p><strong>Date de retour :</strong> ${escapeHtml(formatDateShortApp(demande.date_retour))}</p>` : ''}
        ${demande.heure_depart ? `<p><strong>Heure de départ :</strong> ${escapeHtml(demande.heure_depart)}</p>` : ''}
        ${demande.heure_retour ? `<p><strong>Heure de retour :</strong> ${escapeHtml(demande.heure_retour)}</p>` : ''}
      </div>
      <p style="color: #6b7280; font-size: 14px;">Le statut de la demande est maintenant : Demande annulée.</p>
    </div>
  `;

  await sendEmail(recipients, `Demande RH annulée - ${employeeName}`, html);
}

async function getDemandeCancellationContext(id) {
  const result = await pool.query(
    `SELECT d.*,
            e.nom, e.prenom, e.adresse_mail, e.poste, e.matricule,
            e.mail_responsable1, e.mail_responsable2
     FROM demande_rh d
     JOIN employees e ON d.employe_id = e.id
     WHERE d.id = $1`,
    [id]
  );

  return result.rows[0] || null;
}

// Fonction pour vérifier et envoyer les alertes de fin de contrat
async function checkContractEndAlerts() {
  try {
    console.log('🔔 Vérification des alertes de fin de contrat...');
    
    const result = await pool.query(
      `SELECT id, matricule, nom, prenom, date_fin_contrat, poste 
       FROM employees 
       WHERE statut = 'actif'
         AND date_fin_contrat IS NOT NULL
         -- Your logic: contract_end_date - 30 days = today
         AND (date_fin_contrat - INTERVAL '30 days')::date = CURRENT_DATE
         -- Never alerted OR not alerted this month yet
         AND (
           last_contract_alert IS NULL
           OR DATE_TRUNC('month', last_contract_alert) < DATE_TRUNC('month', CURRENT_DATE)
         )`
    );
    
    console.log(`📊 ${result.rows.length} employé(s) à alerter aujourd'hui`);
    
    for (const employee of result.rows) {
      await sendContractEndAlert(employee);
      
      await pool.query(
        'UPDATE employees SET last_contract_alert = CURRENT_TIMESTAMP WHERE id = $1',
        [employee.id]
      );
      
      console.log(`✅ Alerte envoyée pour ${employee.prenom} ${employee.nom} 
        (Fin contrat: ${employee.date_fin_contrat})`);
    }
    
    return result.rows;
  } catch (error) {
    console.error('❌ Erreur vérification alertes fin de contrat:', error);
    return [];
  }
}

// Fonction pour envoyer l'alerte email
async function sendContractEndAlert(employee) {
  try {
    const emailTo = 'jamie.lambert@example.com';
    const formattedDate = new Date(employee.date_fin_contrat).toLocaleDateString('fr-FR');
    
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>⚠️ Alerte Fin de Contrat</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #dc3545; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
          .content { background: #f8f9fa; padding: 30px; border: 1px solid #e9ecef; border-top: none; border-radius: 0 0 8px 8px; }
          .alert-box { background: #fff3cd; border: 2px solid #ffc107; padding: 20px; margin: 20px 0; border-radius: 5px; }
          .employee-info { background: white; border: 1px solid #dee2e6; padding: 15px; margin: 20px 0; border-radius: 5px; }
          .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #e9ecef; color: #6c757d; font-size: 12px; text-align: center; }
          .warning-icon { font-size: 24px; margin-right: 10px; }
        </style>
      </head>
      <body>
        <div class="header">
          <h2>⚠️ ALERTE FIN DE CONTRAT</h2>
        </div>
        <div class="content">
          <div class="alert-box">
            <p><span class="warning-icon">⚠️</span> <strong>Alerte Préventive</strong></p>
            <p>La date de fin de contrat d'un employé approche dans moins d'1 mois.</p>
          </div>
          
          <div class="employee-info">
            <h3>👤 Informations de l'employé</h3>
            <p><strong>Nom complet :</strong> ${employee.prenom} ${employee.nom}</p>
            <p><strong>Matricule :</strong> ${employee.matricule}</p>
            <p><strong>Poste :</strong> ${employee.poste || 'Non spécifié'}</p>
            <p><strong>Date de fin de contrat :</strong> <span style="color: #dc3545; font-weight: bold;">${formattedDate}</span></p>
          </div>
          
         
          
          <p>Cette alerte est envoyée automatiquement par le système RH.</p>
        </div>
        <div class="footer">
          <p>© ${new Date().getFullYear()} RH Manager - Administration SAHEL</p>
          <p>Ceci est un message automatique, merci de ne pas y répondre.</p>
        </div>
      </body>
      </html>
    `;
    
    await sendEmail(emailTo, `⚠️ Alerte Fin de Contrat - ${employee.prenom} ${employee.nom}`, html);
    console.log(`✅ Alerte envoyée pour ${employee.prenom} ${employee.nom} (Fin contrat: ${formattedDate})`);
    
  } catch (error) {
    console.error(`❌ Erreur envoi alerte pour ${employee.prenom} ${employee.nom}:`, error);
  }
}


// =========================
// NOUVELLES ROUTES POUR MOT DE PASSE OUBLIÉ
// =========================

// Route pour envoyer un nouveau mot de passe directement par email
app.post('/api/auth/send-new-password', async (req, res) => {
  try {
    const { email } = req.body;
    
    console.log('🔐 Demande de nouveau mot de passe pour:', email);
    
    if (!email || !isValidEmail(email)) {
      return res.status(400).json({
        success: false,
        message: 'Adresse email invalide'
      });
    }
    
    // Vérifier si l'utilisateur existe
    const userResult = await pool.query(
      'SELECT id, email FROM users WHERE email = $1',
      [email]
    );
    
    if (userResult.rows.length === 0) {
      console.log('❌ Utilisateur non trouvé:', email);
      // Pour des raisons de sécurité, on ne révèle pas si l'email existe ou non
      return res.json({
        success: true,
        message: 'Si un compte avec cet email existe, un nouveau mot de passe a été envoyé'
      });
    }
    
    const user = userResult.rows[0];

    // Générer un nouveau mot de passe
    const newPassword = generateRandomPassword(10);
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Générer un jeton d'auto-connexion à usage unique (valide 30 minutes)
    const loginToken = crypto.randomBytes(32).toString('hex');
    const loginTokenHash = crypto.createHash('sha256').update(loginToken).digest('hex');
    const loginTokenExpires = new Date(Date.now() + 30 * 60 * 1000);

    // Mettre à jour le mot de passe et le jeton d'auto-connexion dans la base
    await pool.query(
      'UPDATE users SET password = $1, login_token_hash = $2, login_token_expires = $3 WHERE id = $4',
      [hashedPassword, loginTokenHash, loginTokenExpires, user.id]
    );

    const autoLoginUrl = `${process.env.FRONTEND_URL || 'https://your-app.azurewebsites.net'}/auto-login?token=${loginToken}`;

    // Contenu HTML de l'email
    const emailHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Your new RH Manager password</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #2563eb; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
          .content { background: #f8fafc; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px; }
          .password-box { background: white; border: 2px solid #2563eb; padding: 20px; margin: 20px 0; text-align: center; font-size: 18px; font-weight: bold; border-radius: 5px; }
          .button { display: inline-block; background: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; font-weight: bold; margin: 20px 0; }
          .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e7eb; color: #6b7280; font-size: 12px; text-align: center; }
          .warning { background: #fee2e2; border: 2px solid #dc2626; color: #991b1b; padding: 15px; border-radius: 5px; margin: 20px 0; }
          .instructions { background: #fef3c7; border: 1px solid #f59e0b; padding: 15px; border-radius: 5px; margin: 20px 0; }
        </style>
      </head>
      <body>
        <div class="header">
          <h2>🔐 Your new RH Manager password</h2>
        </div>
        <div class="content">
          <p>Hello,</p>
          <p>You requested a new password for the <strong>RH Manager</strong> application.</p>
          <p>Here are your new login details:</p>

          <div style="background: white; border: 1px solid #e5e7eb; border-radius: 5px; padding: 15px; margin: 20px 0;">
            <p><strong>Email:</strong> ${email}</p>
            <p><strong>New password:</strong></p>
            <div class="password-box">${newPassword}</div>
          </div>

          <div class="warning">
            <p><strong>⚠️ SECURITY:</strong> Never share this email with anyone.</p>
          </div>

          <div class="instructions">
            <p><strong>📋 Important instructions:</strong></p>
            <ol>
              <li>Log in immediately using this password</li>
              <li>Go to your user profile</li>
              <li>Replace this temporary password with a personal one</li>
            </ol>
          </div>

          <div style="text-align: center;">
            <a href="${autoLoginUrl}" class="button">
              Log in to RH Manager
            </a>
          </div>
          <p style="font-size: 12px; color: #6b7280; text-align: center;">This button signs you in automatically and is valid for 30 minutes and one use only. If it no longer works, sign in manually with the email and password above.</p>

          <p>Best regards,<br>The RH Manager Team - SAHEL Administration</p>
        </div>
        <div class="footer">
          <p>This is an automated message, please do not reply.</p>
          <p>© ${new Date().getFullYear()} RH Manager - All rights reserved</p>
        </div>
      </body>
      </html>
    `;

    try {
      await sendEmail(email, 'Your new RH Manager password', emailHtml);
      
      console.log('✅ Nouveau mot de passe envoyé à:', email);
      
      res.json({
        success: true,
        message: 'Si un compte avec cet email existe, un nouveau mot de passe a été envoyé'
      });
    } catch (emailError) {
      console.error('❌ Erreur envoi email:', emailError);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de l\'envoi du nouveau mot de passe'
      });
    }
    
  } catch (error) {
    console.error('❌ Erreur envoi nouveau mot de passe:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de l\'envoi du nouveau mot de passe'
    });
  }
});

// Route pour la connexion automatique via le lien à usage unique envoyé par email
app.post('/api/auth/consume-login-token', async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ success: false, message: 'Jeton manquant' });
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const userResult = await pool.query(
      'SELECT * FROM users WHERE login_token_hash = $1 AND login_token_expires > NOW()',
      [tokenHash]
    );

    if (userResult.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'This automatic login link has expired or was already used'
      });
    }

    const user = userResult.rows[0];

    // Jeton à usage unique : on l'invalide immédiatement
    await pool.query(
      'UPDATE users SET login_token_hash = NULL, login_token_expires = NULL WHERE id = $1',
      [user.id]
    );

    const tenantSchema = getSchemaForUser(user);
    const countryKey = inferCountryKey(user);

    const jwtToken = jwt.sign(
      {
        userId: user.id,
        email: user.email,
        role: user.role || 'user',
        tenant_id: user.tenant_id || null,
        plant: user.plant || null,
        country: countryKey,
        tenant_schema: tenantSchema,
        name: user.name || null
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    console.log('✅ Auto-login réussi via lien à usage unique pour:', user.email);

    res.json({
      success: true,
      token: jwtToken,
      user: {
        id: user.id,
        email: user.email,
        role: user.role || 'user',
        tenant_id: user.tenant_id || null,
        plant: user.plant || null,
        country: countryKey,
        tenant_schema: tenantSchema,
        name: user.name || null
      }
    });
  } catch (error) {
    console.error('❌ Erreur auto-login:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur lors de la connexion automatique'
    });
  }
});

// =========================
// SSO Microsoft (Entra ID)
// =========================
// The frontend signs in with Microsoft (MSAL popup) and sends the ID token
// here. We check it was issued by the Northwind tenant for this app, then
// look the email up in `users` and issue the usual app JWT -- so roles and
// countries still come from our own table, and only people who already have
// an account can get in. Password login stays available alongside.
// Defaults: Northwind tenant + "HR-Service" app registration (shared with
// Pointeuse). Public identifiers only -- no client secret is used here.
const AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || '00000000-0000-0000-0000-000000000000';
const AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || '00000000-0000-0000-0000-000000000000';
const microsoftJwks = AZURE_TENANT_ID
  ? require('jwks-rsa')({
      jwksUri: `https://login.microsoftonline.com/${AZURE_TENANT_ID}/discovery/v2.0/keys`,
      cache: true,
      rateLimit: true
    })
  : null;

const verifyMicrosoftIdToken = (idToken) =>
  new Promise((resolve, reject) => {
    jwt.verify(
      idToken,
      (header, callback) => {
        microsoftJwks.getSigningKey(header.kid, (err, key) => callback(err, key?.getPublicKey()));
      },
      {
        algorithms: ['RS256'],
        audience: AZURE_CLIENT_ID,
        issuer: `https://login.microsoftonline.com/${AZURE_TENANT_ID}/v2.0`
      },
      (err, claims) => (err ? reject(err) : resolve(claims))
    );
  });

app.post('/api/auth/microsoft', async (req, res) => {
  if (!microsoftJwks || !AZURE_CLIENT_ID) {
    return res.status(503).json({ success: false, message: 'Connexion Microsoft non configurée' });
  }

  const { idToken } = req.body || {};
  if (!idToken) {
    return res.status(400).json({ success: false, message: 'Jeton Microsoft manquant' });
  }

  let claims;
  try {
    claims = await verifyMicrosoftIdToken(idToken);
  } catch (error) {
    console.warn('❌ Jeton Microsoft refusé:', error.message);
    return res.status(401).json({ success: false, message: 'Connexion Microsoft refusée' });
  }

  try {
    const email = String(claims.preferred_username || claims.email || claims.upn || '').trim().toLowerCase();
    const userResult = email
      ? await pool.query('SELECT * FROM users WHERE LOWER(email) = $1', [email])
      : { rows: [] };

    if (userResult.rows.length === 0) {
      console.log('❌ SSO: aucun compte RH pour', email || '(email absent)');
      return res.status(403).json({
        success: false,
        code: 'SSO_NO_ACCOUNT',
        message: "Aucun compte RH Manager n'est associé à ce compte Microsoft"
      });
    }

    const user = userResult.rows[0];
    const tenantSchema = getSchemaForUser(user);
    const countryKey = inferCountryKey(user);
    const appUser = {
      id: user.id,
      email: user.email,
      role: user.role || 'user',
      tenant_id: user.tenant_id || null,
      plant: user.plant || null,
      country: countryKey,
      tenant_schema: tenantSchema,
      name: user.name || null
    };

    const token = jwt.sign(
      {
        userId: user.id,
        email: user.email,
        role: appUser.role,
        tenant_id: appUser.tenant_id,
        plant: appUser.plant,
        country: countryKey,
        tenant_schema: tenantSchema,
        name: appUser.name
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    console.log('✅ SSO Microsoft réussi pour:', user.email);
    res.json({ success: true, token, user: appUser });
  } catch (error) {
    console.error('❌ Erreur SSO Microsoft:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur lors de la connexion Microsoft' });
  }
});

// =========================
// ROUTES EXISTANTES (à insérer ici)
// =========================

// Route pour uploader un PDF d'archive
app.post(
  '/api/archive/upload-pdf',
  authenticateToken,
  archivePdfUpload.single('pdfFile'),
  async (req, res) => {
    try {
      console.log('📄 ========== UPLOAD PDF ARCHIVE ==========');
      
      if (!req.file) {
        console.log('❌ Aucun fichier PDF uploadé');
        return res.status(400).json({ 
          success: false, 
          error: 'Aucun fichier PDF uploadé' 
        });
      }

      console.log('📁 Fichier PDF reçu:', {
        filename: req.file.filename,
        originalname: req.file.originalname,
        size: req.file.size,
        mimetype: req.file.mimetype
      });

      // Générer l'URL accessible
      const baseUrl = process.env.BACKEND_URL || 'https://your-app.azurewebsites.net';
      const pdfUrl = `${baseUrl}/api/archive-pdfs/${req.file.filename}`;
      
      console.log('✅ PDF sauvegardé:', {
        fileName: req.file.filename,
        pdfUrl: pdfUrl
      });

      res.json({
        success: true,
        message: 'PDF uploadé avec succès',
        pdfUrl: pdfUrl,
        fileName: req.file.filename
      });

    } catch (error) {
      console.error('❌ Erreur upload PDF archive:', error);
      
      res.status(500).json({
        success: false,
        error: "Erreur lors de l'upload du PDF",
        details: error.message
      });
    }
  }
);

// Route pour servir les PDF d'archive
app.get('/api/archive-pdfs/:filename', (req, res) => {
  try {
    const filename = req.params.filename;
    const filePath = path.join(archivePdfDir, filename);
    
    console.log('📄 Demande PDF archive:', filename);
    
    if (!fs.existsSync(filePath)) {
      console.error('❌ PDF non trouvé:', filePath);
      return res.status(404).json({ error: 'PDF non trouvé' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.sendFile(filePath);
    
  } catch (error) {
    console.error('❌ Erreur service PDF archive:', error);
    res.status(500).json({ error: 'Erreur lors du chargement du PDF' });
  }
});

// =========================
// ROUTE D'ARCHIVAGE (AVEC OU SANS PDF)
// =========================
app.put('/api/employees/:id/archive', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { pdf_url, entretien_depart, date_depart, note_gratification_depart } = req.body;
    const requestedSchema = req.body?.tenant_schema || req.query?.tenant_schema;
    const schema = await resolveEmployeeSchemaById(req.user, id, requestedSchema);

    console.log('📁 Archivage employé ID:', id, {
      pdf_url: pdf_url ? 'PDF fourni' : 'Aucun PDF',
      date_depart: date_depart,
      tenant_schema: schema
    });

    if (!schema) {
      return res.status(404).json({
        success: false,
        error: 'Employé non trouvé'
      });
    }

    // Vérifier si l'employé existe
    const employeeCheck = await pool.query(
      `SELECT id, statut FROM ${schema}.employees WHERE id = $1`,
      [id]
    );

    if (employeeCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Employé non trouvé'
      });
    }

    if (employeeCheck.rows[0].statut === 'archive') {
      return res.status(400).json({
        success: false,
        error: 'Employé déjà archivé'
      });
    }

    // Formater la date pour PostgreSQL (YYYY-MM-DD)
    let formattedDate;
    if (date_depart) {
      try {
        if (date_depart.includes('T')) {
          formattedDate = date_depart.split('T')[0];
        } else {
          formattedDate = date_depart;
        }
        
        const dateObj = new Date(formattedDate);
        if (isNaN(dateObj.getTime())) {
          return res.status(400).json({
            success: false,
            error: 'Format de date invalide'
          });
        }
      } catch (dateError) {
        console.error('❌ Erreur formatage date:', dateError);
        return res.status(400).json({
          success: false,
          error: 'Format de date invalide'
        });
      }
    } else {
      formattedDate = new Date().toISOString().split('T')[0];
      console.log('📅 Utilisation date du jour:', formattedDate);
    }

    // Préparer les valeurs pour la mise à jour
    const updateFields = {
      date_depart: formattedDate,
      entretien_depart: entretien_depart || (pdf_url ? 'Entretien de départ archivé' : 'Archivé sans entretien'),
      pdf_archive_url: pdf_url || null,
      statut: 'archive',
      updated_at: new Date()
    };

    // Note de gratification for the solde de tout compte -- the column only
    // exists on public.employees (Tunisia/SAHEL payroll), where it is required:
    // it can't be entered anywhere else once the employee is archived.
    const noteMissing = note_gratification_depart === undefined || note_gratification_depart === null || String(note_gratification_depart).trim() === '';
    if (schema === 'public' && noteMissing) {
      return res.status(400).json({
        success: false,
        error: 'La note de gratification (0 à 20) est obligatoire pour archiver un employé SAHEL'
      });
    }
    if (note_gratification_depart !== undefined && note_gratification_depart !== null && note_gratification_depart !== '') {
      const note = Number(note_gratification_depart);
      if (!Number.isFinite(note) || note < 0 || note > 20) {
        return res.status(400).json({
          success: false,
          error: 'La note de gratification doit être comprise entre 0 et 20'
        });
      }
      if (schema === 'public') updateFields.note_gratification_depart = note;
    }

    // Requête SQL dynamique
    const setClauses = [];
    const values = [];
    let paramIndex = 1;

    Object.entries(updateFields).forEach(([key, value]) => {
      setClauses.push(`${key} = $${paramIndex}`);
      values.push(value);
      paramIndex++;
    });

    values.push(id); // Pour le WHERE

    const query = `
      UPDATE ${schema}.employees 
      SET ${setClauses.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING *
    `;

    const result = await pool.query(query, values);

    console.log('✅ Employé archivé:', {
      id: id,
      avecPDF: !!pdf_url,
      dateDepart: formattedDate
    });

    res.json({
      success: true,
      message: pdf_url ? 'Employé archivé avec succès' : 'Employé archivé sans document',
      employee: result.rows[0]
    });
  } catch (error) {
    console.error("❌ Erreur archivage:", error);
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        error: error.message,
        code: error.code,
        matches: error.matches || undefined
      });
    }
    
    let errorMessage = "Erreur lors de l'archivage de l'employé";
    
    if (error.code === '22007') {
      errorMessage = "Format de date invalide pour la base de données";
    } else if (error.code === '23505') {
      errorMessage = "Violation de contrainte unique";
    }
    
    res.status(500).json({
      success: false,
      error: errorMessage,
      details: error.message,
      code: error.code
    });
  }
});

// Route pour uploader une photo d'employé
app.post(
  '/api/employees/upload-photo',
  authenticateToken,
  employeePhotoUpload.single('photo'),
  async (req, res) => {
    try {
      console.log('📸 ========== UPLOAD PHOTO EMPLOYÉ ==========');
      
      if (!req.file) {
        console.log('❌ Aucun fichier uploadé');
        return res.status(400).json({ 
          success: false, 
          error: 'Aucun fichier uploadé' 
        });
      }

      console.log('📁 Fichier reçu:', {
        filename: req.file.filename,
        originalname: req.file.originalname,
        size: req.file.size,
        mimetype: req.file.mimetype
      });

      // Renommer le fichier pour un nom plus propre
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
      const newFileName = `employee-photo-${uniqueSuffix}${path.extname(req.file.originalname)}`;
      const newFilePath = path.join(employeePhotoDir, newFileName);
      
      // Déplacer le fichier du temp vers le dossier final
      fs.renameSync(req.file.path, newFilePath);
      
      // Générer l'URL accessible
      const baseUrl = process.env.BACKEND_URL || 'https://your-app.azurewebsites.net';
      const photoUrl = `${baseUrl}/api/employee-photos/${newFileName}`;
      
      console.log('✅ Photo sauvegardée:', {
        newFileName: newFileName,
        photoUrl: photoUrl
      });

      res.json({
        success: true,
        message: 'Photo uploadée avec succès',
        photoUrl: photoUrl,
        fileName: newFileName
      });

    } catch (error) {
      console.error('❌ Erreur upload photo employé:', error);
      
      res.status(500).json({
        success: false,
        error: "Erreur lors de l'upload de la photo",
        details: error.message
      });
    }
  }
);

// Route pour servir les photos d'employés
app.get('/api/employee-photos/:filename', (req, res) => {
  try {
    const filename = req.params.filename;
    const filePath = path.join(employeePhotoDir, filename);
    
    console.log('🖼️ Demande photo:', filename);
    
    if (!fs.existsSync(filePath)) {
      console.error('❌ Photo non trouvée:', filePath);
      return res.status(404).json({ error: 'Photo non trouvée' });
    }

    // Déterminer le type MIME
    const ext = path.extname(filename).toLowerCase();
    const mimeTypes = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp'
    };
    
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache 24h
    res.sendFile(filePath);
    
  } catch (error) {
    console.error('❌ Erreur service photo:', error);
    res.status(500).json({ error: 'Erreur lors du chargement de la photo' });
  }
});
// Nouvelle route pour uploader fichiers (images + PDFs)
app.post(
  '/api/dossier-rh/upload-files',
  authenticateToken,
  dossierFileUpload.array('files', 50),
  async (req, res) => {
    try {
      console.log('📄 Upload fichiers dossier RH - Files reçus:', req.files?.length || 0);
      
      if (!req.files || req.files.length === 0) {
        console.log('❌ Aucun fichier reçu');
        return res.status(400).json({ error: 'Aucun fichier uploadé' });
      }

      const fileInfos = req.files.map(file => ({
        filename: file.filename,
        originalname: file.originalname,
        size: file.size,
        mimetype: file.mimetype,
        isImage: file.mimetype.startsWith('image/'),
        isPdf: file.mimetype === 'application/pdf' || 
               file.originalname.toLowerCase().endsWith('.pdf'),
        path: file.path
      }));

      console.log('✅ Fichiers uploadés:', fileInfos);

      res.json({
        success: true,
        files: fileInfos,
        message: `${req.files.length} fichier(s) uploadé(s) avec succès`
      });
    } catch (error) {
      console.error('❌ Erreur upload fichiers:', error);
      res.status(500).json({
        error: "Erreur lors de l'upload des fichiers",
        details: error.message
      });
    }
  }
);
// Nouvelle route complète pour traiter les fichiers dossier RH
app.post(
  '/api/dossier-rh/process/:employeeId',
  authenticateToken,
  async (req, res) => {
    try {
      const { employeeId } = req.params;
      const { files: clientFiles, dossierName, mode = 'create' } = req.body;

      console.log('🔄 Traitement dossier RH pour employé:', employeeId, 
        'dossier:', dossierName, 'mode:', mode);

      if (!dossierName || !dossierName.trim()) {
        return res.status(400).json({ error: 'Nom de dossier manquant' });
      }

      if (!Array.isArray(clientFiles) || clientFiles.length === 0) {
        return res.status(400).json({ error: 'Aucun fichier fourni pour le dossier' });
      }

      // Vérifier l'employé
      const employeeResult = await pool.query(
        'SELECT * FROM employees WHERE id = $1', 
        [employeeId]
      );

      if (employeeResult.rows.length === 0) {
        return res.status(404).json({ error: 'Employé non trouvé' });
      }

      const employee = employeeResult.rows[0];
      const hasExistingDossier = employee.dossier_rh && mode === 'merge';

      // Construire les chemins complets
      const files = clientFiles.map(f => ({
        ...f,
        path: path.join(uploadTempDir, f.filename)
      }));

      console.log('📂 Fichiers à traiter:', files);

      // Vérifier l'existence des fichiers
      const missingFiles = files.filter(f => !fs.existsSync(f.path));
      if (missingFiles.length > 0) {
        console.error('❌ Fichiers manquants:', missingFiles);
        return res.status(400).json({
          error: 'Certains fichiers sont introuvables sur le serveur',
          details: `${missingFiles.length} fichier(s) manquant(s)`
        });
      }

      // Séparer les images des PDFs
      const imageFiles = files.filter(f => f.isImage && !f.isPdf);
      const pdfFiles = files.filter(f => f.isPdf);

      console.log(`📊 Images: ${imageFiles.length}, PDFs: ${pdfFiles.length}`);

      let finalPdfUrl;

      if (hasExistingDossier) {
        // MODE FUSION : Fusionner avec l'existant
        finalPdfUrl = await mergeWithExistingDossier(employee, imageFiles, pdfFiles, dossierName);
      } else {
        // MODE CRÉATION : Créer un nouveau dossier
        finalPdfUrl = await createNewDossier(employee, imageFiles, pdfFiles, dossierName);
      }

      // Mettre à jour la base de données
      const updateResult = await pool.query(
        'UPDATE employees SET dossier_rh = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
        [finalPdfUrl, employeeId]
      );

      // Nettoyer les fichiers temporaires
      files.forEach(file => {
        try {
          if (file.path && fs.existsSync(file.path)) {
            fs.unlinkSync(file.path);
            console.log('🧹 Fichier temporaire supprimé:', file.path);
          }
        } catch (cleanupErr) {
          console.warn('⚠️ Erreur suppression fichier temporaire:', cleanupErr.message);
        }
      });

      res.json({
        success: true,
        message: hasExistingDossier 
          ? 'Dossier RH fusionné avec succès' 
          : 'Dossier RH créé avec succès',
        pdfUrl: finalPdfUrl,
        employee: updateResult.rows[0],
        stats: {
          images: imageFiles.length,
          pdfs: pdfFiles.length,
          total: files.length
        }
      });

    } catch (error) {
      console.error('❌ Erreur traitement dossier RH:', {
        message: error.message,
        stack: error.stack
      });
      res.status(500).json({
        error: 'Erreur lors du traitement du dossier RH',
        details: error.message
      });
    }
  }
);
// =========================
// CORRECTIONS POUR DOSSIER RH - INTÉGRATION DES IMAGES
// =========================

// Fonction pour créer un nouveau dossier (VERSION CORRIGÉE)
async function createNewDossier(employee, imageFiles, pdfFiles, dossierName) {
  const { PDFDocument } = require('pdf-lib');
  
  console.log('🆕 Création nouveau dossier...');
  console.log(`📊 ${imageFiles.length} image(s), ${pdfFiles.length} PDF(s)`);
  
  // Créer un nouveau document PDF
  const pdfDoc = await PDFDocument.create();
  
  // 1. Ajouter la page de garde
  const firstPage = pdfDoc.addPage([595.28, 841.89]); // A4
  firstPage.drawText('DOSSIER RH', {
    x: 50,
    y: 800,
    size: 24
  });
  firstPage.drawText(`Employé : ${employee.prenom} ${employee.nom}`, {
    x: 50,
    y: 760,
    size: 14
  });
  firstPage.drawText(`Matricule : ${employee.matricule || '-'}`, {
    x: 50,
    y: 735,
    size: 12
  });
  firstPage.drawText(`Poste : ${employee.poste || '-'}`, {
    x: 50,
    y: 710,
    size: 12
  });
  firstPage.drawText(`Nom du dossier : ${dossierName || '-'}`, {
    x: 50,
    y: 685,
    size: 12
  });
  firstPage.drawText(`Date : ${new Date().toLocaleDateString('fr-FR')}`, {
    x: 50,
    y: 660,
    size: 10
  });
  
  // 2. Ajouter les images (VERSION CORRIGÉE)
  for (const imageFile of imageFiles) {
    try {
      console.log(`📷 Traitement image: ${imageFile.filename}`);
      
      if (!fs.existsSync(imageFile.path)) {
        console.warn(`⚠️ Image introuvable: ${imageFile.path}`);
        continue;
      }

      const imageBytes = fs.readFileSync(imageFile.path);
      let image;

      // Déterminer le type d'image et l'embedder
      const ext = path.extname(imageFile.filename).toLowerCase();
      
      if (ext === '.jpg' || ext === '.jpeg') {
        image = await pdfDoc.embedJpg(imageBytes);
      } else if (ext === '.png') {
        image = await pdfDoc.embedPng(imageBytes);
      } else {
        console.warn(`⚠️ Format non supporté: ${ext}`);
        continue;
      }

      // Créer une nouvelle page
      const page = pdfDoc.addPage([595.28, 841.89]);
      
      // Calculer les dimensions pour adapter l'image à la page
      const pageWidth = page.getWidth();
      const pageHeight = page.getHeight();
      const margin = 50;
      const maxWidth = pageWidth - (margin * 2);
      const maxHeight = pageHeight - (margin * 2);

      const imgWidth = image.width;
      const imgHeight = image.height;
      
      // Calculer le ratio pour que l'image rentre dans la page
      const widthRatio = maxWidth / imgWidth;
      const heightRatio = maxHeight / imgHeight;
      const ratio = Math.min(widthRatio, heightRatio);

      const finalWidth = imgWidth * ratio;
      const finalHeight = imgHeight * ratio;

      // Centrer l'image
      const x = (pageWidth - finalWidth) / 2;
      const y = (pageHeight - finalHeight) / 2;

      // Dessiner l'image
      page.drawImage(image, {
        x: x,
        y: y,
        width: finalWidth,
        height: finalHeight,
      });

      // Ajouter le nom du fichier en bas de page
      page.drawText(`Image: ${imageFile.originalname || imageFile.filename}`, {
        x: 50,
        y: 30,
        size: 8
      });

      console.log(`✅ Image ajoutée: ${imageFile.filename}`);
    } catch (imageError) {
      console.error(`❌ Erreur avec l'image ${imageFile.filename}:`, imageError);
    }
  }
  
  // 3. Ajouter les PDFs existants
  for (const pdfFile of pdfFiles) {
    try {
      const existingPdfBytes = fs.readFileSync(pdfFile.path);
      const existingPdf = await PDFDocument.load(existingPdfBytes);
      const copiedPages = await pdfDoc.copyPages(existingPdf, existingPdf.getPageIndices());
      copiedPages.forEach(page => pdfDoc.addPage(page));
      console.log(`✅ PDF ajouté: ${pdfFile.originalname}`);
    } catch (pdfError) {
      console.error(`❌ Erreur avec le PDF ${pdfFile.filename}:`, pdfError);
    }
  }
  
  // Sauvegarder le PDF
  const pdfBytes = await pdfDoc.save();
  const fileName = `dossier-${employee.matricule || 'EMP'}-${Date.now()}.pdf`;
  const filePath = path.join(pdfStorageDir, fileName);
  
  fs.writeFileSync(filePath, pdfBytes);
  
  const baseUrl = process.env.BACKEND_URL || 'https://your-app.azurewebsites.net';
  const pdfUrl = `${baseUrl}/api/pdfs/${fileName}`;
  
  console.log(`✅ Nouveau dossier créé avec ${pdfDoc.getPageCount()} page(s):`, pdfUrl);
  return pdfUrl;
}

// Fonction pour fusionner avec un dossier existant (VERSION CORRIGÉE)
async function mergeWithExistingDossier(employee, imageFiles, pdfFiles, dossierName) {
  const { PDFDocument } = require('pdf-lib');
  
  console.log('🔄 Fusion avec dossier existant...');
  console.log(`📊 ${imageFiles.length} image(s), ${pdfFiles.length} PDF(s) à ajouter`);
  
  // Charger l'ancien PDF
  let oldPdfDoc;
  let oldPdfPath = null;
  
  if (employee.dossier_rh) {
    const urlParts = employee.dossier_rh.split('/');
    const oldPdfFilename = urlParts[urlParts.length - 1];
    oldPdfPath = path.join(pdfStorageDir, oldPdfFilename);
    
    if (fs.existsSync(oldPdfPath)) {
      const oldPdfBytes = fs.readFileSync(oldPdfPath);
      oldPdfDoc = await PDFDocument.load(oldPdfBytes);
      console.log(`✅ Ancien PDF chargé: ${oldPdfDoc.getPageCount()} page(s)`);
    } else {
      oldPdfDoc = await PDFDocument.create();
      console.warn('⚠️ Ancien PDF introuvable, création nouveau');
    }
  } else {
    oldPdfDoc = await PDFDocument.create();
  }
  
  // Créer un nouveau document pour les nouvelles pages
  const newContentDoc = await PDFDocument.create();
  
  // Ajouter une page d'ajout avec info
  const updatePage = newContentDoc.addPage([595.28, 841.89]);
  updatePage.drawText(`MISE À JOUR DU DOSSIER - ${new Date().toLocaleDateString('fr-FR')}`, {
    x: 50,
    y: 800,
    size: 16
  });
  updatePage.drawText(`Nom du dossier : ${dossierName}`, {
    x: 50,
    y: 770,
    size: 12
  });
  updatePage.drawText(`${imageFiles.length} image(s) + ${pdfFiles.length} PDF(s) ajouté(s)`, {
    x: 50,
    y: 745,
    size: 10
  });
  
  // Ajouter les nouvelles images (VERSION CORRIGÉE)
  for (const imageFile of imageFiles) {
    try {
      console.log(`📷 Traitement image: ${imageFile.filename}`);
      
      if (!fs.existsSync(imageFile.path)) {
        console.warn(`⚠️ Image introuvable: ${imageFile.path}`);
        continue;
      }

      const imageBytes = fs.readFileSync(imageFile.path);
      let image;

      // Déterminer le type d'image et l'embedder
      const ext = path.extname(imageFile.filename).toLowerCase();
      
      if (ext === '.jpg' || ext === '.jpeg') {
        image = await newContentDoc.embedJpg(imageBytes);
      } else if (ext === '.png') {
        image = await newContentDoc.embedPng(imageBytes);
      } else {
        console.warn(`⚠️ Format non supporté: ${ext}`);
        continue;
      }

      // Créer une nouvelle page
      const page = newContentDoc.addPage([595.28, 841.89]);
      
      // Calculer les dimensions
      const pageWidth = page.getWidth();
      const pageHeight = page.getHeight();
      const margin = 50;
      const maxWidth = pageWidth - (margin * 2);
      const maxHeight = pageHeight - (margin * 2);

      const imgWidth = image.width;
      const imgHeight = image.height;
      
      const widthRatio = maxWidth / imgWidth;
      const heightRatio = maxHeight / imgHeight;
      const ratio = Math.min(widthRatio, heightRatio);

      const finalWidth = imgWidth * ratio;
      const finalHeight = imgHeight * ratio;

      const x = (pageWidth - finalWidth) / 2;
      const y = (pageHeight - finalHeight) / 2;

      // Dessiner l'image
      page.drawImage(image, {
        x: x,
        y: y,
        width: finalWidth,
        height: finalHeight,
      });

      // Ajouter le nom du fichier
      page.drawText(`Image: ${imageFile.originalname || imageFile.filename}`, {
        x: 50,
        y: 30,
        size: 8
      });

      console.log(`✅ Image ajoutée à la fusion: ${imageFile.filename}`);
    } catch (imageError) {
      console.error(`❌ Erreur image ${imageFile.filename}:`, imageError);
    }
  }
  
  // Ajouter les nouveaux PDFs
  for (const pdfFile of pdfFiles) {
    try {
      const pdfBytes = fs.readFileSync(pdfFile.path);
      const pdf = await PDFDocument.load(pdfBytes);
      const copiedPages = await newContentDoc.copyPages(pdf, pdf.getPageIndices());
      copiedPages.forEach(page => newContentDoc.addPage(page));
      console.log(`✅ PDF ajouté à la fusion: ${pdfFile.originalname}`);
    } catch (pdfError) {
      console.error(`❌ Erreur fusion PDF ${pdfFile.filename}:`, pdfError);
    }
  }
  
  // Fusionner les documents
  const mergedPdf = await PDFDocument.create();
  
  // 1. Copier toutes les pages de l'ancien PDF
  const oldPages = await mergedPdf.copyPages(oldPdfDoc, oldPdfDoc.getPageIndices());
  oldPages.forEach(page => mergedPdf.addPage(page));
  console.log(`✅ ${oldPages.length} anciennes pages copiées`);
  
  // 2. Copier toutes les pages du nouveau contenu
  const newPages = await mergedPdf.copyPages(newContentDoc, newContentDoc.getPageIndices());
  newPages.forEach(page => mergedPdf.addPage(page));
  console.log(`✅ ${newPages.length} nouvelles pages ajoutées`);
  
  // Sauvegarder
  const mergedBytes = await mergedPdf.save();
  const fileName = `dossier-${employee.matricule || 'EMP'}-${Date.now()}-merged.pdf`;
  const filePath = path.join(pdfStorageDir, fileName);
  
  fs.writeFileSync(filePath, mergedBytes);
  
  // Supprimer l'ancien PDF
  if (oldPdfPath && fs.existsSync(oldPdfPath)) {
    try {
      fs.unlinkSync(oldPdfPath);
      console.log('🧹 Ancien PDF supprimé:', oldPdfPath);
    } catch (deleteErr) {
      console.warn('⚠️ Impossible de supprimer ancien PDF:', deleteErr.message);
    }
  }
  
  const baseUrl = process.env.BACKEND_URL || 'https://your-app.azurewebsites.net';
  const pdfUrl = `${baseUrl}/api/pdfs/${fileName}`;
  
  console.log(`✅ Dossier fusionné avec ${mergedPdf.getPageCount()} page(s) totales:`, pdfUrl);
  return pdfUrl;
}
// Upload des photos temporaires pour dossier RH
app.post(
  '/api/dossier-rh/upload-photos',
  authenticateToken,
  (req, res, next) => {
    console.log('📸 Requête reçue sur /api/dossier-rh/upload-photos');
    next();
  },
  upload.array('photos', 30),
  async (req, res) => {
    try {
      console.log('📸 Upload photos - Files reçus:', req.files?.length || 0);
      
      if (!req.files || req.files.length === 0) {
        console.log('❌ Aucun fichier reçu');
        return res.status(400).json({ error: 'Aucune photo uploadée' });
      }

      const photoInfos = req.files.map(file => ({
        filename: file.filename,
        originalname: file.originalname,
        size: file.size,
        path: file.path
      }));

      console.log('✅ Photos uploadées:', photoInfos);

      res.json({
        success: true,
        photos: photoInfos,
        message: `${req.files.length} photo(s) uploadée(s) avec succès`
      });
    } catch (error) {
      console.error('❌ Erreur upload photos:', error);
      res.status(500).json({
        error: "Erreur lors de l'upload des photos",
        details: error.message
      });
    }
  }
);



// =========================
// ROUTE POUR FUSIONNER UN DOSSIER RH EXISTANT - VERSION CORRIGÉE
// =========================
app.post(
  '/api/dossier-rh/merge-pdf/:employeeId',
  authenticateToken,
  async (req, res) => {
    try {
      const { employeeId } = req.params;
      const { photos: clientPhotos, dossierName } = req.body;

      console.log('🔄 MERGE PDF pour employé:', employeeId, 'dossier:', dossierName);

      if (!dossierName || !dossierName.trim()) {
        return res.status(400).json({ error: 'Nom de dossier manquant' });
      }

      if (!Array.isArray(clientPhotos) || clientPhotos.length === 0) {
        return res.status(400).json({ error: 'Aucune photo fournie pour le dossier' });
      }

      const employeeResult = await pool.query('SELECT * FROM employees WHERE id = $1', [
        employeeId
      ]);

      if (employeeResult.rows.length === 0) {
        return res.status(404).json({ error: 'Employé non trouvé' });
      }

      const employee = employeeResult.rows[0];

      // Construire les chemins complets des nouvelles photos
      const newPhotos = clientPhotos.map(p => ({
        ...p,
        path: path.join(uploadTempDir, p.filename)
      }));

      console.log('📂 Chemins nouvelles photos construits:', newPhotos);

      // Vérifier que les fichiers existent
      const missingFiles = newPhotos.filter(p => !fs.existsSync(p.path));
      if (missingFiles.length > 0) {
        console.error('❌ Fichiers manquants:', missingFiles);
        return res.status(400).json({
          error: 'Certaines photos sont introuvables sur le serveur',
          details: `${missingFiles.length} fichier(s) manquant(s)`
        });
      }

      // ✅ VRAIE FUSION PDF avec pdf-lib
      const generateMergedPDF = async (employee, newPhotos, dossierName) => {
        const { PDFDocument } = require('pdf-lib');
        
        console.log('🔄 Début VRAIE fusion PDF...');
        
        // ÉTAPE 1 : Créer un nouveau PDF avec les nouvelles photos
        const newPdfWithPhotos = await new Promise((resolve, reject) => {
          const doc = new PDFKitDocument({ size: 'A4', margin: 50 });
          const buffers = [];

          doc.on('data', chunk => buffers.push(chunk));
          doc.on('error', reject);
          doc.on('end', () => resolve(Buffer.concat(buffers)));

          // Page de garde
          doc.fontSize(24).text('DOSSIER RH - MISE À JOUR', { align: 'left' });
          doc.moveDown(2);
          doc.fontSize(16).text(`Employé : ${employee.prenom} ${employee.nom}`);
          doc.moveDown(0.5);
          doc.fontSize(14).text(`Matricule : ${employee.matricule || '-'}`);
          doc.moveDown(0.5);
          doc.fontSize(14).text(`Poste : ${employee.poste || '-'}`);
          doc.moveDown(0.5);
          doc.fontSize(14).text(`Nom du dossier : ${dossierName || '-'}`);
          doc.moveDown(0.5);
          doc.fontSize(12).text(`Date de mise à jour : ${new Date().toLocaleDateString('fr-FR')}`);
          doc.addPage();

          // Ajouter les nouvelles photos
          newPhotos.forEach((photo, index) => {
            try {
              if (!photo.path || !fs.existsSync(photo.path)) {
                console.warn('⚠️ Photo introuvable:', photo.path);
                return;
              }

              if (index > 0) doc.addPage();

              const pageWidth = doc.page.width;
              const pageHeight = doc.page.height;
              const maxWidth = pageWidth - 100;
              const maxHeight = pageHeight - 150;

              doc.fontSize(12).text(`Photo : ${photo.originalname || photo.filename}`, 50, 50);
              doc.image(photo.path, {
                fit: [maxWidth, maxHeight],
                align: 'center',
                valign: 'center',
                x: 50,
                y: 100
              });

              console.log('📄 Nouvelle photo ajoutée:', photo.path);
            } catch (imageError) {
              console.error(`❌ Erreur photo ${photo.filename}:`, imageError.message);
            }
          });

          doc.end();
        });

        console.log('✅ PDF des nouvelles photos créé');

        // ÉTAPE 2 : Charger l'ancien PDF s'il existe
        let oldPdfPath = null;
        if (employee.dossier_rh) {
          const urlParts = employee.dossier_rh.split('/');
          const oldPdfFilename = urlParts[urlParts.length - 1];
          oldPdfPath = path.join(pdfStorageDir, oldPdfFilename);
          
          if (!fs.existsSync(oldPdfPath)) {
            console.warn('⚠️ Ancien PDF introuvable, création d\'un nouveau dossier');
            oldPdfPath = null;
          } else {
            console.log('✅ Ancien PDF trouvé:', oldPdfPath);
          }
        }

        // ÉTAPE 3 : Fusionner les PDF avec pdf-lib
        const mergedPdfDoc = await PDFDocument.create();

        // Si ancien PDF existe, copier toutes ses pages en premier
        if (oldPdfPath) {
          console.log('📄 Copie des anciennes pages...');
          const oldPdfBytes = fs.readFileSync(oldPdfPath);
          const oldPdfDoc = await PDFDocument.load(oldPdfBytes);
          const oldPages = await mergedPdfDoc.copyPages(oldPdfDoc, oldPdfDoc.getPageIndices());
          
          oldPages.forEach(page => {
            mergedPdfDoc.addPage(page);
          });
          
          console.log(`✅ ${oldPages.length} anciennes pages copiées`);
        }

        // Copier les nouvelles pages
        console.log('📄 Copie des nouvelles pages...');
        const newPdfDoc = await PDFDocument.load(newPdfWithPhotos);
        const newPages = await mergedPdfDoc.copyPages(newPdfDoc, newPdfDoc.getPageIndices());
        
        newPages.forEach(page => {
          mergedPdfDoc.addPage(page);
        });
        
        console.log(`✅ ${newPages.length} nouvelles pages copiées`);

        // ÉTAPE 4 : Sauvegarder le PDF fusionné
        const mergedPdfBytes = await mergedPdfDoc.save();
        const fileName = `dossier-${employee.matricule || 'EMP'}-${Date.now()}.pdf`;
        const filePath = path.join(pdfStorageDir, fileName);
        
        fs.writeFileSync(filePath, mergedPdfBytes);
        
        const baseUrl = process.env.BACKEND_URL || 'https://your-app.azurewebsites.net';
        const pdfUrl = `${baseUrl}/api/pdfs/${fileName}`;
        
        console.log('✅ PDF fusionné sauvegardé:', pdfUrl);
        console.log(`📊 Total pages dans le PDF final: ${mergedPdfDoc.getPageCount()}`);
        
        return { pdfUrl, oldPdfPath };
      };

      const { pdfUrl, oldPdfPath } = await generateMergedPDF(employee, newPhotos, dossierName);

      // Supprimer l'ancien PDF SEULEMENT après succès de la fusion
      if (oldPdfPath && fs.existsSync(oldPdfPath)) {
        try {
          fs.unlinkSync(oldPdfPath);
          console.log('🧹 Ancien PDF supprimé après fusion:', oldPdfPath);
        } catch (deleteError) {
          console.warn('⚠️ Impossible de supprimer l\'ancien PDF:', deleteError.message);
        }
      }

      const updateResult = await pool.query(
        'UPDATE employees SET dossier_rh = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
        [pdfUrl, employeeId]
      );

      // Nettoyer les fichiers temporaires
      newPhotos.forEach(photo => {
        try {
          if (photo.path && fs.existsSync(photo.path)) {
            fs.unlinkSync(photo.path);
            console.log('🧹 Fichier temporaire supprimé:', photo.path);
          }
        } catch (cleanupErr) {
          console.warn('⚠️ Erreur suppression fichier temporaire:', photo.path);
        }
      });

      res.json({
        success: true,
        message: 'Dossier RH fusionné avec succès',
        pdfUrl: pdfUrl,
        employee: updateResult.rows[0]
      });
    } catch (error) {
      console.error('❌ Erreur fusion PDF:', {
        message: error.message,
        stack: error.stack
      });
      res.status(500).json({
        error: 'Erreur lors de la fusion du PDF',
        details: error.message
      });
    }
  }
);


// Générer le PDF et le stocker localement
app.post(
  '/api/dossier-rh/generate-pdf/:employeeId',
  authenticateToken,
  async (req, res) => {
    try {
      const { employeeId } = req.params;
      const { photos: clientPhotos, dossierName } = req.body;

      console.log('📄 Génération PDF pour employé:', employeeId, 'dossier:', dossierName);

      if (!dossierName || !dossierName.trim()) {
        return res.status(400).json({ error: 'Nom de dossier manquant' });
      }

      if (!Array.isArray(clientPhotos) || clientPhotos.length === 0) {
        return res.status(400).json({ error: 'Aucune photo fournie pour le dossier' });
      }

      const employeeResult = await pool.query('SELECT * FROM employees WHERE id = $1', [
        employeeId
      ]);

      if (employeeResult.rows.length === 0) {
        return res.status(404).json({ error: 'Employé non trouvé' });
      }

      const employee = employeeResult.rows[0];

      // Construire les chemins complets des photos
      const photos = clientPhotos.map(p => ({
        ...p,
        path: path.join(uploadTempDir, p.filename)
      }));

      console.log('📂 Chemins photos construits:', photos);

      // Vérifier que les fichiers existent
      const missingFiles = photos.filter(p => !fs.existsSync(p.path));
      if (missingFiles.length > 0) {
        console.error('❌ Fichiers manquants:', missingFiles);
        return res.status(400).json({
          error: 'Certaines photos sont introuvables sur le serveur',
          details: `${missingFiles.length} fichier(s) manquant(s)`
        });
      }

      // Fonction pour générer et sauvegarder le PDF
      const generateAndSavePDF = (employee, photos, dossierName) => {
        return new Promise((resolve, reject) => {
          try {
            console.log('🧾 Début génération PDF avec pdfkit...');
            const doc = new PDFKitDocument({ size: 'A4', margin: 50 });
            const buffers = [];

            doc.on('data', chunk => buffers.push(chunk));
            doc.on('error', err => {
              console.error('❌ Erreur PDFKit:', err);
              reject(err);
            });

            doc.on('end', async () => {
              try {
                const pdfBuffer = Buffer.concat(buffers);
                const fileName = `dossier-${employee.matricule || 'EMP'}-${Date.now()}.pdf`;
                console.log('💾 Sauvegarde locale du fichier:', fileName);
                
                const filePath = path.join(pdfStorageDir, fileName);
                fs.writeFileSync(filePath, pdfBuffer);
                
                const baseUrl = process.env.BACKEND_URL || 'https://your-app.azurewebsites.net';
                const pdfUrl = `${baseUrl}/api/pdfs/${fileName}`;
                
                console.log('✅ PDF sauvegardé localement:', pdfUrl);
                resolve(pdfUrl);
              } catch (saveError) {
                console.error('❌ Erreur sauvegarde locale:', saveError);
                reject(saveError);
              }
            });

            // Contenu du PDF
            doc.fontSize(24).text('DOSSIER RH', { align: 'left' });
            doc.moveDown(2);

            doc.fontSize(16).text(`Employé : ${employee.prenom} ${employee.nom}`);
            doc.moveDown(0.5);
            doc.fontSize(14).text(`Matricule : ${employee.matricule || '-'}`);
            doc.moveDown(0.5);
            doc.fontSize(14).text(`Poste : ${employee.poste || '-'}`);
            doc.moveDown(0.5);
            doc.fontSize(14).text(`Département / Site : ${employee.site_dep || '-'}`);
            doc.moveDown(0.5);
            doc.fontSize(14).text(`Nom du dossier : ${dossierName || '-'}`);
            doc.moveDown(0.5);
            doc
              .fontSize(12)
              .text(`Date de génération : ${new Date().toLocaleDateString('fr-FR')}`);
            doc.addPage();

            // Pages des photos
            if (Array.isArray(photos)) {
              photos.forEach((photo, index) => {
                try {
                  if (!photo.path || !fs.existsSync(photo.path)) {
                    console.warn('⚠️ Photo introuvable:', photo.path);
                    return;
                  }

                  if (index > 0) {
                    doc.addPage();
                  }

                  const pageWidth = doc.page.width;
                  const pageHeight = doc.page.height;
                  const maxWidth = pageWidth - 100;
                  const maxHeight = pageHeight - 150;

                  doc
                    .fontSize(12)
                    .text(`Photo : ${photo.originalname || photo.filename}`, 50, 50);

                  doc.image(photo.path, {
                    fit: [maxWidth, maxHeight],
                    align: 'center',
                    valign: 'center',
                    x: 50,
                    y: 100
                  });

                  console.log('📄 Photo ajoutée au PDF:', photo.path);
                } catch (imageError) {
                  console.error(
                    `❌ Erreur avec la photo ${photo.filename}:`,
                    imageError.message
                  );
                }
              });
            }

            doc.end();
          } catch (error) {
            console.error('❌ Erreur générale generateAndSavePDF:', error);
            reject(error);
          }
        });
      };

      const pdfUrl = await generateAndSavePDF(employee, photos, dossierName);

      const updateResult = await pool.query(
        'UPDATE employees SET dossier_rh = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
        [pdfUrl, employeeId]
      );

      // Nettoyer les fichiers temporaires
      photos.forEach(photo => {
        try {
          if (photo.path && fs.existsSync(photo.path)) {
            fs.unlinkSync(photo.path);
            console.log('🧹 Fichier temporaire supprimé:', photo.path);
          }
        } catch (cleanupErr) {
          console.warn(
            '⚠️ Erreur suppression fichier temporaire:',
            photo.path,
            cleanupErr.message
          );
        }
      });

      res.json({
        success: true,
        message: 'Dossier RH généré avec succès',
        pdfUrl: pdfUrl,
        employee: updateResult.rows[0]
      });
    } catch (error) {
      console.error('❌ Erreur génération PDF (route):', {
        message: error.message,
        stack: error.stack
      });
      res.status(500).json({
        error: 'Erreur lors de la génération du PDF',
        details: error.message
      });
    }
  }
);

// Route pour servir les PDF
app.get('/api/pdfs/:filename', (req, res) => {
  try {
    const filename = req.params.filename;
    const filePath = path.join(pdfStorageDir, filename);
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'PDF non trouvé' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.sendFile(filePath);
    
  } catch (error) {
    console.error('❌ Erreur service PDF:', error);
    res.status(500).json({ error: 'Erreur lors du chargement du PDF' });
  }
});
// =========================
// Routes Fiche de Paie
// =========================

const { PDFDocument } = require('pdf-lib');
const pdfParse = require('pdf-parse');

// Fonction pour extraire le matricule d'une page PDF
function extraireMatricule(texte) {
  console.log('🔍 Texte complet pour extraction (500 caractères):', texte.substring(0, 500));
  
  const patterns = [
    /MATE\.\s*(\d{1,3})/i,
    /MATR\.\s*(\d{1,3})/i,
    /MATE\s+(\d{1,3})/i,
    /MATR\s+(\d{1,3})/i,
    /\|\s*(\d{1,3})\s*\|\s*[A-Z]/i,
    /MATRICULE[\s:]*(\d{1,3})/i
  ];

  for (const pattern of patterns) {
    const match = texte.match(pattern);
    if (match && match[1]) {
      const matricule = match[1].trim();
      console.log(`✅ Matricule trouvé avec pattern ${pattern}: ${matricule}`);
      return matricule;
    }
  }
  
  const lines = texte.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    if (line.includes('MATE') || line.includes('MATR')) {
      const nextLine = i + 1 < lines.length ? lines[i + 1] : '';
      const numbers = nextLine.match(/\b(\d{1,3})\b/g);
      
      if (numbers && numbers.length > 0) {
        console.log(`✅ Matricule trouvé dans ligne suivante: ${numbers[0]}`);
        return numbers[0];
      }
    }
  }
  
  console.log('⚠️ Aucun matricule trouvé dans le texte');
  return null;
}

// Fonction pour envoyer la fiche de paie par email
async function envoyerFichePaieParEmail(employe, pdfPath, fileName) {
  const moisActuel = new Date().toLocaleDateString('fr-FR', { 
    month: 'long', 
    year: 'numeric' 
  });

  const mailOptions = {
    from: {
      name: 'Administration SAHEL',
      address: 'morgan.martin@example.com'
    },
    to: employe.adresse_mail,
    subject: `Votre fiche de paie - ${moisActuel}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2563eb; border-bottom: 2px solid #2563eb; padding-bottom: 10px;">
          📄 Votre fiche de paie
        </h2>
        <div style="background: #f8fafc; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <p><strong>Bonjour ${employe.prenom} ${employe.nom},</strong></p>
          <p>Veuillez trouver ci-joint votre fiche de paie pour le mois de <strong>${moisActuel}</strong>.</p>
          <p><strong>Matricule :</strong> ${employe.matricule}</p>
          <p><strong>Poste :</strong> ${employe.poste || 'N/A'}</p>
        </div>
        <p style="color: #6b7280; font-size: 14px;">
          Ce document est confidentiel et personnel. Merci de le conserver précieusement.
        </p>
        <p style="color: #6b7280; font-size: 12px; margin-top: 30px; text-align: center;">
          Ceci est un message automatique, merci de ne pas y répondre.
        </p>
      </div>
    `,
    attachments: [
      {
        filename: fileName,
        path: pdfPath,
        contentType: 'application/pdf'
      }
    ]
  };

  try {
    await emailTransporter.sendMail(mailOptions);
    console.log(`📧 Email envoyé à ${employe.adresse_mail}`);
  } catch (error) {
    console.error('❌ Erreur envoi email:', error);
    throw new Error(`Impossible d'envoyer l'email à ${employe.adresse_mail}: ${error.message}`);
  }
}

// Fonction pour envoyer la fiche de paie au manager
async function envoyerFichePaieAuManager(employe, pdfPath, fileName) {
  const moisActuel = new Date().toLocaleDateString('fr-FR', {
    month: 'long',
    year: 'numeric'
  });

  const nomComplet = `${employe.nom} ${employe.prenom}`;

  const mailOptions = {
    from: {
      name: 'Administration SAHEL',
      address: 'morgan.martin@example.com'
    },
    to: 'jamie.lambert@example.com',
    subject: `Fiche de paie de ${nomComplet} - ${moisActuel}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2563eb; border-bottom: 2px solid #2563eb; padding-bottom: 10px;">
          📄 Fiche de paie - Remise au manager
        </h2>
        <div style="background: #fff7ed; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #f97316;">
          <p><strong>Bonjour Jamie,</strong></p>
          <p>L'employé(e) <strong>${nomComplet}</strong> ne dispose pas d'adresse email enregistrée dans le système.</p>
          <p>Veuillez trouver ci-joint sa fiche de paie pour le mois de <strong>${moisActuel}</strong> afin de la lui remettre manuellement.</p>
          <p><strong>Matricule :</strong> ${employe.matricule}</p>
          <p><strong>Poste :</strong> ${employe.poste || 'N/A'}</p>
        </div>
        <p style="color: #6b7280; font-size: 14px;">
          Ce document est confidentiel. Merci de le remettre en main propre à l'employé(e) concerné(e).
        </p>
        <p style="color: #6b7280; font-size: 12px; margin-top: 30px; text-align: center;">
          Ceci est un message automatique, merci de ne pas y répondre.
        </p>
      </div>
    `,
    attachments: [
      {
        filename: fileName,
        path: pdfPath,
        contentType: 'application/pdf'
      }
    ]
  };

  try {
    await emailTransporter.sendMail(mailOptions);
    console.log(`📧 Fiche de ${nomComplet} envoyée au manager jamie.lambert@example.com`);
  } catch (error) {
    console.error('❌ Erreur envoi email manager:', error);
    throw new Error(`Impossible d'envoyer l'email au manager: ${error.message}`);
  }
}

// Route principale pour traiter les fiches de paie
app.post(
  '/api/fiche-paie/process',
  authenticateToken,
  requireTunisiaTenant,
  uploadPaie.single('pdfFile'),
  async (req, res) => {
    console.log('📄 Traitement des fiches de paie...');
    
    if (!req.file) {
      return res.status(400).json({ error: 'Aucun fichier PDF uploadé' });
    }

    const pdfPath = req.file.path;

    // Employees without email — payslip sent to manager instead
    const employeesSansEmail = ['Robin Brun', 'Elliot Costa'];

    const results = {
      total: 0,
      success: 0,
      errors: []
    };

    try {
      const pdfBytes = fs.readFileSync(pdfPath);
      const pdfDoc = await PDFDocument.load(pdfBytes);
      const totalPages = pdfDoc.getPageCount();
      
      console.log(`📑 PDF chargé: ${totalPages} page(s)`);
      results.total = totalPages;

      for (let i = 0; i < totalPages; i++) {
        try {
          console.log(`\n🔍 Traitement page ${i + 1}/${totalPages}`);
          
          const singlePagePdf = await PDFDocument.create();
          const [copiedPage] = await singlePagePdf.copyPages(pdfDoc, [i]);
          singlePagePdf.addPage(copiedPage);
          
          const singlePageBytes = await singlePagePdf.save();
          const tempPath = path.join(uploadPaieDir, `temp-page-${i}.pdf`);
          fs.writeFileSync(tempPath, singlePageBytes);
          
          const dataBuffer = fs.readFileSync(tempPath);
          const pdfData = await pdfParse(dataBuffer);
          const texte = pdfData.text;
          
          console.log('📝 Extrait de texte (200 premiers caractères):', texte.substring(0, 200));
          
          const matricule = extraireMatricule(texte);
          
          if (!matricule) {
            console.warn(`⚠️ Page ${i + 1}: Matricule non trouvé`);
            results.errors.push({
              page: i + 1,
              error: 'Matricule non trouvé dans la page'
            });
            fs.unlinkSync(tempPath);
            continue;
          }
          
          console.log(`✅ Matricule trouvé: ${matricule}`);
          
          const employeResult = await pool.query(
            'SELECT * FROM employees WHERE matricule = $1',
            [matricule]
          );
          
          if (employeResult.rows.length === 0) {
            console.warn(`⚠️ Page ${i + 1}: Employé avec matricule ${matricule} non trouvé`);
            results.errors.push({
              page: i + 1,
              matricule: matricule,
              error: 'Employé non trouvé dans la base de données'
            });
            fs.unlinkSync(tempPath);
            continue;
          }
          
          const employe = employeResult.rows[0];
          const nomComplet = `${employe.nom} ${employe.prenom}`;
          const nomCompletInverse = `${employe.prenom} ${employe.nom}`;

          if (!employe.adresse_mail) {
            console.warn(`⚠️ Page ${i + 1}: Employé ${nomComplet} sans email`);

            const estConcerne = employeesSansEmail.some(name =>
              nomComplet.toLowerCase().includes(name.toLowerCase()) ||
              nomCompletInverse.toLowerCase().includes(name.toLowerCase())
            );

            if (estConcerne) {
              const fileName = `fiche-paie-${matricule}-${Date.now()}.pdf`;
              const finalPath = path.join(uploadPaieDir, fileName);
              fs.renameSync(tempPath, finalPath);

              await envoyerFichePaieAuManager(employe, finalPath, fileName);

              console.log(`✅ Page ${i + 1}: Fiche de ${nomComplet} envoyée au manager`);
              results.success++;

              setTimeout(() => {
                if (fs.existsSync(finalPath)) {
                  fs.unlinkSync(finalPath);
                  console.log(`🧹 Fichier nettoyé: ${fileName}`);
                }
              }, 60000);

            } else {
              results.errors.push({
                page: i + 1,
                matricule: matricule,
                employe: nomComplet,
                error: 'Adresse email manquante'
              });
              fs.unlinkSync(tempPath);
            }

            continue;
          }
          
          const fileName = `fiche-paie-${matricule}-${Date.now()}.pdf`;
          const finalPath = path.join(uploadPaieDir, fileName);
          
          fs.renameSync(tempPath, finalPath);
          
          await envoyerFichePaieParEmail(employe, finalPath, fileName);
          
          console.log(`✅ Page ${i + 1}: Fiche de paie envoyée à ${employe.adresse_mail}`);
          results.success++;
          
          setTimeout(() => {
            if (fs.existsSync(finalPath)) {
              fs.unlinkSync(finalPath);
              console.log(`🧹 Fichier nettoyé: ${fileName}`);
            }
          }, 60000);
          
        } catch (pageError) {
          console.error(`❌ Erreur page ${i + 1}:`, pageError);
          results.errors.push({
            page: i + 1,
            error: pageError.message
          });
        }
      }

      if (fs.existsSync(pdfPath)) {
        fs.unlinkSync(pdfPath);
        console.log('🧹 Fichier principal nettoyé');
      }
      
      console.log('\n📊 Résultats finaux:', results);
      
      res.json({
        success: true,
        message: `Traitement terminé: ${results.success}/${results.total} fiches envoyées`,
        results: results
      });
      
    } catch (error) {
      console.error('❌ Erreur traitement PDF:', error);
      
      if (fs.existsSync(pdfPath)) {
        fs.unlinkSync(pdfPath);
      }
      
      res.status(500).json({
        error: 'Erreur lors du traitement du PDF',
        details: error.message,
        results: results
      });
    }
  }
);

// =========================
// ROUTES RH
// =========================

// Route racine
app.get('/', (req, res) => {
  res.json({
    message: '🚀 API RH Manager - Connecté à Azure PostgreSQL',
    timestamp: new Date().toISOString(),
    database: 'Azure PostgreSQL',
    environment: process.env.NODE_ENV || 'development',
    endpoints: [
      'GET  /api/health',
      'POST /api/auth/login',
      'POST /api/auth/send-new-password',
      'GET  /api/employees',
      'GET  /api/employees/archives',
      'GET  /api/employees/search?q=nom',
      'PUT  /api/employees/:id',
      'PUT  /api/employees/:id/archive',
      'POST /api/employees',
      'POST /api/employees/upload-photo',
      'GET  /api/employee-photos/:filename',
      'POST /api/archive/upload-pdf',
      'GET  /api/archive-pdfs/:filename',
      'GET  /api/demandes',
      'GET  /api/demandes/:id',
      'POST /api/demandes',
      'PUT  /api/demandes/:id',
      'PUT  /api/demandes/:id/statut',
      'DELETE /api/demandes/:id',
      'POST /api/dossier-rh/upload-photos',
      'POST /api/dossier-rh/generate-pdf/:employeeId',
      'GET  /api/pdfs/:filename',
      'POST /api/fiche-paie/process'
    ]
  });
});

// Health check
app.get('/api/health', async (req, res) => {
  try {
    console.log('🏥 Health check - Tentative de connexion à la base...');

    const client = await pool.connect();
    console.log('✅ Client connecté');

    const result = await client.query('SELECT version(), current_database()');
    client.release();

    console.log('✅ Requête exécutée avec succès');

    res.json({
      status: 'OK ✅',
      message: 'Backend RH opérationnel',
      database: {
        connected: true,
        version: result.rows[0].version,
        name: result.rows[0].current_database,
        host: process.env.DB_HOST,
        port: process.env.DB_PORT
      },
      jwt: process.env.JWT_SECRET ? 'Configuré' : 'Utilisation fallback',
      environment: process.env.NODE_ENV || 'development',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Health check échoué:', {
      message: error.message,
      code: error.code,
      stack: error.stack
    });

    res.status(500).json({
      status: 'Error',
      message: 'Erreur base de données',
      error: error.message,
      code: error.code,
      details: {
        host: process.env.DB_HOST,
        port: process.env.DB_PORT,
        database: process.env.DB_NAME
      }
    });
  }
});

// =========================
// Authentification
// =========================

app.post('/api/auth/login', async (req, res) => {
  try {
    console.log('🔐 Tentative de login:', { email: req.body.email });

    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email et mot de passe requis'
      });
    }

    const client = await pool.connect();
    console.log('✅ Connexion pool établie pour login');

    try {
      const userResult = await client.query(
        'SELECT * FROM users WHERE email = $1',
        [email]
      );

      if (userResult.rows.length === 0) {
        console.log('❌ Utilisateur non trouvé:', email);
        return res.status(401).json({
          success: false,
          message: 'Email ou mot de passe incorrect'
        });
      }

      const user = userResult.rows[0];
      console.log('👤 Utilisateur trouvé:', user.email);

      const isPasswordValid = await bcrypt.compare(password, user.password);
      const tenantSchema = getSchemaForUser(user);
      const countryKey = inferCountryKey(user);

      if (isPasswordValid) {
        console.log('✅ Mot de passe correct');

        const token = jwt.sign(
          {
            userId: user.id,
            email: user.email,
            role: user.role || 'user',
            tenant_id: user.tenant_id || null,
            plant: user.plant || null,
            country: countryKey,
            tenant_schema: tenantSchema,
            name: user.name || null
          },
          JWT_SECRET,
          { expiresIn: '24h' }
        );

        res.json({
          success: true,
          token: token,
          user: {
            id: user.id,
            email: user.email,
            role: user.role || 'user',
            tenant_id: user.tenant_id || null,
            plant: user.plant || null,
            country: countryKey,
            tenant_schema: tenantSchema,
            name: user.name || null
          }
        });
      } else {
        console.log('❌ Mot de passe incorrect');
        res.status(401).json({
          success: false,
          message: 'Email ou mot de passe incorrect'
        });
      }
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('💥 Erreur lors du login:', {
      message: error.message,
      code: error.code,
      stack: error.stack
    });

    res.status(500).json({
      success: false,
      message: 'Erreur serveur lors de la connexion',
      error: error.message
    });
  }
});

// =========================
// Routes Employés
// =========================

// =========================
// ROUTE POUR SUPPRIMER LE DOSSIER RH
// =========================
app.delete('/api/employees/:id/dossier-rh', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const schema = await resolveEmployeeSchemaById(req.user, id, req.query.tenant_schema || req.body?.tenant_schema);
    
    console.log('🗑️ Suppression dossier RH pour employé ID:', id, {
      tenant_schema: schema
    });

    if (!schema) {
      return res.status(404).json({
        success: false,
        error: 'Employé non trouvé'
      });
    }

    // Récupérer l'employé pour avoir l'URL du dossier RH
    const employeeResult = await pool.query(
      `SELECT id, nom, prenom, matricule, dossier_rh FROM ${schema}.employees WHERE id = $1`,
      [id]
    );

    if (employeeResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Employé non trouvé'
      });
    }

    const employee = employeeResult.rows[0];
    
    if (!employee.dossier_rh) {
      return res.status(400).json({
        success: false,
        error: 'Aucun dossier RH à supprimer'
      });
    }

    // Extraire le nom du fichier PDF de l'URL
    let pdfFilename = null;
    try {
      if (employee.dossier_rh) {
        const urlParts = employee.dossier_rh.split('/');
        pdfFilename = urlParts[urlParts.length - 1];
        
        if (pdfFilename) {
          const pdfPath = path.join(pdfStorageDir, pdfFilename);
          
          // Supprimer le fichier PDF du système de fichiers
          if (fs.existsSync(pdfPath)) {
            fs.unlinkSync(pdfPath);
            console.log('✅ Fichier PDF supprimé:', pdfFilename);
          } else {
            console.warn('⚠️ Fichier PDF non trouvé sur le serveur:', pdfPath);
          }
        }
      }
    } catch (fileError) {
      console.warn('⚠️ Erreur lors de la suppression du fichier PDF:', fileError.message);
      // On continue quand même car le fichier pourrait ne pas exister ou être ailleurs
    }

    // Mettre à jour la base de données pour supprimer le lien
    const updateResult = await pool.query(
      `UPDATE ${schema}.employees SET dossier_rh = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *`,
      [id]
    );

    console.log('✅ Dossier RH supprimé pour:', `${employee.prenom} ${employee.nom}`);

    res.json({
      success: true,
      message: 'Dossier RH supprimé avec succès',
      employee: updateResult.rows[0],
      deletedFile: pdfFilename
    });

  } catch (error) {
    console.error('❌ Erreur suppression dossier RH:', error);
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        error: error.message,
        code: error.code,
        matches: error.matches || undefined
      });
    }
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la suppression du dossier RH',
      details: error.message
    });
  }
});



app.get('/api/employees', authenticateToken, rejectStalePaieUnlock, async (req, res) => {
  try {
    console.log('👥 Récupération des employés actifs');

    const schemas = getAccessibleEmployeeSchemas(req.user);
    const results = await Promise.all(
      schemas.map(async (schema) => {
        const result = await pool.query(`
          SELECT e.*, eg.gender AS gender, '${schema}' AS tenant_schema
          FROM ${schema}.employees e
          LEFT JOIN ${schema}.employee_gender eg ON eg.employee_id = e.id
          WHERE e.statut = 'actif' OR e.statut IS NULL
          ORDER BY e.nom, e.prenom
        `);
        return result.rows;
      })
    );

    const employees = maskTunisiaSalaryFieldsList(filterEmployeesBySiteScope(req.user, results.flat()), req.user, salaryCrypto.getUnlockKey(req.headers['x-paie-unlock-token']));
    console.log(`✅ ${employees.length} employés actifs récupérés`);
    res.json(employees);
  } catch (error) {
    console.error('❌ Erreur récupération employés:', error);
    res.status(500).json({
      error: 'Erreur lors de la récupération des employés',
      message: error.message
    });
  }
});

app.get('/api/employees/archives', authenticateToken, rejectStalePaieUnlock, async (req, res) => {
  try {
    console.log('📁 Récupération des employés archivés');

    const schemas = getAccessibleEmployeeSchemas(req.user);
    const results = await Promise.all(
      schemas.map(async (schema) => {
        const result = await pool.query(`
          SELECT e.*, '${schema}' AS tenant_schema
          FROM ${schema}.employees e
          WHERE e.statut = 'archive'
          ORDER BY e.date_depart DESC, e.nom, e.prenom
        `);
        return result.rows;
      })
    );

    const employees = maskTunisiaSalaryFieldsList(filterEmployeesBySiteScope(req.user, results.flat()), req.user, salaryCrypto.getUnlockKey(req.headers['x-paie-unlock-token']));
    console.log(`✅ ${employees.length} employés archivés récupérés`);
    res.json(employees);
  } catch (error) {
    console.error('❌ Erreur récupération archives:', error);
    res.status(500).json({
      error: 'Erreur lors de la récupération des archives',
      message: error.message
    });
  }
});

app.get('/api/leave-balances', authenticateToken, requireTunisiaTenant, async (req, res) => {
  try {
    console.log('🗓️ Récupération des soldes de congé');

    // Every tenant the caller can see, each from its own schema.
    const schemas = getAccessibleEmployeeSchemas(req.user);
    const perSchema = await Promise.all(schemas.map((schema) => pool.query(`
      SELECT
        e.id AS employee_id,
        e.matricule,
        e.prenom,
        e.nom,
        e.poste,
        e.site_dep,
        lb.balance,
        lb.updated_at,
        '${schema}' AS tenant_schema
      FROM ${schema}.employees e
      LEFT JOIN ${schema}.leave_balances lb ON lb.employee_id = e.id
      WHERE e.statut = 'actif' OR e.statut IS NULL
    `)));
    const rows = filterEmployeesBySiteScope(req.user, perSchema.flatMap((r) => r.rows))
      .sort((a, b) => (a.nom || '').localeCompare(b.nom || '') || (a.prenom || '').localeCompare(b.prenom || ''));

    console.log(`✅ ${rows.length} solde(s) de congé récupéré(s)`);
    res.json(rows);
  } catch (error) {
    console.error('❌ Erreur récupération soldes de congé:', error);
    res.status(500).json({
      error: 'Erreur lors de la récupération des soldes de congé',
      message: error.message
    });
  }
});

app.get('/api/employees/search', authenticateToken, rejectStalePaieUnlock, async (req, res) => {
  try {
    const { q, statut = 'actif' } = req.query;
    console.log('🔍 Recherche employés:', { q, statut });
    const schemas = getAccessibleEmployeeSchemas(req.user);
    const results = await Promise.all(
      schemas.map(async (schema) => {
        let query = `SELECT e.*, '${schema}' AS tenant_schema FROM ${schema}.employees e WHERE `;
        const params = [];

        if (statut === 'archive') {
          query += 'e.statut = $1';
          params.push('archive');
        } else {
          query += '(e.statut = $1 OR e.statut IS NULL)';
          params.push('actif');
        }

        if (q) {
          query += " AND (e.nom ILIKE $2 OR e.prenom ILIKE $2 OR e.poste ILIKE $2 OR e.matricule ILIKE $2 OR e.adresse_mail ILIKE $2 OR (e.prenom || ' ' || e.nom) ILIKE $2 OR (e.nom || ' ' || e.prenom) ILIKE $2)";
          params.push(`%${q}%`);
        }

        query += ' ORDER BY e.nom, e.prenom';
        const result = await pool.query(query, params);
        return result.rows;
      })
    );

    const employees = maskTunisiaSalaryFieldsList(filterEmployeesBySiteScope(req.user, results.flat()), req.user, salaryCrypto.getUnlockKey(req.headers['x-paie-unlock-token']));
    console.log(`✅ ${employees.length} employés trouvés`);
    res.json(employees);
  } catch (error) {
    console.error('❌ Erreur recherche employés:', error);
    res.status(500).json({
      error: 'Erreur lors de la recherche',
      message: error.message
    });
  }
});

// Emergency contacts for the Team page Excel template (non-Tunisia tenants).
app.get('/api/employees/emergency-contacts', authenticateToken, async (req, res) => {
  try {
    const schemas = getAccessibleEmployeeSchemas(req.user);
    const results = await Promise.all(schemas.map((schema) => {
      const scope = siteScopeSql(req.user, 'se', 1);
      const siteFilter = scope.sql
        ? ` WHERE employee_id IN (SELECT se.id FROM ${schema}.employees se WHERE 1=1${scope.sql})`
        : '';
      return pool.query(
        `SELECT '${schema}' AS tenant_schema, employee_id, nom, prenom, relation, telephone, email
         FROM ${schema}.emergency_contacts${siteFilter}`,
        scope.params
      ).then((r) => r.rows).catch(() => []);
    }));
    res.json(results.flat());
  } catch (error) {
    res.status(500).json({ error: error.message });

app.get('/api/employees/:id', authenticateToken, rejectStalePaieUnlock, async (req, res) => {
  try {
    const { id } = req.params;
    console.log('👤 Récupération employé ID:', id);
    const requestedSchema = req.query.tenant_schema;

    if (requestedSchema) {
      if (isGroupRole(req.user?.role)) {
        const allowedSchemas = getAccessibleEmployeeSchemas(req.user);
        if (!allowedSchemas.includes(requestedSchema)) {
          return res.status(403).json({ error: 'tenant_schema non autorisé' });
        }
      }
      const schema = resolveEmployeeSchemaForRequest(req.user, requestedSchema);
      const result = await pool.query(`SELECT e.*, '${schema}' AS tenant_schema FROM ${schema}.employees e WHERE e.id = $1`, [id]);
      if (result.rows.length === 0 || !isEmployeeInSiteScope(req.user, result.rows[0])) {
        return res.status(404).json({ error: 'Employé non trouvé' });
      }
      return res.json(maskTunisiaSalaryFields(result.rows[0], req.user, salaryCrypto.getUnlockKey(req.headers['x-paie-unlock-token'])));
    }

    const schemas = getAccessibleEmployeeSchemas(req.user);
    const results = await Promise.all(
      schemas.map(async (schema) => {
        const result = await pool.query(`SELECT e.*, '${schema}' AS tenant_schema FROM ${schema}.employees e WHERE e.id = $1`, [id]);
        return result.rows;
      })
    );

    const matches = filterEmployeesBySiteScope(req.user, results.flat());
    if (matches.length === 0) {
      return res.status(404).json({ error: 'Employé non trouvé' });
    }
    if (matches.length > 1) {
      return res.status(409).json({
        error: 'Employé ambigu entre plusieurs pays',
        message: 'Veuillez préciser tenant_schema'
      });
    }

    res.json(maskTunisiaSalaryFields(matches[0], req.user, salaryCrypto.getUnlockKey(req.headers['x-paie-unlock-token'])));
  } catch (error) {
    console.error('❌ Erreur récupération employé:', error);
    res.status(500).json({
      error: "Erreur lors de la récupération de l'employé",
      message: error.message
    });
  }
});

// Bulk "complete employee data" import from the Team page Excel template.
// Group HR + non-Tunisia tenants only: Tunisia (public schema) keeps its own
// edit flow (encrypted payroll fields, CIN, etc.) and is rejected here.
// Only non-empty cells are written, so HR can fill gaps without wiping data.
const BULK_COMPLETE_FIELDS = [
  'matricule', 'nom', 'prenom', 'passeport', 'date_emission_passport',
  'date_expiration_passport', 'date_naissance', 'poste', 'site_dep',
  'type_contrat', 'date_debut', 'date_fin_contrat', 'salaire_brute',
  'adresse_mail', 'mail_responsable1', 'mail_responsable2', 'department'
];
const BULK_DATE_FIELDS = new Set([
  'date_emission_passport', 'date_expiration_passport', 'date_naissance',
  'date_debut', 'date_fin_contrat'
]);
const BULK_EMAIL_FIELDS = new Set(['adresse_mail', 'mail_responsable1', 'mail_responsable2']);
// Template column -> emergency_contacts column (one contact per employee).
const BULK_EMERGENCY_FIELDS = [
  ['nom', 'emergency_nom'],
  ['prenom', 'emergency_prenom'],
  ['relation', 'emergency_relation'],
  ['telephone', 'emergency_telephone'],
  ['email', 'emergency_email'],
];

  }
});

app.post('/api/employees/bulk-complete', authenticateToken, async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
  if (!rows || rows.length === 0) {
    return res.status(400).json({ success: false, error: 'Aucune ligne à importer' });
  }
  if (rows.length > 5000) {
    return res.status(400).json({ success: false, error: 'Maximum 5000 lignes par import' });
  }
  if (!isGroupRole(req.user?.role) && isTunisiaTenantUser(req.user)) {
    return res.status(403).json({ success: false, error: 'Import non disponible pour ce tenant' });
  }

  let updated = 0;
  let unchanged = 0;
  const errors = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || {};
    const line = row.__line || i + 2;
    try {
      const id = parseInt(row.id, 10);
      if (!id) throw new Error('ID manquant');

      const schema = await resolveEmployeeSchemaById(req.user, id, row.tenant_schema || undefined);
      if (!schema) throw new Error('Employé non trouvé');
      if (schema === 'public') throw new Error('Tunisie non concernée par cet import');

      const values = {};
      for (const field of BULK_COMPLETE_FIELDS) {
        let v = row[field];
        if (v === undefined || v === null) continue;
        v = String(v).trim();
        if (v === '') continue;
        if (BULK_DATE_FIELDS.has(field)) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || isNaN(new Date(v).getTime())) {
            throw new Error(`Date invalide pour ${field}: ${v} (format AAAA-MM-JJ)`);
          }
        }
        if (BULK_EMAIL_FIELDS.has(field) && !isValidEmail(v)) {
          throw new Error(`Email invalide pour ${field}: ${v}`);
        }
        if (field === 'department') v = normalizeDepartment(v);
        if (field === 'salaire_brute') {
          const n = Number(v.replace(/\s/g, '').replace(',', '.'));
          if (!Number.isFinite(n)) throw new Error(`Salaire invalide: ${v}`);
          v = n;
        }
        values[field] = v;
      }
      if (values.site_dep !== undefined && !isEmployeeInSiteScope(req.user, values)) {
        throw new Error(`Site non autorisé pour ce compte: ${values.site_dep}`);
      }

      const current = await pool.query(`SELECT * FROM ${schema}.employees WHERE id = $1`, [id]);
      if (current.rows.length === 0) throw new Error('Employé non trouvé');
      const cur = current.rows[0];

      // Keep only values that actually differ from what is stored.
      const normalize = (val) => {
        if (val === null || val === undefined) return '';
        if (val instanceof Date) {
          const d = new Date(val.getTime() - val.getTimezoneOffset() * 60000);
          return d.toISOString().split('T')[0];
        }
        return String(val).trim();
      };
      const changed = Object.keys(values).filter((f) => normalize(cur[f]) !== normalize(values[f]));

      const emergencyValues = {};
      for (const [column, field] of BULK_EMERGENCY_FIELDS) {
        const v = row[field] === undefined || row[field] === null ? '' : String(row[field]).trim();
        if (!v) continue;
        if (column === 'email' && !isValidEmail(v)) throw new Error(`Email invalide pour le contact d'urgence: ${v}`);
        emergencyValues[column] = v;
      }
      let emergencyMerged = null;
      if (Object.keys(emergencyValues).length) {
        const ecRow = await pool.query(`SELECT * FROM ${schema}.emergency_contacts WHERE employee_id = $1`, [id]);
        const ecCur = ecRow.rows[0] || {};
        if (Object.keys(emergencyValues).some((c) => normalize(ecCur[c]) !== normalize(emergencyValues[c]))) {
          emergencyMerged = { ...ecCur, ...emergencyValues };
          if (!emergencyMerged.nom || !emergencyMerged.prenom || !emergencyMerged.telephone) {
            throw new Error("Contact d'urgence : nom, prénom et téléphone sont obligatoires");
          }
        }
      }

      if (changed.length === 0 && !emergencyMerged) { unchanged++; continue; }

      if (changed.includes('poste')) {
        const roleError = await checkKpiRoleName(dbConfig, { poste: values.poste, currentPoste: cur.poste });
        if (roleError) throw new Error(roleError);
      }

      if (changed.includes('poste') || changed.includes('mail_responsable1')) {
        const hierarchyError = await checkManagerRoleHierarchy(dbConfig, {
          poste: values.poste ?? cur.poste,
          managerEmail: values.mail_responsable1 ?? cur.mail_responsable1
        });
        if (hierarchyError) throw new Error(hierarchyError);
      }

      if (changed.length) {
        const setSql = changed.map((f, idx) => `${f} = $${idx + 1}`).join(', ');
        await pool.query(
          `UPDATE ${schema}.employees SET ${setSql}, updated_at = CURRENT_TIMESTAMP WHERE id = $${changed.length + 1}`,
          [...changed.map((f) => values[f]), id]
        );
        const after = { ...cur };
        changed.forEach((f) => { after[f] = values[f]; });
        notifyM365Change(pool, { schema, before: cur, after, changedBy: `${req.user?.email} (import)` });
        notifyJobChange({ schema, before: cur, after, changedBy: `${req.user?.email} (import)` });
        if (changed.includes('adresse_mail') && values.adresse_mail) {
          flushPendingTrainingRequests(schema, id, values.adresse_mail);
        }
      }
      if (emergencyMerged) {
        const e = emergencyMerged;
        await pool.query(
          `INSERT INTO ${schema}.emergency_contacts (employee_id, nom, prenom, relation, telephone, email, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
           ON CONFLICT (employee_id) DO UPDATE SET
             nom = EXCLUDED.nom, prenom = EXCLUDED.prenom, relation = EXCLUDED.relation,
             telephone = EXCLUDED.telephone, email = EXCLUDED.email, updated_at = CURRENT_TIMESTAMP`,
          [id, e.nom || null, e.prenom || null, e.relation || null, e.telephone || null, e.email || null]
        );
      }
      updated++;
    } catch (error) {
      let message = error.message;
      if (error.code === '23505') message = 'Valeur déjà utilisée (matricule ou email en double)';
      errors.push({ line, id: row.id, nom: [row.nom, row.prenom].filter(Boolean).join(' '), error: message });
    }
  }

  console.log(`📥 Import complétion employés: ${updated} mis à jour, ${unchanged} inchangés, ${errors.length} erreurs`);
  res.json({ success: true, updated, unchanged, errors });
});

app.put('/api/employees/:id', authenticateToken, rejectStalePaieUnlock, async (req, res) => {
  try {
    const { id } = req.params;
    console.log('✏️ Mise à jour employé ID:', id);
    const schema = await resolveEmployeeSchemaById(req.user, id, req.body.tenant_schema);

    if (!schema) {
      return res.status(404).json({
        success: false,
        error: 'Employé non trouvé'
      });
    }

    const {
      matricule,
      nom,
      prenom,
      cin,
      passeport,
      date_emission_passport,      
      date_expiration_passport, 
      date_naissance,
      poste,
      site_dep,
      type_contrat,
      date_debut,
      date_fin_contrat,
      salaire_brute,
      photo,
      dossier_rh,
      date_depart,
      pdf_archive_url,
      adresse_mail,
      mail_responsable1,
      mail_responsable2,
      equipement,
      chef_famille,
      nb_enfants,
      salaire_base,
      indemnites_imposables_autres,
      indemnites_non_imposables_autres,
      acompte,
      indemnite_transport,
      indemnite_presence,
      prime_panier,
      prime_exceptionnelle,
      prime_fonction,
      prime_ramadhan,
      prime_ramadhan_mois,
      prime_aid,
      prime_aid_mois,
      prime_vetement_travail,
      prime_vetement_travail_mois,
      prime_exceptionnelle_mois,
      rubrique_libre_1_label,
      rubrique_libre_1_montant,
      rubrique_libre_1_mois,
      rubrique_libre_2_label,
      rubrique_libre_2_montant,
      rubrique_libre_2_mois,
      rubrique_libre_3_label,
      rubrique_libre_3_montant,
      rubrique_libre_3_mois,
      situation_familiale,
      nb_enfants_etudiants,
      nb_enfants_handicapes
    } = req.body;

    console.log('📋 Données reçues pour mise à jour:', {
      id,
      matricule,
      nom,
      prenom,
      date_fin_contrat
    });

    // A site-restricted account can't move an employee out of its sites.
    if (!isEmployeeInSiteScope(req.user, { site_dep })) {
      return res.status(403).json({
        success: false,
        error: `Site non autorisé pour ce compte (${getUserSiteScope(req.user).join(', ')})`
      });
    }

    // Validation des emails
    if (adresse_mail && !isValidEmail(adresse_mail)) {
      return res.status(400).json({
        success: false,
        error: 'Adresse email de l\'employé invalide'
      });
    }
    
    if (mail_responsable1 && !isValidEmail(mail_responsable1)) {
      return res.status(400).json({
        success: false,
        error: 'Adresse email du responsable 1 invalide'
      });
    }
    
    if (mail_responsable2 && !isValidEmail(mail_responsable2)) {
      return res.status(400).json({
        success: false,
        error: 'Adresse email du responsable 2 invalide'
      });
    }

    // Only re-check the role hierarchy when the poste or manager actually
    // changes, so unrelated edits on an existing employee are never blocked.
    // the whole row: also the "before" of the Microsoft 365 notification
    const currentRoleRow = await pool.query(
      `SELECT * FROM ${schema}.employees WHERE id = $1`,
      [id]
    );
    const currentRole = currentRoleRow.rows[0] || {};
    const roleError = await checkKpiRoleName(dbConfig, { poste, currentPoste: currentRole.poste });
    if (roleError) {
      return res.status(400).json({ success: false, error: roleError });
    }
    if (
      (poste || '') !== (currentRole.poste || '') ||
      (mail_responsable1 || '').trim().toLowerCase() !== (currentRole.mail_responsable1 || '').trim().toLowerCase()
    ) {
      const hierarchyError = await checkManagerRoleHierarchy(dbConfig, { poste, managerEmail: mail_responsable1 });
      if (hierarchyError) {
        return res.status(400).json({ success: false, error: hierarchyError });
      }
    }

    let photoUrl = photo;
    if (photo && !isValidUrl(photo)) {
      photoUrl = getDefaultAvatar(nom, prenom);
    } else if (!photo) {
      photoUrl = getDefaultAvatar(nom, prenom);
    }

    // Build the update dynamically so each schema only receives its own columns.
    const isTunisiaSchemaUpdate = schema === 'public';
    const mail_responsable_fonctionnel_update = isTunisiaSchemaUpdate
      ? (req.body.mail_responsable_fonctionnel || null)
      : null;

    if (mail_responsable_fonctionnel_update && !isValidEmail(mail_responsable_fonctionnel_update)) {
      return res.status(400).json({
        success: false,
        error: 'Adresse email du responsable fonctionnel invalide'
      });
    }

    // Payroll rubriques (see ensurePaieRubriquesColumns) -- Tunisia/public only.
    // Amount columns use COALESCE(param, column) rather than a plain
    // assignment so that when the requester isn't isPaieSalaryAuthorized(),
    // updateParams below passes null for all of them and the existing DB
    // values are left untouched instead of being overwritten with 0 --
    // salary is restricted to a single account, everyone else's edits to
    // this section are silently no-ops rather than a 403 on the whole form.
    // Since salaryCrypto encryption, the same "no-op instead of a 403"
    // treatment ALSO applies when the account is authorized but hasn't
    // supplied the unlock code this session (see services/paie/
    // salaryCrypto.js) -- writing plaintext or a stale key's ciphertext into
    // an encrypted column would be worse than just not writing.
    const paieRubriquesColumns = `,
             chef_famille = COALESCE($24, chef_famille),
             nb_enfants = COALESCE($25, nb_enfants),
             salaire_base = COALESCE($26, salaire_base),
             indemnites_imposables_autres = COALESCE($27, indemnites_imposables_autres),
             indemnites_non_imposables_autres = COALESCE($28, indemnites_non_imposables_autres),
             acompte = COALESCE($29, acompte),
             indemnite_transport = COALESCE($30, indemnite_transport),
             indemnite_presence = COALESCE($31, indemnite_presence),
             prime_panier = COALESCE($32, prime_panier),
             prime_exceptionnelle = COALESCE($33, prime_exceptionnelle),
             prime_fonction = COALESCE($34, prime_fonction),
             prime_ramadhan = COALESCE($35, prime_ramadhan),
             prime_aid = COALESCE($36, prime_aid),
             prime_vetement_travail = COALESCE($37, prime_vetement_travail),
             rubrique_libre_1_label = COALESCE($38, rubrique_libre_1_label),
             rubrique_libre_1_montant = COALESCE($39, rubrique_libre_1_montant),
             rubrique_libre_2_label = COALESCE($40, rubrique_libre_2_label),
             rubrique_libre_2_montant = COALESCE($41, rubrique_libre_2_montant),
             rubrique_libre_3_label = COALESCE($42, rubrique_libre_3_label),
             rubrique_libre_3_montant = COALESCE($43, rubrique_libre_3_montant),
             prime_exceptionnelle_mois = COALESCE($44, prime_exceptionnelle_mois),
             prime_ramadhan_mois = COALESCE($45, prime_ramadhan_mois),
             prime_aid_mois = COALESCE($46, prime_aid_mois),
             rubrique_libre_1_mois = COALESCE($47, rubrique_libre_1_mois),
             rubrique_libre_2_mois = COALESCE($48, rubrique_libre_2_mois),
             rubrique_libre_3_mois = COALESCE($49, rubrique_libre_3_mois),
             prime_vetement_travail_mois = COALESCE($50, prime_vetement_travail_mois),
             situation_familiale = COALESCE($51, situation_familiale),
             nb_enfants_etudiants = COALESCE($52, nb_enfants_etudiants),
             nb_enfants_handicapes = COALESCE($53, nb_enfants_handicapes)`;

    const updateQuery = isTunisiaSchemaUpdate
      ? `UPDATE ${schema}.employees
         SET matricule = $1, nom = $2, prenom = $3, cin = $4, passeport = $5,
             date_emission_passport = $6, date_expiration_passport = $7,
             date_naissance = $8, poste = $9, site_dep = $10, type_contrat = $11,
             date_debut = $12, date_fin_contrat = $13, salaire_brute = COALESCE($14, salaire_brute),
             photo = $15, dossier_rh = $16,
             date_depart = $17, pdf_archive_url = $18,
             adresse_mail = $19, mail_responsable1 = $20, mail_responsable2 = $21,
             mail_responsable_fonctionnel = $22,
             equipement = COALESCE($23, equipement)${paieRubriquesColumns},
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $54 RETURNING *`
      : `UPDATE ${schema}.employees
         SET matricule = $1, nom = $2, prenom = $3, passeport = $4,
             date_emission_passport = $5, date_expiration_passport = $6,
             date_naissance = $7, poste = $8, site_dep = $9, type_contrat = $10,
             date_debut = $11, date_fin_contrat = $12, salaire_brute = $13,
             photo = $14, dossier_rh = $15,
             date_depart = $16, pdf_archive_url = $17,
             adresse_mail = $18, mail_responsable1 = $19, mail_responsable2 = $20,
             equipement = COALESCE($21, equipement),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $22 RETURNING *`;

    const equipementParam = (isGroupRole(req.user?.role) && equipement !== undefined) ? equipement : null;

    const updateParams = isTunisiaSchemaUpdate
      ? [
          matricule, nom, prenom, cin, passeport,
          date_emission_passport || null,
          date_expiration_passport || null,
          date_naissance, poste, site_dep, type_contrat,
          date_debut, date_fin_contrat || null,
          (() => {
            const salaryAuthorized = isPaieSalaryAuthorized(req.user);
            const unlockKey = salaryCrypto.getUnlockKey(req.headers['x-paie-unlock-token']);
            const blank = salaire_brute === null || salaire_brute === undefined || salaire_brute === '';
            return (salaryAuthorized && unlockKey && !blank) ? salaryCrypto.encryptValue(salaire_brute, unlockKey) : null;
          })(),
          photoUrl, dossier_rh,
          date_depart, pdf_archive_url,
          adresse_mail || null,
          mail_responsable1 || null,
          mail_responsable2 || null,
          mail_responsable_fonctionnel_update,
          equipementParam,
          ...(() => {
            // Only isPaieSalaryAuthorized() may actually change salary amounts,
            // AND (since salaryCrypto encryption) only with a valid unlock code
            // for this session. Anyone else submitting this form (e.g. the
            // labels/checkbox above are still editable) passes null for every
            // amount here, and the COALESCE(...) in paieRubriquesColumns
            // leaves the existing DB values untouched -- a silent no-op on
            // those fields, not a 403.
            const salaryAuthorized = isPaieSalaryAuthorized(req.user);
            const unlockKey = salaryCrypto.getUnlockKey(req.headers['x-paie-unlock-token']);
            const canWriteSalary = salaryAuthorized && !!unlockKey;
            // A blank amount means "not sent" (e.g. a form loaded while
            // locked, where every amount was masked to null) and keeps the
            // stored value via COALESCE -- it used to be written as 0, which
            // wiped every rubrique the user didn't retype. Type 0 to clear.
            const amount = (v) => (canWriteSalary && v !== null && v !== undefined && v !== ''
              ? salaryCrypto.encryptValue(v, unlockKey)
              : null);
            const label = (v) => (salaryAuthorized ? (v || null) : null);
            // '' rather than null when clearing -- COALESCE($n, column) can
            // never overwrite a column WITH null (that's exactly what makes it
            // safe for unauthorized submits above), so an authorized user
            // clearing the application period back to empty needs a real,
            // non-null value to write. isSeasonalFieldActive() in
            // routes/paie.cjs treats '' the same as unset -- it never equals a
            // real payroll period, so it just never matches.
            const mois = (v) => (salaryAuthorized ? (v || '') : null);
            return [
              chef_famille ?? null,
              nb_enfants ?? null,
              amount(salaire_base),
              amount(indemnites_imposables_autres),
              amount(indemnites_non_imposables_autres),
              amount(acompte),
              amount(indemnite_transport),
              amount(indemnite_presence),
              amount(prime_panier),
              amount(prime_exceptionnelle),
              amount(prime_fonction),
              amount(prime_ramadhan),
              amount(prime_aid),
              amount(prime_vetement_travail),
              label(rubrique_libre_1_label),
              amount(rubrique_libre_1_montant),
              label(rubrique_libre_2_label),
              amount(rubrique_libre_2_montant),
              label(rubrique_libre_3_label),
              amount(rubrique_libre_3_montant),
              mois(prime_exceptionnelle_mois),
              mois(prime_ramadhan_mois),
              mois(prime_aid_mois),
              mois(rubrique_libre_1_mois),
              mois(rubrique_libre_2_mois),
              mois(rubrique_libre_3_mois),
              mois(prime_vetement_travail_mois),
              // Display-only -- never gated behind isPaieSalaryAuthorized()
              // like the amount fields above, since it's not a salary
              // figure. Anyone who can edit the employee record can set it.
              situation_familiale ?? null,
              nb_enfants_etudiants ?? null,
              nb_enfants_handicapes ?? null,
            ];
          })(),
          id
        ]
      : [
          matricule, nom, prenom, passeport,
          date_emission_passport || null,
          date_expiration_passport || null,
          date_naissance, poste, site_dep, type_contrat,
          date_debut, date_fin_contrat || null,
          salaire_brute, photoUrl, dossier_rh,
          date_depart, pdf_archive_url,
          adresse_mail || null,
          mail_responsable1 || null,
          mail_responsable2 || null,
          equipementParam,
          id
        ];

    const result = await pool.query(updateQuery, updateParams);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Employé non trouvé'
      });
    }

    console.log('✅ Employé mis à jour avec succès');
    
    // Vérifier si besoin d'envoyer une alerte
    if (date_fin_contrat) {
      const now = new Date();
      const oneMonthLater = new Date(now);
      oneMonthLater.setMonth(oneMonthLater.getMonth() + 1);
      const contractEndDate = new Date(date_fin_contrat);
      
      // Si la date de fin est dans 1 mois, envoyer une alerte
      if (contractEndDate.toDateString() === oneMonthLater.toDateString()) {
        const employee = result.rows[0];
        setTimeout(() => {
          sendContractEndAlert(employee);
        }, 5000);
      }
    }
    
    const employee = result.rows[0];
    employee.tenant_schema = schema;

    // Group IT keeps Microsoft 365 in line (name, email, title, site, manager)
    notifyM365Change(pool, { schema, before: currentRole, after: employee, changedBy: req.user?.email });
    // IATF: local HR updates the job description, competences, training
    notifyJobChange({ schema, before: currentRole, after: employee, changedBy: req.user?.email });

    // IT has now given the new hire's email: release the onboarding training
    // request that was waiting for it (no-op when none is pending).
    if (employee.adresse_mail) {
      flushPendingTrainingRequests(schema, employee.id, employee.adresse_mail);
    }

    res.json({
      success: true,
      data: maskTunisiaSalaryFields(employee, req.user, salaryCrypto.getUnlockKey(req.headers['x-paie-unlock-token'])),
      message: 'Employé mis à jour avec succès'
    });
  } catch (error) {
    console.error('❌ Erreur mise à jour employé:', error);
    console.error('❌ Détails erreur:', {
      code: error.code,
      constraint: error.constraint,
      detail: error.detail,
      message: error.message,
      stack: error.stack
    });

    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        error: error.message,
        code: error.code,
        matches: error.matches || undefined
      });
    }
    
    let errorMessage = "Erreur lors de la mise à jour de l'employé";
    
    if (error.code === '23505') {
      if (error.constraint === 'employees_matricule_key') {
        errorMessage = 'Le matricule existe déjà';
      } else if (error.constraint === 'employees_cin_key') {
        errorMessage = 'Le CIN existe déjà';
      } else if (error.constraint === 'employees_adresse_mail_key') {
        errorMessage = 'L\'adresse email existe déjà';
      }
    } else if (error.code === '22007') {
      errorMessage = 'Format de date invalide';
    } else if (error.message && error.message.includes('parameter')) {
      errorMessage = 'Erreur de paramètres dans la requête SQL';
    }
    
    res.status(500).json({
      success: false,
      error: errorMessage,
      details: error.message,
      code: error.code
    });
  }
});

app.post('/api/employees', authenticateToken, async (req, res) => {
  try {
    console.log('➕ Création nouvel employé');
    const requestedSchema = req.body.tenant_schema;

    if (isGroupRole(req.user?.role) && !requestedSchema) {
      return res.status(400).json({
        success: false,
        error: 'tenant_schema est obligatoire pour les rôles groupe'
      });
    }

    if (isGroupRole(req.user?.role)) {
      const allowedSchemas = getAccessibleEmployeeSchemas(req.user);
      if (!allowedSchemas.includes(requestedSchema)) {
        return res.status(403).json({
          success: false,
          error: 'tenant_schema non autorisé'
        });
      }
    }

    const schema = resolveEmployeeSchemaForRequest(req.user, requestedSchema);

    const {
      matricule,
      nom,
      prenom,
      cin,
      passeport,
      date_emission_passport,
      date_expiration_passport,   
      date_naissance,
      poste,
      site_dep,
      type_contrat,
      date_debut,
      date_fin_contrat,
      salaire_brute,
      photo,
      dossier_rh,
      adresse_mail,
      mail_responsable1,
      mail_responsable2,
      grade
    } = req.body;

    // Log des données reçues pour debug
    console.log('📋 Données reçues:', {
      matricule,
      nom,
      prenom,
      cin,
      poste,
      adresse_mail,
      date_fin_contrat
    });

    if (!isEmployeeInSiteScope(req.user, { site_dep })) {
      return res.status(403).json({
        success: false,
        error: `Site non autorisé pour ce compte (${getUserSiteScope(req.user).join(', ')})`
      });
    }

    const isTunisiaSchema = schema === 'public';

    if (isTunisiaSchema) {
      if (!matricule || !nom || !prenom) {
        return res.status(400).json({
          success: false,
          error: 'Matricule, nom et prénom sont obligatoires'
        });
      }
    } else {
      // salaire_brute is no longer required here: the salary field is hidden
      // for non-Tunisian tenants and for group HR (frontend
      // utils/salaryVisibility.js), so it's optional and stored as null when
      // empty. CARTHAGE/ATLAS's own form still asks for it (HTML required).
      if (
        !matricule || !nom || !prenom ||
        !poste || !site_dep || !type_contrat ||
        !date_debut
      ) {
        return res.status(400).json({
          success: false,
          error: 'Tous les champs obligatoires doivent être remplis'
        });
      }
    }

    // Validation des emails
    if (adresse_mail && !isValidEmail(adresse_mail)) {
      return res.status(400).json({
        success: false,
        error: 'Adresse email de l\'employé invalide'
      });
    }
    
    if (mail_responsable1 && !isValidEmail(mail_responsable1)) {
      return res.status(400).json({
        success: false,
        error: 'Adresse email du responsable 1 invalide'
      });
    }
    
    if (mail_responsable2 && !isValidEmail(mail_responsable2)) {
      return res.status(400).json({
        success: false,
        error: 'Adresse email du responsable 2 invalide'
      });
    }

    const roleError = await checkKpiRoleName(dbConfig, { poste });
    if (roleError) {
      return res.status(400).json({ success: false, error: roleError });
    }

    const hierarchyError = await checkManagerRoleHierarchy(dbConfig, { poste, managerEmail: mail_responsable1 });
    if (hierarchyError) {
      return res.status(400).json({ success: false, error: hierarchyError });
    }

    const mail_responsable_fonctionnel = isTunisiaSchema
      ? (req.body.mail_responsable_fonctionnel || null)
      : null;

    if (mail_responsable_fonctionnel && !isValidEmail(mail_responsable_fonctionnel)) {
      return res.status(400).json({
        success: false,
        error: 'Adresse email du responsable fonctionnel invalide'
      });
    }

    let photoUrl = photo;
    if (!photoUrl) {
      photoUrl = getDefaultAvatar(nom, prenom);
    }

    console.log('📝 Exécution requête INSERT avec photo URL:', photoUrl);

    // salaire_brute is encrypted for Tunisia rows only (see
    // TUNISIA_SALARY_AMOUNT_FIELDS / maskTunisiaSalaryFields above); every
    // other tenant keeps storing it as a plain number, unchanged. If a
    // Tunisia account creates an employee without the session unlocked,
    // salaire_brute is simply left unset (null) rather than stored in
    // plaintext or rejecting the whole creation -- it can be set later from
    // the edit form once unlocked, same "silent no-op" convention already
    // used for the other Tunisia payroll fields.
    const salaireBruteParam = (() => {
      if (!salaire_brute) return null;
      if (!isTunisiaSchema) return parseFloat(salaire_brute);
      const unlockKey = salaryCrypto.getUnlockKey(req.headers['x-paie-unlock-token']);
      return unlockKey ? salaryCrypto.encryptValue(parseFloat(salaire_brute), unlockKey) : null;
    })();

    // SAHEL (public) never stored a grade, so new SAHEL hires showed up for group
    // HR with no grade (the card then fell back to the SAHEL-only label like
    // "Digitale"). Keep the grade sent by the form, else use the most common
    // grade of active SAHEL employees holding the same poste.
    let gradeParam = grade || null;
    if (isTunisiaSchema && !gradeParam && poste) {
      const gradeRow = await pool.query(
        `SELECT grade FROM public.employees
         WHERE LOWER(TRIM(poste)) = LOWER(TRIM($1)) AND NULLIF(TRIM(grade), '') IS NOT NULL
           AND (statut = 'actif' OR statut IS NULL)
         GROUP BY grade ORDER BY COUNT(*) DESC LIMIT 1`,
        [poste]
      );
      gradeParam = gradeRow.rows[0]?.grade || null;
    }

    const insertColumns = `matricule, nom, prenom, ${isTunisiaSchema ? 'cin, ' : ''}passeport,
       date_emission_passport, date_expiration_passport,
       date_naissance, poste, site_dep, type_contrat,
       date_debut, date_fin_contrat, salaire_brute, photo, dossier_rh,
       adresse_mail, mail_responsable1, mail_responsable2,
       ${isTunisiaSchema ? 'mail_responsable_fonctionnel, ' : ''}grade, statut`;

    const insertValues = isTunisiaSchema
      ? `$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22`
      : `$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20`;

    const insertParams = [
      matricule,
      nom,
      prenom,
      ...(isTunisiaSchema ? [cin] : []),
      passeport || null,
      date_emission_passport || null,
      date_expiration_passport || null,
      date_naissance,
      poste,
      site_dep,
      type_contrat,
      date_debut,
      date_fin_contrat || null,
      salaireBruteParam,
      photoUrl,
      dossier_rh || null,
      adresse_mail || null,
      mail_responsable1 || null,
      mail_responsable2 || null,
      ...(isTunisiaSchema ? [mail_responsable_fonctionnel] : []),
      gradeParam,
      'actif'
    ];

    const result = await pool.query(
      `INSERT INTO ${schema}.employees (${insertColumns}) VALUES (${insertValues}) RETURNING *`,
      insertParams
    );

    const employee = result.rows[0];
    employee.tenant_schema = schema;
    console.log('✅ Employé créé, ID:', employee.id);

    // Vérifier si besoin d'envoyer une alerte
    if (date_fin_contrat) {
      const now = new Date();
      const oneMonthLater = new Date(now);
      oneMonthLater.setMonth(oneMonthLater.getMonth() + 1);
      const contractEndDate = new Date(date_fin_contrat);
      
      // Si la date de fin est dans 1 mois, envoyer une alerte
      if (contractEndDate.toDateString() === oneMonthLater.toDateString()) {
        const employee = result.rows[0];
        setTimeout(() => {
          sendContractEndAlert(employee);
        }, 5000);
      }
    }

    res.json({
      success: true,
      data: maskTunisiaSalaryFields(employee, req.user, salaryCrypto.getUnlockKey(req.headers['x-paie-unlock-token'])),
      message: 'Employé créé avec succès'
    });
    
  } catch (error) {
    console.error('❌ Erreur création employé:', error);
    console.error('❌ Détails erreur:', {
      code: error.code,
      constraint: error.constraint,
      detail: error.detail,
      message: error.message
    });

    if (error.code === '23505') {
      if (error.constraint === 'employees_matricule_key') {
        res.status(400).json({
          success: false,
          error: 'Le matricule existe déjà'
        });
      } else if (error.constraint === 'employees_cin_key') {
        res.status(400).json({
          success: false,
          error: 'Le CIN existe déjà'
        });
      } else if (error.constraint === 'employees_adresse_mail_key') {
        res.status(400).json({
          success: false,
          error: 'L\'adresse email existe déjà'
        });
      } else {
        res.status(400).json({
          success: false,
          error: 'Violation de contrainte unique',
          details: error.detail
        });
      }
    } else {
      res.status(500).json({
        success: false,
        error: "Erreur lors de la création de l'employé",
        message: error.message,
        code: error.code
      });
    }
  }
});


// Route pour vérifier manuellement les alertes de fin de contrat
app.get('/api/contract-alerts/check', authenticateToken, async (req, res) => {
  try {
    const alerts = await checkContractEndAlerts();
    
    res.json({
      success: true,
      message: `Vérification terminée. ${alerts.length} alerte(s) envoyée(s).`,
      alerts: alerts.map(e => ({
        id: e.id,
        nom: `${e.prenom} ${e.nom}`,
        matricule: e.matricule,
        date_fin_contrat: e.date_fin_contrat,
        poste: e.poste
      }))
    });
  } catch (error) {
    console.error('❌ Erreur vérification manuelle:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la vérification des alertes',
      message: error.message
    });
  }
});

// =========================
// Routes Demandes RH
// =========================

app.get('/api/demandes', authenticateToken, async (req, res) => {
  try {
    const homeSchema = getSchemaForUser(req.user);
    const {
      type_demande,
      statut,
      date_debut,
      date_fin,
      employe_id,
      page = 1,
      limit = 1000,
      _t
    } = req.query;

    console.log('📋 Récupération demandes avec filtres:', {
      type_demande,
      statut,
      date_debut,
      date_fin,
      employe_id
    });

    // Group HR roles see requests from every site (same schemas as /api/employees).
    // A specific employee filter stays scoped to the home schema since the
    // employee picker itself is only ever populated from that schema.
    const schemas = (isGroupRole(req.user?.role) && !employe_id)
      ? getAccessibleEmployeeSchemas(req.user)
      : [homeSchema];

    const schemaResults = await Promise.all(schemas.map(async (schema) => {
      let query = `
        SELECT
          d.*,
          e.nom as employe_nom,
          e.prenom as employe_prenom,
          e.poste as employe_poste,
          e.photo as employe_photo,
          e.matricule as employe_matricule,
          e.mail_responsable1,
          e.mail_responsable2,
          e.adresse_mail as employe_email,
          ${schema === 'public' ? 'COALESCE(e.site, e.site_dep)' : 'e.site_dep'} as employe_site_dep,
          r1.nom as responsable1_nom,
          r1.prenom as responsable1_prenom,
          r2.nom as responsable2_nom,
          r2.prenom as responsable2_prenom
        FROM ${schema}.demande_rh d
        LEFT JOIN ${schema}.employees e ON d.employe_id = e.id
        -- Manager names resolved in the same query (was 2 extra queries per row).
        LEFT JOIN LATERAL (
          SELECT nom, prenom FROM ${schema}.employees WHERE adresse_mail = e.mail_responsable1 LIMIT 1
        ) r1 ON true
        LEFT JOIN LATERAL (
          SELECT nom, prenom FROM ${schema}.employees WHERE adresse_mail = e.mail_responsable2 LIMIT 1
        ) r2 ON true
        WHERE 1=1
      `;

      const params = [];
      let paramCount = 0;

      if (type_demande && type_demande !== '' && type_demande !== 'undefined') {
        paramCount++;
        query += ` AND LOWER(TRIM(d.type_demande)) = LOWER($${paramCount})`;
        params.push(type_demande.trim());
      }

      if (statut && statut !== '' && statut !== 'undefined') {
        paramCount++;
        query += ` AND d.statut = $${paramCount}`;
        params.push(statut);
      }

      if (employe_id && employe_id !== '' && employe_id !== 'undefined') {
        paramCount++;
        query += ` AND d.employe_id = $${paramCount}`;
        params.push(employe_id);
      }

      if (date_debut && date_debut !== '' && date_debut !== 'undefined') {
        paramCount++;
        query += ` AND d.date_depart >= $${paramCount}`;
        params.push(date_debut);
      }

      if (date_fin && date_fin !== '' && date_fin !== 'undefined') {
        paramCount++;
        query += ` AND d.date_depart <= $${paramCount}`;
        params.push(date_fin);
      }

      const siteScope = demandeSiteScopeSql(req.user, schema, 'd.employe_id', paramCount + 1);
      query += siteScope.sql;
      params.push(...siteScope.params);

      query += ` ORDER BY d.created_at DESC`;

      const result = await pool.query(query, params);
      const withResponsables = result.rows.map((demande) => ({ ...demande, _source_schema: schema }));

      let countQuery = `SELECT COUNT(*) as total_count FROM ${schema}.demande_rh d WHERE 1=1`;
      const countParams = [];
      let countParamCount = 0;

      if (type_demande && type_demande !== '' && type_demande !== 'undefined') {
        countParamCount++;
        countQuery += ` AND LOWER(TRIM(d.type_demande)) = LOWER($${countParamCount})`;
        countParams.push(type_demande.trim());
      }

      if (statut && statut !== '' && statut !== 'undefined') {
        countParamCount++;
        countQuery += ` AND d.statut = $${countParamCount}`;
        countParams.push(statut);
      }

      if (date_debut && date_debut !== '' && date_debut !== 'undefined') {
        countParamCount++;
        countQuery += ` AND d.date_depart >= $${countParamCount}`;
        countParams.push(date_debut);
      }

      if (date_fin && date_fin !== '' && date_fin !== 'undefined') {
        countParamCount++;
        countQuery += ` AND d.date_depart <= $${countParamCount}`;
        countParams.push(date_fin);
      }

      const countSiteScope = demandeSiteScopeSql(req.user, schema, 'd.employe_id', countParamCount + 1);
      countQuery += countSiteScope.sql;
      countParams.push(...countSiteScope.params);

      const countResult = await pool.query(countQuery, countParams);
      const schemaTotal = parseInt(countResult.rows[0]?.total_count || 0);

      return { demandes: withResponsables, total: schemaTotal };
    }));

    const demandesAvecResponsables = schemaResults
      .flatMap((r) => r.demandes)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const total = schemaResults.reduce((sum, r) => sum + r.total, 0);

    console.log(`✅ Résultats finaux: ${demandesAvecResponsables.length} demandes sur ${total} total en base (schemas: ${schemas.join(', ')})`);

    res.json({
      success: true,
      demandes: demandesAvecResponsables,
      home_schema: homeSchema,
      pagination: {
        page: parseInt(page),
        limit: limit && limit !== 'all' ? parseInt(limit) : total,
        total,
        pages: limit && limit !== 'all' ? Math.ceil(total / parseInt(limit)) : 1
      },
      debug: {
        countInBase: total,
        countReturned: demandesAvecResponsables.length,
        hasDuplicates: demandesAvecResponsables.length !== total
      }
    });
  } catch (error) {
    console.error('❌ Erreur récupération demandes:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la récupération des demandes',
      message: error.message
    });
  }
});

app.get('/api/demandes/:id', authenticateToken, requireDemandeInSiteScope, async (req, res) => {
  try {
    const homeSchema = getSchemaForUser(req.user);
    const { id } = req.params;
    console.log('📄 Récupération demande ID:', id);

    // Group HR roles may be looking up a request that lives in another site's
    // schema (since /api/demandes now aggregates across sites for them), so
    // fall back to searching every accessible schema instead of only the home one.
    const schemasToTry = isGroupRole(req.user?.role)
      ? [homeSchema, ...getAccessibleEmployeeSchemas(req.user).filter(s => s !== homeSchema)]
      : [homeSchema];

    let row = null;
    for (const schema of schemasToTry) {
      const result = await pool.query(
        `
        SELECT d.*,
               e.nom as employe_nom,
               e.prenom as employe_prenom,
               e.poste as employe_poste,
               e.photo as employe_photo,
               e.matricule as employe_matricule,
               e.mail_responsable1,
               e.mail_responsable2,
               e.adresse_mail as employe_email,
               r1.nom as responsable1_nom,
               r1.prenom as responsable1_prenom,
               r2.nom as responsable2_nom,
               r2.prenom as responsable2_prenom
        FROM ${schema}.demande_rh d
        LEFT JOIN ${schema}.employees e ON d.employe_id = e.id
        LEFT JOIN ${schema}.employees r1 ON e.mail_responsable1 = r1.adresse_mail
        LEFT JOIN ${schema}.employees r2 ON e.mail_responsable2 = r2.adresse_mail
        WHERE d.id = $1
      `,
        [id]
      );
      if (result.rows.length > 0) {
        row = { ...result.rows[0], _source_schema: schema };
        break;
      }
    }

    if (!row) {
      return res.status(404).json({ error: 'Demande non trouvée' });
    }

    console.log('✅ Demande récupérée');
    res.json(row);
  } catch (error) {
    console.error('❌ Erreur récupération demande:', error);
    res.status(500).json({
      error: 'Erreur lors de la récupération de la demande',
      message: error.message
    });
  }
});

app.post('/api/demandes', authenticateToken, async (req, res) => {
  try {
    const schema = getSchemaForUser(req.user);
    console.log('➕ Création nouvelle demande RH');

    const {
      employe_id,
      type_demande,
      titre,
      type_conge,
      type_conge_autre,
      date_depart,
      date_retour,
      heure_depart,
      heure_retour,
      demi_journee,
      frais_deplacement,
      commentaire_refus
    } = req.body;

    if (!employe_id || !type_demande || !titre) {
      return res.status(400).json({
        error: 'Employé, type de demande et titre sont obligatoires'
      });
    }

    if (!(await isEmployeeIdInSiteScope(req.user, schema, employe_id))) {
      return res.status(404).json({ error: 'Employé non trouvé' });
    }

    const result = await pool.query(
      `
      INSERT INTO ${schema}.demande_rh (
        employe_id, type_demande, titre, type_conge, type_conge_autre,
        date_depart, date_retour, heure_depart, heure_retour,
        demi_journee, frais_deplacement, commentaire_refus, statut,
        created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'en_attente', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      RETURNING *
    `,
      [
        employe_id,
        type_demande,
        titre,
        type_conge || null,
        type_conge_autre || null,
        date_depart || null,
        date_retour || null,
        heure_depart || null,
        heure_retour || null,
        demi_journee || false,
        frais_deplacement ? parseFloat(frais_deplacement) : null,
        commentaire_refus || null
      ]
    );

    console.log('✅ Demande créée, ID:', result.rows[0].id);
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erreur création demande:', error);
    res.status(500).json({
      error: 'Erreur lors de la création de la demande',
      message: error.message
    });
  }
});

app.put('/api/demandes/:id', authenticateToken, requireDemandeInSiteScope, async (req, res) => {
  try {
    const schema = getSchemaForUser(req.user);
    const { id } = req.params;
    console.log('✏️ Mise à jour demande ID:', id);

    const {
      type_demande,
      titre,
      type_conge,
      type_conge_autre,
      date_depart,
      date_retour,
      heure_depart,
      heure_retour,
      demi_journee,
      frais_deplacement,
      statut,
      approuve_responsable1,
      approuve_responsable2,
      commentaire_refus
    } = req.body;

    let finalStatut = statut;
    
    if (approuve_responsable1 === false || approuve_responsable2 === false) {
      finalStatut = 'refuse';
    } else if (approuve_responsable1 === true && approuve_responsable2 === true) {
      finalStatut = 'approuve';
    } else if (approuve_responsable1 === true && !approuve_responsable2) {
      const employeeResult = await pool.query(
        `SELECT mail_responsable2 FROM ${schema}.employees WHERE id = (SELECT employe_id FROM ${schema}.demande_rh WHERE id = $1)`,
        [id]
      );
      
      if (employeeResult.rows.length > 0 && !employeeResult.rows[0].mail_responsable2) {
        finalStatut = 'approuve';
      } else {
        finalStatut = 'en_attente';
      }
    } else if (approuve_responsable2 === true && !approuve_responsable1) {
      finalStatut = 'en_attente';
    } else {
      finalStatut = finalStatut || 'en_attente';
    }

    const result = await pool.query(
      `
      UPDATE ${schema}.demande_rh 
      SET type_demande = $1, titre = $2, type_conge = $3, type_conge_autre = $4,
          date_depart = $5, date_retour = $6, heure_depart = $7, heure_retour = $8,
          demi_journee = $9, frais_deplacement = $10, statut = $11,
          approuve_responsable1 = $12, approuve_responsable2 = $13,
          commentaire_refus = $14, updated_at = CURRENT_TIMESTAMP
      WHERE id = $15
      RETURNING *
    `,
      [
        type_demande,
        titre,
        type_conge || null,
        type_conge_autre || null,
        date_depart || null,
        date_retour || null,
        heure_depart || null,
        heure_retour || null,
        demi_journee || false,
        frais_deplacement ? parseFloat(frais_deplacement) : null,
        finalStatut,
        approuve_responsable1 || false,
        approuve_responsable2 || false,
        commentaire_refus || null,
        id
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Demande non trouvée' });
    }

    console.log('✅ Demande mise à jour - Statut:', finalStatut);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erreur mise à jour demande:', error);
    res.status(500).json({
      error: 'Erreur lors de la mise à jour de la demande',
      message: error.message
    });
  }
});

app.put('/api/demandes/:id/statut', authenticateToken, requireDemandeInSiteScope, async (req, res) => {
  try {
    const schema = getSchemaForUser(req.user);
    const { id } = req.params;
    const { statut, commentaire_refus } = req.body;

    console.log('🔄 Changement statut demande ID:', id, '->', statut);

    const result = await pool.query(
      `
      UPDATE ${schema}.demande_rh 
      SET statut = $1, commentaire_refus = $2, updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
      RETURNING *
    `,
      [statut, commentaire_refus || null, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Demande non trouvé' });
    }

    console.log('✅ Statut demande mis à jour');
    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Erreur changement statut:', error);
    res.status(500).json({
      error: 'Erreur lors du changement de statut',
      message: error.message
    });
  }
});

app.delete('/api/demandes/:id', authenticateToken, requireDemandeInSiteScope, async (req, res) => {
  try {
    const schema = getSchemaForUser(req.user);
    const { id } = req.params;
    console.log('🗑️ Suppression demande ID:', id);

    const result = await pool.query(
      `DELETE FROM ${schema}.demande_rh WHERE id = $1 RETURNING *`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Demande non trouvée' });
    }

    console.log('✅ Demande supprimée');
    res.json({
      message: 'Demande supprimée avec succès',
      deleted: result.rows[0]
    });
  } catch (error) {
    console.error('❌ Erreur suppression demande:', error);
    res.status(500).json({
      error: 'Erreur lors de la suppression de la demande',
      message: error.message
    });
  }
});




// =========================
// ROUTES NOTIFICATIONS
// =========================

// =========================
// ROUTES NOTIFICATIONS AMÉLIORÉES
// =========================

// Récupérer le nombre de nouvelles demandes (non lues)
// MODIFIÉ : Ne compte que les demandes non lues
app.get('/api/notifications/count', authenticateToken, async (req, res) => {
  try {
    const schema = getSchemaForUser(req.user);
    console.log('🔔 Récupération du nombre de notifications non lues');

    // Compter les demandes en attente créées dans les dernières 24h
    // qui n'ont pas été marquées comme lues
    const siteScope = demandeSiteScopeSql(req.user, schema, 'employe_id', 1);
    const result = await pool.query(`
      SELECT COUNT(*) as count
      FROM ${schema}.demande_rh
      WHERE statut = 'en_attente'
        AND created_at >= NOW() - INTERVAL '24 hours'
        AND (last_viewed_at IS NULL OR last_viewed_at < created_at)${siteScope.sql}
    `, siteScope.params);

    const count = parseInt(result.rows[0].count) || 0;
    
    console.log(`✅ ${count} notification(s) non lue(s)`);
    res.json({ 
      success: true,
      count: count 
    });
  } catch (error) {
    console.error('❌ Erreur récupération notifications:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la récupération des notifications',
      message: error.message
    });
  }
});

// Récupérer les détails des notifications
// MODIFIÉ : Inclure l'état de lecture
app.get('/api/notifications/recent', authenticateToken, async (req, res) => {
  try {
    const schema = getSchemaForUser(req.user);
    console.log('🔔 Récupération des notifications récentes');

    const siteScope = siteScopeSql(req.user, 'e', 1);
    const result = await pool.query(`
      SELECT 
        d.id,
        d.titre,
        d.type_demande,
        d.created_at,
        d.last_viewed_at,
        e.nom as employe_nom,
        e.prenom as employe_prenom,
        e.photo as employe_photo,
        CASE 
          WHEN d.last_viewed_at IS NULL OR d.last_viewed_at < d.created_at THEN false
          ELSE true
        END as read
      FROM ${schema}.demande_rh d
      LEFT JOIN ${schema}.employees e ON d.employe_id = e.id
      WHERE d.statut = 'en_attente'
        AND d.created_at >= NOW() - INTERVAL '24 hours'${siteScope.sql}
      ORDER BY d.created_at DESC
      LIMIT 10
    `, siteScope.params);

    console.log(`✅ ${result.rows.length} notification(s) récente(s)`);
    res.json({
      success: true,
      notifications: result.rows
    });
  } catch (error) {
    console.error('❌ Erreur récupération notifications récentes:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la récupération des notifications',
      message: error.message
    });
  }
});

// NOUVELLE ROUTE : Marquer une notification comme lue
app.post('/api/notifications/:id/mark-read', authenticateToken, requireDemandeInSiteScope, async (req, res) => {
  try {
    const schema = getSchemaForUser(req.user);
    const { id } = req.params;
    
    console.log('✅ Marquer notification comme lue:', id);
    
    // Mettre à jour la date de dernière visualisation
    await pool.query(
      `UPDATE ${schema}.demande_rh SET last_viewed_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [id]
    );
    
    res.json({
      success: true,
      message: 'Notification marquée comme lue'
    });
  } catch (error) {
    console.error('❌ Erreur marquage notification:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors du marquage de la notification',
      message: error.message
    });
  }
});

// NOUVELLE ROUTE : Marquer toutes les notifications comme lues
app.post('/api/notifications/mark-all-read', authenticateToken, async (req, res) => {
  try {
    const schema = getSchemaForUser(req.user);
    console.log('✅ Marquer toutes les notifications comme lues');
    
    // Marquer toutes les notifications non lues comme lues
    const siteScope = demandeSiteScopeSql(req.user, schema, 'employe_id', 1);
    await pool.query(`
      UPDATE ${schema}.demande_rh
      SET last_viewed_at = CURRENT_TIMESTAMP
      WHERE statut = 'en_attente'
        AND created_at >= NOW() - INTERVAL '24 hours'
        AND (last_viewed_at IS NULL OR last_viewed_at < created_at)${siteScope.sql}
    `, siteScope.params);
    
    res.json({
      success: true,
      message: 'Toutes les notifications marquées comme lues'
    });
  } catch (error) {
    console.error('❌ Erreur marquage toutes notifications:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors du marquage des notifications',
      message: error.message
    });
  }
});

// NOUVELLE ROUTE : Vérifier si une notification est lue
app.get('/api/notifications/:id/status', authenticateToken, requireDemandeInSiteScope, async (req, res) => {
  try {
    const schema = getSchemaForUser(req.user);
    const { id } = req.params;
    
    const result = await pool.query(`
      SELECT 
        CASE 
          WHEN last_viewed_at IS NULL OR last_viewed_at < created_at THEN false
          ELSE true
        END as read
      FROM ${schema}.demande_rh 
      WHERE id = $1
    `, [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Notification non trouvée' });
    }
    
    res.json({
      success: true,
      read: result.rows[0].read
    });
  } catch (error) {
    console.error('❌ Erreur vérification statut:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la vérification du statut',
      message: error.message
    });
  }
});
// =========================
// ROUTE POUR ÉTAT DES LIEUX (OPTIMISÉE)
// =========================

app.get('/api/presence/overview', authenticateToken, async (req, res) => {
  try {
    const schema = getSchemaForUser(req.user);
    const { startDate, endDate } = req.query;

    const employeeSiteScope = siteScopeSql(req.user, 'e', 1);
    const employeesQuery = await pool.query(`
      SELECT id, matricule, nom, prenom, poste, photo
      FROM ${schema}.employees e
      WHERE statut = 'actif'${employeeSiteScope.sql}
      ORDER BY nom, prenom
    `, employeeSiteScope.params);
    
    const employees = employeesQuery.rows;
    
    const demandesQuery = await pool.query(`
      SELECT d.*, e.nom as employe_nom, e.prenom as employe_prenom
      FROM ${schema}.demande_rh d
      LEFT JOIN ${schema}.employees e ON d.employe_id = e.id
      WHERE d.statut = 'approuve'
        AND d.date_depart <= $1
        AND (d.date_retour IS NULL OR d.date_retour >= $2)${siteScopeSql(req.user, 'e', 3).sql}
      ORDER BY d.date_depart
    `, [endDate || '2999-12-31', startDate || '1900-01-01', ...siteScopeSql(req.user, 'e', 3).params]);
    
    const demandes = demandesQuery.rows;
    
    res.json({
      success: true,
      employees: employees,
      demandes: demandes,
      dateRange: {
        start: startDate,
        end: endDate
      }
    });
    
  } catch (error) {
    console.error('❌ Erreur récupération état des lieux:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la récupération des données',
      message: error.message
    });
  }
});
// ==================================================
// =================== MODULE VISA ==================
// ==================================================

const { types } = require("pg");
types.setTypeParser(1082, (val) => val);

const PizZip = require("pizzip");
const Docxtemplater = require("docxtemplater");

const ASSURANCE_REQUEST_TO = process.env.ASSURANCE_REQUEST_TO || "kai.moreau@example.com";
const BILLET_REQUEST_TO = process.env.BILLET_REQUEST_TO || "kai.moreau@example.com";
const FORMATION_REQUEST_TO = process.env.FORMATION_REQUEST_TO || "sam.garcia@example.com,sacha.moreau@example.com";

// Real per-site IT contacts (HR-provided list, Sep 2026) for onboarding/offboarding
// IT emails -- replaces the old hardcoded test recipient. One recipient per site;
// Mexico has no local IT team so it routes to India, and Tunisia's "Carthage" site
// (not on HR's list) routes to Drew in ATLAS. Anything else unmapped falls back
// to the Group IT Manager.
const SITE_IT_CONTACTS = {
  chennai: "user717@example.com",
  loire: "sacha.garcia@example.com",
  poitiers: "robin.silva@example.com",
  sahel: "drew.moreau@example.com",
  atlas: "jules.brun@example.com",
  carthage: "drew.moreau@example.com",
  frankfurt: "jules.fischer@example.com",
  tianjin: "robin.bernard@example.com",
  kunshan: "sacha.weber@example.com",
  daegu: "harper.moreau@example.com",
  mexico: "harper.dupuis@example.com"
};
// SAHEL employees' site_dep holds their department, never "SAHEL" (the developer,
// 2026-10-28), so each SAHEL department routes to the SAHEL IT contact as well.
const STS_DEPARTMENTS = [
  "digitale", "chiffrage", "logistique germany", "commerce", "qualité",
  "général", "finance", "achat", "logistique groupe", "siège"
];
STS_DEPARTMENTS.forEach((dep) => { SITE_IT_CONTACTS[dep] = SITE_IT_CONTACTS.sts; });
const DEFAULT_IT_CONTACT = "user717@example.com"; // Group IT Manager

const normalizeSiteKey = (value) =>
  String(value || "").trim().toLowerCase().replace(/^site[-\s]+/, "");

const resolveItContact = (site) => SITE_IT_CONTACTS[normalizeSiteKey(site)] || DEFAULT_IT_CONTACT;

// ==================================================
// STOCKAGE VISA
// - visa-pdfs : uploads PDF (user)
// - visa-generated : docs générés (DOCX)
// ==================================================
const visaPdfDir = path.join(__dirname, "uploads", "visa-pdfs");
const visaGeneratedDir = path.join(__dirname, "uploads", "visa-generated");

for (const dir of [visaPdfDir, visaGeneratedDir]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`📁 Dossier VISA créé: ${dir}`);
  }
}

// ==================================================
// ROUTES POUR SERVIR LES FICHIERS VISA
// ==================================================
app.get("/api/visa-pdfs/:filename", (req, res) => {
  try {
    const filename = path.basename(req.params.filename);
    const filePath = path.join(visaPdfDir, filename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "PDF VISA non trouvé" });
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
    return res.sendFile(filePath);
  } catch (error) {
    console.error("❌ Erreur service PDF VISA:", error);
    return res.status(500).json({ error: "Erreur lors du chargement du PDF VISA" });
  }
});

app.get("/api/visa-generated/:filename", (req, res) => {
  try {
    const filename = path.basename(req.params.filename);
    const filePath = path.join(visaGeneratedDir, filename);
    const dispositionType = req.query.download === "1" ? "attachment" : "inline";

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Fichier VISA généré introuvable" });
    }

    const ext = path.extname(filename).toLowerCase();
    const contentType =
      ext === ".docx"
        ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        : "application/octet-stream";

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `${dispositionType}; filename="${filename}"`);
    return res.sendFile(filePath);
  } catch (error) {
    console.error("❌ Erreur service VISA generated:", error);
    return res.status(500).json({ error: "Erreur lors du chargement du fichier VISA" });
  }
});

function buildVisaPdfUrl(filename) {
  const baseUrl = process.env.BACKEND_URL || `https://your-app.azurewebsites.net`;
  return `${baseUrl}/api/visa-pdfs/${filename}`;
}

function buildVisaGeneratedUrl(filename) {
  const baseUrl = process.env.BACKEND_URL || `https://your-app.azurewebsites.net`;
  return `${baseUrl}/api/visa-generated/${filename}`;
}

function parseVisaStoredFiles(fileUrl, originalFilename) {
  if (!fileUrl) return [];

  try {
    const parsed = JSON.parse(fileUrl);
    if (Array.isArray(parsed)) {
      return parsed;
    }
  } catch (e) {
    // Fallback for legacy single-file values
  }

  if (typeof fileUrl === "string" && fileUrl.trim()) {
    return [
      {
        url: fileUrl,
        originalFilename: originalFilename || "fichier.pdf",
        filename: path.basename(fileUrl),
      },
    ];
  }

  return [];
}

function deleteVisaPdfFiles(files) {
  for (const file of files || []) {
    try {
      const filename = path.basename(file?.filename || file?.url || "");
      if (!filename) continue;

      const filePath = path.join(visaPdfDir, filename);
      const resolved = path.resolve(filePath);
      const resolvedDir = path.resolve(visaPdfDir);

      if (!resolved.startsWith(resolvedDir)) continue;
      if (fs.existsSync(resolved)) {
        fs.unlinkSync(resolved);
      }
    } catch (e) {
      console.warn(`âš ï¸ Impossible de supprimer un ancien PDF VISA: ${e.message}`);
    }
  }
}

// ==================================================
// MULTER VISA (UPLOAD PDF only) — FormData field = pdfFile
// ==================================================
const visaPdfStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, visaPdfDir);
  },
  filename: function (req, file, cb) {
    const originalName = path.basename(file.originalname || "visa.pdf");

    const safeName = originalName
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9.\-_]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "");

    const ext = (path.extname(safeName) || ".pdf").toLowerCase();
    const base = path.basename(safeName, ext) || "visa";

    cb(null, `${base}${ext}`);
  },
});

const visaPdfUpload = multer({
  storage: visaPdfStorage,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB
  fileFilter: function (req, file, cb) {
    if (file.mimetype === "application/pdf") cb(null, true);
    else cb(new Error("Seuls les fichiers PDF sont autorisés!"), false);
  },
});

// ==================================================
// TEMPLATE DOCUMENTS VISA
// ==================================================
function createDocumentsTemplate() {
  return [
    { code: "PASSEPORT_ORIGINAL", label: "Passeport (original)", mode: "PHYSICAL" },
    { code: "PHOTOS", label: "2 photos d'identité", mode: "PHYSICAL" },
    { code: "COPIE_PAGE_1_PASSEPORT", label: "Copie page 1 passeport", mode: "PHYSICAL" },
    { code: "CNSS", label: "Copie Historique CNSS", mode: "UPLOAD" },
    { code: "FICHES_PAIE", label: "3 dernières fiches de paie", mode: "UPLOAD" },

    { code: "ATTESTATION_TRAVAIL", label: "Attestation de travail", mode: "UPLOAD" },
    { code: "ORDRE_MISSION", label: "Ordre de mission", mode: "UPLOAD" },
    { code: "INVITATION", label: "Invitation + prise en charge", mode: "UPLOAD" },
    { code: "FRAIS_VISA", label: "Recepissé", mode: "UPLOAD" },

    { code: "ASSURANCE", label: "Assurance voyage", mode: "UPLOAD" },
    { code: "BILLET_AVION", label: "Billet d'avion", mode: "UPLOAD" },
    { code: "RESERVATION_HOTEL", label: "Réservation d'hôtel", mode: "UPLOAD" },
  ];
}

function safeFilename(str) {
  return String(str || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

function formatDateFR(d) {
  if (!d) return "";
  return new Date(d).toLocaleDateString("fr-FR");
}

// ==================================================
// HELPERS DB VISA
// ==================================================
async function getEmployeeByIdVisa(employeId) {
  const result = await pool.query(
    `SELECT id, nom, prenom, adresse_mail, date_naissance, cin, date_debut, poste, passeport, date_expiration_passport
     FROM employees WHERE id = $1`,
    [employeId]
  );
  if (result.rows.length === 0) throw new Error("Employé non trouvé");
  return result.rows[0];
}

async function getDossierEmailContext(dossierId) {
  const r = await pool.query(
    `SELECT d.id as dossier_id, d.date_depart, d.date_retour, d.motif_deplacement,
            e.id as employee_id, e.prenom, e.nom
     FROM visa_dossiers d
     JOIN employees e ON e.id = d.employee_id
     WHERE d.id = $1`,
    [dossierId]
  );
  if (!r.rows.length) throw new Error("Dossier introuvable");
  const row = r.rows[0];

  return {
    dossierId: row.dossier_id,
    employeeId: row.employee_id,
    employeeName: `${row.prenom} ${row.nom}`,
    departureDate: row.date_depart,
    returnDate: row.date_retour,
    motif: row.motif_deplacement,
  };
}

// ==================================================
// EMAILS VISA (utilise emailTransporter EXISTANT)
// ==================================================
async function sendVisaDossierCreationEmail({ to, employeeName }) {
  if (!to) throw new Error("Email employé manquant");

  const subject = `Dossier Visa – Documents à fournir (${employeeName})`;
  const html = `
    <div style="font-family: Arial, sans-serif; line-height:1.6">
      <p>Bonjour <b>${employeeName}</b>,</p>
      <p>Votre <b>dossier visa</b> a été créé. Merci de préparer les éléments suivants :</p>
      <ul>
        <li><b>Ramener votre passeport (original)</b></li>
        <li><b>Ramener une copie de la page 1 du passeport</b></li>
        <li><b>Ramener 2 photos d'identité</b></li>
        <li><b>Envoyer par mail une copie de l’historique CNSS</b> à
          <a href="mailto:jamie.lambert@example.com">jamie.lambert@example.com</a>
        </li>
      </ul>
      <p>Merci,<br/>${EMAIL_FROM_NAME}</p>
    </div>
  `;

  return emailTransporter.sendMail({
    from: `"${EMAIL_FROM_NAME}" <${EMAIL_FROM}>`,
    to,
    subject,
    html,
  });
}

async function sendOffboardingFormationEmail({ to, employeeName, departureDate }) {
  const subject = `Départ collaborateur – suppression licence LMS – ${employeeName}`;
  const html = `
    <div style="font-family: Arial, sans-serif; line-height:1.6">
      <p>Bonjour,</p>
      <p>Un départ collaborateur a été enregistré pour :</p>
      <p>
        <b>Employé :</b> ${employeeName}<br/>
        <b>Date de départ :</b> ${departureDate || 'Non précisée'}
      </p>
      <p>Merci de désactiver son compte 360Learning (licence LMS).</p>
      <p>Merci,<br/>${EMAIL_FROM_NAME}</p>
    </div>
  `;

  return emailTransporter.sendMail({
    from: `"${EMAIL_FROM_NAME}" <${EMAIL_FROM}>`,
    to,
    subject,
    html,
  });
}

async function sendOffboardingItEmail({
  to,
  employeeName,
  jobTitle,
  department,
  lastWorkingDay,
  reason,
  licencesToCancel,
  equipmentToReturn,
  extraAccess,
}) {
  const subject = `Départ collaborateur – résiliation des accès IT – ${employeeName}`;
  const licenceList = (licencesToCancel && licencesToCancel.length ? licencesToCancel : ["Aucune"])
    .map((item) => `<li>${item}</li>`)
    .join("");
  const equipmentList = (equipmentToReturn && equipmentToReturn.length ? equipmentToReturn : ["Aucun"])
    .map((item) => `<li>${item}</li>`)
    .join("");
  const html = `
    <div style="font-family: Arial, sans-serif; line-height:1.6">
      <p>Bonjour,</p>
      <p>Un départ collaborateur a été enregistré pour :</p>
      <p>
        <b>Employé :</b> ${employeeName}<br/>
        <b>Poste :</b> ${jobTitle || "Non précisé"}<br/>
        <b>Site / Département :</b> ${department || "Non précisé"}<br/>
        <b>Dernier jour travaillé :</b> ${lastWorkingDay || "Non précisée"}<br/>
        <b>Motif :</b> ${reason || "Non précisé"}
      </p>
      <p><b>Licences à résilier :</b></p>
      <ul>${licenceList}</ul>
      <p><b>Matériel à restituer :</b></p>
      <ul>${equipmentList}</ul>
      <p><b>Accès supplémentaires à révoquer :</b> ${extraAccess || "Aucun accès supplémentaire listé."}</p>
      <p>Merci,<br/>${EMAIL_FROM_NAME}</p>
    </div>
  `;

  return emailTransporter.sendMail({
    from: `"${EMAIL_FROM_NAME}" <${EMAIL_FROM}>`,
    to,
    subject,
    html,
  });
}

async function sendAssuranceRequestEmail({ to, employeeName, departureDate, returnDate }) {
  const subject = `Demande Assurance Voyage – ${employeeName}`;
  const html = `
    <div style="font-family: Arial, sans-serif; line-height:1.6">
      <p>Bonjour,</p>
      <p>Merci de <b>fournir l’assurance voyage</b> pour :</p>
      <p>
        <b>Employé :</b> ${employeeName}<br/>
        <b>Date départ :</b> ${departureDate}<br/>
        <b>Date retour :</b> ${returnDate}
      </p>
      <p>Merci,<br/>${EMAIL_FROM_NAME}</p>
    </div>
  `;

  return emailTransporter.sendMail({
    from: `"${EMAIL_FROM_NAME}" <${EMAIL_FROM}>`,
    to,
    subject,
    html,
  });
}

async function sendBilletRequestEmail({ to, employeeName, departureDate, returnDate }) {
  const subject = `Demande Billet d’avion – ${employeeName}`;
  const html = `
    <div style="font-family: Arial, sans-serif; line-height:1.6">
      <p>Bonjour,</p>
      <p>Merci de <b>fournir le billet d’avion</b> pour :</p>
      <p>
        <b>Employé :</b> ${employeeName}<br/>
        <b>Date départ :</b> ${departureDate}<br/>
        <b>Date retour :</b> ${returnDate}
      </p>
      <p>Merci,<br/>${EMAIL_FROM_NAME}</p>
    </div>
  `;

  return emailTransporter.sendMail({
    from: `"${EMAIL_FROM_NAME}" <${EMAIL_FROM}>`,
    to,
    subject,
    html,
  });
}

// ==================================================
// GÉNÉRATION DOCX (SANS LIBREOFFICE)
// ==================================================
function replacePlaceholders(zip, replacements) {
  const files = zip.files;
  Object.keys(files).forEach((fileName) => {
    if (!fileName.endsWith(".xml")) return;
    let xml = files[fileName].asText();
    for (const key in replacements) {
      const value = replacements[key] == null ? "" : String(replacements[key]);
      const regex = new RegExp("\\[" + key + "\\]", "g");
      xml = xml.replace(regex, value);
    }
    zip.file(fileName, xml);
  });
}

function generateDocxFromTemplate(templatePath, replacements) {
  if (!fs.existsSync(templatePath)) {
    throw new Error("Fichier modèle introuvable : " + templatePath);
  }
  const content = fs.readFileSync(templatePath, "binary");
  const zip = new PizZip(content);
  replacePlaceholders(zip, replacements);

  const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
  doc.render();

  return doc.getZip().generate({ type: "nodebuffer" });
}

async function generateDocumentDOCX(templateName, replacements, baseFilename, nomComplet) {
  const templatePath = path.join(__dirname, "templates", templateName);
  const docxBuffer = generateDocxFromTemplate(templatePath, replacements);

  const employeePart = safeFilename(nomComplet);
  const date = new Date().toISOString().split("T")[0];
  const filename = `${baseFilename}_${employeePart}_${date}.docx`;

  return { buffer: docxBuffer, filename };
}

async function saveGeneratedDocxAndUpdateDoc({ buffer, filename, docId }) {
  const outPath = path.join(visaGeneratedDir, filename);
  fs.writeFileSync(outPath, buffer);

  const fileUrl = buildVisaGeneratedUrl(filename);
  const existingDoc = await pool.query(
    `SELECT statut
     FROM visa_documents
     WHERE id = $1`,
    [docId]
  );

  if (!existingDoc.rows.length) {
    throw new Error("Document VISA introuvable");
  }

  const nextStatus = existingDoc.rows[0].statut === "RECEIVED_PHYSICAL" ? "RECEIVED_PHYSICAL" : "GENERATED";

  await pool.query(
    `UPDATE visa_documents
     SET statut = $1,
         file_url = $2,
         original_filename = $3,
         updated_at = now()
     WHERE id = $4`,
    [nextStatus, fileUrl, filename, docId]
  );

  return { fileUrl };
}

function isPdfReference(fileUrl, originalFilename) {
  return /\.pdf($|\?)/i.test(String(fileUrl || "")) || /\.pdf$/i.test(String(originalFilename || ""));
}

async function saveGeneratedInvitationDocAndUpdateDoc({ buffer, filename, docId }) {
  const outPath = path.join(visaGeneratedDir, filename);
  fs.writeFileSync(outPath, buffer);

  const generatedFileUrl = buildVisaGeneratedUrl(filename);
  const existingDoc = await pool.query(
    `SELECT file_url, original_filename, statut
     FROM visa_documents
     WHERE id = $1`,
    [docId]
  );

  if (!existingDoc.rows.length) {
    throw new Error("Document VISA introuvable");
  }

  const current = existingDoc.rows[0];
  const signedFileUrl = isPdfReference(current.file_url, current.original_filename) ? current.file_url : null;
  const signedOriginalFilename = isPdfReference(current.file_url, current.original_filename)
    ? current.original_filename
    : null;
  const nextStatus = current.statut === "RECEIVED_PHYSICAL" ? "RECEIVED_PHYSICAL" : "GENERATED";

  await pool.query(
    `UPDATE visa_documents
     SET generated_file_url = $1,
         generated_original_filename = $2,
         file_url = $3,
         original_filename = $4,
         statut = $5,
         updated_at = now()
     WHERE id = $6`,
    [generatedFileUrl, filename, signedFileUrl, signedOriginalFilename, nextStatus, docId]
  );

  return { generatedFileUrl };
}

// ==================================================
// API Employees (liste employés actifs)
// ==================================================
// Active KPI role names -- the only allowed postes (see kpiRoleHierarchy.js).
// 503 when KPI can't be reached: the frontend then falls back to its built-in list.
app.get('/api/kpi-roles', authenticateToken, async (req, res) => {
  const roles = await listKpiRoles(dbConfig);
  if (!roles) return res.status(503).json({ error: 'KPI indisponible' });
  res.json(roles);
});

// Organigramme from KPI (services/orgChart.js): for every non-SAHEL employee
// this user can see, their KPI role and the employee placed above them
// (keys are "<tenant_schema>:<employee id>"). Employees without an active
// KPI role are not returned. SAHEL keeps its HR chart, which is correct.
app.get('/api/org-chart/links', authenticateToken, async (req, res) => {
  try {
    // SAHEL (public) is included only as possible managers: its own chart stays HR's.
    const schemas = getAccessibleEmployeeSchemas(req.user);
    const visible = [];
    for (const schema of schemas) {
      const rows = (await pool.query(
        `SELECT e.id, e.site_dep, im.people_id, '${schema}' AS tenant_schema
         FROM ${schema}.employees e
         JOIN sync.identity_map im ON im.hr_schema = $1 AND im.matricule = e.matricule
         WHERE e.statut = 'actif' OR e.statut IS NULL`,
        [schema]
      )).rows;
      visible.push(...filterEmployeesBySiteScope(req.user, rows));
    }
    // every HR <-> KPI link, to know which company each KPI work site belongs to
    const hrSchemaOf = new Map((await pool.query('SELECT hr_schema, people_id FROM sync.identity_map')).rows
      .map((r) => [Number(r.people_id), r.hr_schema]));
    const chart = await buildOrgChartLinks(
      getKpiPool(dbConfig),
      visible.map((e) => ({ ...e, key: `${e.tenant_schema}:${e.id}` })),
      hrSchemaOf
    ).catch((error) => {
      console.error('⚠️ Organigramme KPI indisponible:', error.message);
      return null;
    });
    if (!chart) return res.status(503).json({ error: 'KPI indisponible' });
    res.json(chart);
  } catch (error) {
    console.error('❌ /api/org-chart/links:', error);
    res.status(500).json({ error: error.message });
  }
});

// Group organization chart: KPI's G7 / G6 roles (VP, Director), the same for
// every login -- see buildGroupChart.
app.get('/api/org-chart/group', authenticateToken, async (req, res) => {
  try {
    res.json(await buildGroupChart(getKpiPool(dbConfig)));
  } catch (error) {
    console.error('⚠️ Organigramme groupe KPI indisponible:', error.message);
    res.status(503).json({ error: 'KPI indisponible' });
  }
});

app.get("/api/employee", authenticateToken, async (req, res) => {
  try {
    const schema = getSchemaForUser(req.user);
    const siteScope = siteScopeSql(req.user, 'e', 1);
    const result = await pool.query(
      `SELECT id, nom, prenom, poste, statut
       FROM ${schema}.employees e
       WHERE statut = 'actif'${siteScope.sql}
       ORDER BY nom, prenom`,
      siteScope.params
    );
    res.json(result.rows);
  } catch (err) {
    console.error("❌ /api/employee error:", err);
    res.status(500).json({ message: err.message });
  }
});


// ==================================================
// ===================== ROUTES VISA =================
// ==================================================

// Liste dossiers VISA
app.get("/api/visa-dossiers", authenticateToken, requireTunisiaTenant, async (req, res) => {
  try {
    const result = await tenantDb(req).query(`
      SELECT 
        d.id,
        d.employee_id,
        d.date_depart,
        d.date_retour,
        d.motif_deplacement,
        d.destination,
        d.statut,
        d.numero_visa,
        d.visa_date_debut,
        d.visa_date_fin,
        d.created_at,
        d.updated_at,
        e.prenom,
        e.nom,
        e.poste,
        COUNT(vd.id)::int AS total_docs,
        COALESCE(SUM(
          CASE
            WHEN vd.statut = 'RECEIVED_PHYSICAL' THEN 1
            WHEN vd.mode = 'UPLOAD' AND vd.statut = 'UPLOADED' THEN 1
            ELSE 0
          END
        ), 0)::int AS ok_docs
      FROM visa_dossiers d
      JOIN employees e ON e.id = d.employee_id
      LEFT JOIN visa_documents vd ON vd.dossier_id = d.id
      GROUP BY d.id, e.prenom, e.nom, e.poste
      ORDER BY d.created_at DESC
    `);

    const dossiers = result.rows.map((r) => {
      const totalDocs = Number(r.total_docs || 0);
      const okDocs = Number(r.ok_docs || 0);
      const percent = totalDocs > 0 ? Math.round((okDocs / totalDocs) * 100) : 0;

      return {
        id: r.id,
        employee: {
          id: r.employee_id,
          name: `${r.prenom} ${r.nom}`,
          poste: r.poste || "",
          department: r.departement || "",
        },
        departureDate: r.date_depart,
        returnDate: r.date_retour,
        motif: r.motif_deplacement,
        destination: r.destination,
        status: r.statut,
        visa: {
          numero: r.numero_visa,
          dateDebut: r.visa_date_debut,
          dateFin: r.visa_date_fin,
        },
        progress: { okDocs, totalDocs, percent },
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
    });

    res.json(dossiers);
  } catch (err) {
    console.error("❌ /api/visa-dossiers error:", err);
    res.status(500).json({ message: err.message });
  }
});

// Dossier VISA détail
app.get("/api/visa-dossiers/:id", authenticateToken, requireTunisiaTenant, async (req, res) => {
  const dossierId = Number(req.params.id);
  try {
    const dRes = await tenantDb(req).query(
      `SELECT d.*, e.prenom, e.nom, e.poste
       FROM visa_dossiers d
       JOIN employees e ON e.id = d.employee_id
       WHERE d.id = $1`,
      [dossierId]
    );
    if (!dRes.rows.length) return res.status(404).json({ message: "Dossier introuvable" });

    const r = dRes.rows[0];

    const docsRes = await tenantDb(req).query(
      `SELECT *
       FROM visa_documents
       WHERE dossier_id = $1
       ORDER BY id`,
      [dossierId]
    );

    const dossier = {
      id: r.id,
      employee: {
        id: r.employee_id,
        name: `${r.prenom} ${r.nom}`,
        poste: r.poste || "",
        department: r.departement || "",
      },
      departureDate: r.date_depart,
      returnDate: r.date_retour,
      motif: r.motif_deplacement,
      destination: r.destination,
      status: r.statut,
      documents: docsRes.rows.map((d) => ({
        id: d.id,
        code: d.code,
        label: d.label,
        mode: d.mode,
        status: d.statut,
        fileUrl: d.file_url,
        originalFilename: d.original_filename,
        generatedFileUrl: d.generated_file_url,
        generatedOriginalFilename: d.generated_original_filename,
      })),
    };

    res.json(dossier);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Créer dossier VISA + template + email employé
app.post("/api/visa-dossiers", authenticateToken, requireTunisiaTenant, async (req, res) => {
  const { employeeId, motif, departureDate, returnDate, destination } = req.body;

  if (!employeeId || !motif || !departureDate || !returnDate || !destination) {
    return res.status(400).json({ message: "Champs manquants" });
  }
  if (returnDate < departureDate) {
    return res.status(400).json({ message: "date_retour doit être >= date_depart" });
  }

  const client = await tenantDb(req).connect();
  try {
    await client.query("BEGIN");

    const dIns = await client.query(
      `INSERT INTO visa_dossiers (employee_id, motif_deplacement, date_depart, date_retour, destination)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id`,
      [employeeId, motif, departureDate, returnDate, destination]
    );
    const dossierId = dIns.rows[0].id;

    const template = createDocumentsTemplate();
    for (const doc of template) {
      await client.query(
        `INSERT INTO visa_documents (dossier_id, code, label, mode, statut)
         VALUES ($1,$2,$3,$4,'MISSING')`,
        [dossierId, doc.code, doc.label, doc.mode]
      );
    }

    await client.query("COMMIT");

    let emailSent = false;
    let emailError = null;

    try {
      const emp = await getEmployeeByIdVisa(employeeId);
      await sendVisaDossierCreationEmail({
        to: emp.adresse_mail,
        employeeName: `${emp.prenom} ${emp.nom}`,
      });
      emailSent = true;
    } catch (e) {
      emailError = e.message;
      console.error("❌ Erreur envoi email dossier:", e.message);
    }

    res.json({ id: dossierId, emailSent, emailError });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ message: err.message });
  } finally {
    client.release();
  }
});

// Upload document VISA (PDF) — FormData field = pdfFile (single) or pdfFiles (multiple for FICHES_PAIE)
app.post(
  "/api/visa-documents/:id/upload",
  authenticateToken,
  requireTunisiaTenant,
  visaPdfUpload.any(),
  async (req, res) => {
    const docId = Number(req.params.id);

    try {
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ success: false, error: "Aucun fichier PDF téléchargé" });
      }

      const docResult = await tenantDb(req).query(
        `SELECT code, file_url, original_filename
         FROM visa_documents
         WHERE id = $1`,
        [docId]
      );

      if (!docResult.rows.length) {
        return res.status(404).json({ success: false, error: "Document non trouvé" });
      }

      const doc = docResult.rows[0];

      if (doc.code === "FICHES_PAIE") {
        const existingFiles = parseVisaStoredFiles(doc.file_url, doc.original_filename);

        const newFiles = req.files.map((file) => ({
          url: buildVisaPdfUrl(file.filename),
          originalFilename: file.originalname,
          filename: file.filename,
        }));

        const shouldReplaceExisting = existingFiles.length >= 3 || existingFiles.length + newFiles.length > 3;
        if (shouldReplaceExisting) {
          deleteVisaPdfFiles(existingFiles);
        }

        const filesArray = shouldReplaceExisting ? newFiles : [...existingFiles, ...newFiles];
        const originalFilenames = filesArray.map((file) => file.originalFilename).join(", ");

        await tenantDb(req).query(
          `UPDATE visa_documents
           SET statut = 'UPLOADED',
               file_url = $1,
               original_filename = $2,
               updated_at = now()
           WHERE id = $3`,
          [JSON.stringify(filesArray), originalFilenames, docId]
        );

        return res.json({
          success: true,
          fileUrl: JSON.stringify(filesArray),
          originalFilename: originalFilenames,
          files: filesArray,
        });
      } else {
        // Pour fichier unique
        const file = req.files[0];
        const fileUrl = buildVisaPdfUrl(file.filename);

        await tenantDb(req).query(
          `UPDATE visa_documents
           SET statut = 'UPLOADED',
               file_url = $1,
               original_filename = $2,
               updated_at = now()
           WHERE id = $3`,
          [fileUrl, file.originalname, docId]
        );

        return res.json({
          success: true,
          fileUrl,
          originalFilename: file.originalname,
          filename: file.filename,
        });
      }
    } catch (err) {
      console.error("❌ upload visa doc error:", err);
      return res.status(500).json({ message: err.message });
    }
  }
);

// Mettre à jour doc (statut / url)
app.patch("/api/visa-documents/:id", authenticateToken, requireTunisiaTenant, async (req, res) => {
  const docId = Number(req.params.id);
  const { status, fileUrl, originalFilename } = req.body;

  if (!status) return res.status(400).json({ message: "status obligatoire" });

  try {
    await tenantDb(req).query(
      `UPDATE visa_documents
       SET statut = $1,
           file_url = COALESCE($2, file_url),
           original_filename = COALESCE($3, original_filename),
           updated_at = now()
       WHERE id = $4`,
      [status, fileUrl || null, originalFilename || null, docId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Envoyer mail départ collaborateur -> équipe formation (suppression licence LMS)
app.post("/api/email/offboarding-formation", authenticateToken, async (req, res) => {
  try {
    const { employeeName, departureDate } = req.body;
    if (!employeeName) return res.status(400).json({ message: "employeeName obligatoire" });

    await sendOffboardingFormationEmail({
      to: FORMATION_REQUEST_TO,
      employeeName,
      departureDate,
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// Envoyer mail départ collaborateur -> IT du site (résiliation licences/matériel)
app.post("/api/email/offboarding-it", authenticateToken, async (req, res) => {
  try {
    const {
      employeeName,
      jobTitle,
      department,
      site,
      lastWorkingDay,
      reason,
      licencesToCancel,
      equipmentToReturn,
      extraAccess,
    } = req.body;
    if (!employeeName) return res.status(400).json({ message: "employeeName obligatoire" });

    await sendOffboardingItEmail({
      to: resolveItContact(site || department),
      employeeName,
      jobTitle,
      department,
      lastWorkingDay,
      reason,
      licencesToCancel,
      equipmentToReturn,
      extraAccess,
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// Envoyer mail assurance
app.post("/api/email/assurance", authenticateToken, requireTunisiaTenant, async (req, res) => {
  try {
    const { dossierId } = req.body;
    if (!dossierId) return res.status(400).json({ message: "dossierId obligatoire" });

    const ctx = await getDossierEmailContext(Number(dossierId));
    await sendAssuranceRequestEmail({
      to: ASSURANCE_REQUEST_TO,
      employeeName: ctx.employeeName,
      departureDate: ctx.departureDate,
      returnDate: ctx.returnDate,
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// Envoyer mail billet
app.post("/api/email/billet", authenticateToken, requireTunisiaTenant, async (req, res) => {
  try {
    const { dossierId } = req.body;
    if (!dossierId) return res.status(400).json({ message: "dossierId obligatoire" });

    const ctx = await getDossierEmailContext(Number(dossierId));
    await sendBilletRequestEmail({
      to: BILLET_REQUEST_TO,
      employeeName: ctx.employeeName,
      departureDate: ctx.departureDate,
      returnDate: ctx.returnDate,
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// Changer statut dossier VISA
app.patch("/api/visa-dossiers/:id/status", authenticateToken, requireTunisiaTenant, async (req, res) => {
  const dossierId = Number(req.params.id);
  const { status, visaNumero, visaDateDebut, visaDateFin } = req.body;

  if (!status) return res.status(400).json({ message: "status obligatoire" });

  try {
    await tenantDb(req).query(
      `UPDATE visa_dossiers
       SET statut = $1,
           numero_visa = COALESCE($2, numero_visa),
           visa_date_debut = COALESCE($3, visa_date_debut),
           visa_date_fin = COALESCE($4, visa_date_fin),
           updated_at = now()
       WHERE id = $5`,
      [status, visaNumero || null, visaDateDebut || null, visaDateFin || null, dossierId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});
// DELETE dossier VISA (abandonner)
app.delete("/api/visa-dossiers/:id", authenticateToken, requireTunisiaTenant, async (req, res) => {
  const dossierId = Number(req.params.id);
  const client = await tenantDb(req).connect();
  
  try {
    await client.query("BEGIN");
    
    // Check if dossier exists and get info for logging
    const checkResult = await client.query(
      `SELECT d.id, d.statut, e.nom, e.prenom 
       FROM visa_dossiers d
       JOIN employees e ON e.id = d.employee_id
       WHERE d.id = $1`,
      [dossierId]
    );
    
    if (checkResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ 
        success: false, 
        message: "Dossier VISA non trouvé" 
      });
    }
    
    const dossier = checkResult.rows[0];
    
    // Optional: Restrict deletion to only EN_COURS status
    if (dossier.statut !== 'EN_COURS') {
      await client.query("ROLLBACK");
      return res.status(400).json({ 
        success: false, 
        message: "Seuls les dossiers en cours (EN_COURS) peuvent être supprimés" 
      });
    }
    
    // Get all documents to clean up PDF files
    const docsResult = await client.query(
      `SELECT file_url, generated_file_url FROM visa_documents WHERE dossier_id = $1`,
      [dossierId]
    );
    
    // Delete related documents from database
    await client.query("DELETE FROM visa_documents WHERE dossier_id = $1", [dossierId]);
    
    // Delete the dossier
    await client.query("DELETE FROM visa_dossiers WHERE id = $1", [dossierId]);
    
    await client.query("COMMIT");
    
    // Clean up PDF files from filesystem (optional, after successful DB deletion)
    for (const doc of docsResult.rows) {
      if (doc.file_url) {
        try {
          // Extract filename from URL
          const urlParts = doc.file_url.split('/');
          const filename = urlParts[urlParts.length - 1];
          const filePath = path.join(visaPdfDir, filename);
          
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`🗑️ Fichier PDF supprimé: ${filename}`);
          }
        } catch (fileError) {
          console.warn(`⚠️ Impossible de supprimer le fichier PDF: ${fileError.message}`);
        }
      }
    }
    
    console.log(`✅ Dossier VISA ${dossierId} supprimé (${dossier.prenom} ${dossier.nom})`);
    
    res.json({ 
      success: true, 
      message: "Dossier VISA supprimé avec succès" 
    });
    
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Erreur suppression dossier VISA:", err);
    res.status(500).json({ 
      success: false, 
      message: err.message || "Erreur lors de la suppression du dossier" 
    });
  } finally {
    client.release();
  }
});

// ==================================================
// RAPPELS AUTOMATIQUES — EXPIRATION VISA
// ==================================================
const VISA_REMINDER_EMAIL = "jamie.lambert@example.com";
const VISA_RENEWAL_ACTIVE_STATUSES = ["EN_COURS", "PRET_POUR_DEPOT"];

function formatVisaDate(value) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("fr-FR");
}

// Un renouvellement est "en cours" dès qu'un autre dossier VISA existe pour le
// même employé avec un statut actif — sert à annuler les rappels de l'ancien visa.
async function hasActiveVisaRenewal(employeeId, currentDossierId) {
  const result = await pool.query(
    `SELECT 1 FROM visa_dossiers
     WHERE employee_id = $1
       AND id <> $2
       AND statut::text = ANY($3::text[])
     LIMIT 1`,
    [employeeId, currentDossierId, VISA_RENEWAL_ACTIVE_STATUSES]
  );
  return result.rows.length > 0;
}

async function sendVisaOneMonthReminderEmail({ employeeName, visaDateFin }) {
  const formattedDate = formatVisaDate(visaDateFin);
  const subject = `Visa expirant dans 30 jours - ${employeeName}`;
  const html = `
    <div style="font-family: Arial, sans-serif; line-height:1.6">
      <p>Bonjour,</p>
      <p>Le visa de <b>${escapeHtml(employeeName)}</b> arrive à expiration le <b>${formattedDate}</b>.</p>
      <p>Il reste <b>un mois</b> avant l'expiration de ce visa.</p>
      <p>Il est recommandé de <b>lancer dès maintenant une nouvelle demande de visa</b> pour cet employé.</p>
      <p>Ceci est un message automatique du système RH.</p>
    </div>
  `;
  return sendEmail(VISA_REMINDER_EMAIL, subject, html);
}

async function sendVisaExpiredTodayEmail({ employeeName, visaDateFin }) {
  const formattedDate = formatVisaDate(visaDateFin);
  const subject = `Visa expirant aujourd'hui - ${employeeName}`;
  const html = `
    <div style="font-family: Arial, sans-serif; line-height:1.6">
      <p>Bonjour,</p>
      <p>Le visa de <b>${escapeHtml(employeeName)}</b> expire <b>aujourd'hui (${formattedDate})</b>.</p>
      <p>Ceci est un message automatique du système RH.</p>
    </div>
  `;
  return sendEmail(VISA_REMINDER_EMAIL, subject, html);
}

// Job quotidien : dossiers VISA_ACCORDE nécessitant un rappel 30 jours ou expiration.
// Les colonnes *_reminder_sent garantissent l'idempotence même en cas d'exécutions multiples.
// Les bornes "<=" (plutôt qu'une égalité stricte) rattrapent un jour manqué si le
// serveur était indisponible exactement à la date pivot.
async function checkVisaExpiryReminders() {
  try {
    console.log("🔔 Vérification des rappels d'expiration VISA...");

    const oneMonthDue = await pool.query(
      `SELECT d.id, d.employee_id, d.visa_date_fin, e.prenom, e.nom
       FROM visa_dossiers d
       JOIN employees e ON e.id = d.employee_id
       WHERE d.statut = 'VISA_ACCORDE'
         AND d.visa_date_fin IS NOT NULL
         AND d.one_month_reminder_sent = FALSE
         AND (d.visa_date_fin::date - INTERVAL '30 days') <= CURRENT_DATE
         AND d.visa_date_fin::date >= CURRENT_DATE`
    );

    for (const dossier of oneMonthDue.rows) {
      const employeeName = `${dossier.prenom} ${dossier.nom}`;
      try {
        if (await hasActiveVisaRenewal(dossier.employee_id, dossier.id)) {
          console.log(`↪️ Rappel 30 jours ignoré (renouvellement en cours) pour ${employeeName} (dossier #${dossier.id})`);
          continue;
        }
        await sendVisaOneMonthReminderEmail({ employeeName, visaDateFin: dossier.visa_date_fin });
        await pool.query(
          `UPDATE visa_dossiers SET one_month_reminder_sent = TRUE, one_month_reminder_sent_at = now() WHERE id = $1`,
          [dossier.id]
        );
        console.log(`✅ Rappel 30 jours envoyé pour ${employeeName} (dossier #${dossier.id})`);
      } catch (innerErr) {
        console.error(`❌ Erreur rappel 30 jours VISA dossier #${dossier.id}:`, innerErr.message);
      }
    }

    const expiryDue = await pool.query(
      `SELECT d.id, d.employee_id, d.visa_date_fin, e.prenom, e.nom
       FROM visa_dossiers d
       JOIN employees e ON e.id = d.employee_id
       WHERE d.statut = 'VISA_ACCORDE'
         AND d.visa_date_fin IS NOT NULL
         AND d.expiry_reminder_sent = FALSE
         AND d.visa_date_fin::date <= CURRENT_DATE`
    );

    for (const dossier of expiryDue.rows) {
      const employeeName = `${dossier.prenom} ${dossier.nom}`;
      try {
        if (await hasActiveVisaRenewal(dossier.employee_id, dossier.id)) {
          // Renouvellement déjà lancé : le rappel d'expiration de l'ancien visa est annulé.
          await pool.query(
            `UPDATE visa_dossiers SET expiry_reminder_sent = TRUE, expiry_reminder_sent_at = now() WHERE id = $1`,
            [dossier.id]
          );
          console.log(`↪️ Rappel expiration annulé (renouvellement en cours) pour ${employeeName} (dossier #${dossier.id})`);
          continue;
        }
        await sendVisaExpiredTodayEmail({ employeeName, visaDateFin: dossier.visa_date_fin });
        await pool.query(
          `UPDATE visa_dossiers SET expiry_reminder_sent = TRUE, expiry_reminder_sent_at = now() WHERE id = $1`,
          [dossier.id]
        );
        console.log(`✅ Rappel expiration envoyé pour ${employeeName} (dossier #${dossier.id})`);
      } catch (innerErr) {
        console.error(`❌ Erreur rappel expiration VISA dossier #${dossier.id}:`, innerErr.message);
      }
    }
  } catch (err) {
    console.error("❌ Erreur vérification rappels VISA:", err.message);
  }
}

// Vérification au démarrage (rattrape une période d'indisponibilité du serveur)
setTimeout(() => {
  checkVisaExpiryReminders();
}, 15000);

// Vérification quotidienne à 8h05
setInterval(() => {
  const now = new Date();
  if (now.getHours() === 8 && now.getMinutes() === 5) {
    checkVisaExpiryReminders();
  }
}, 60000);

// Déclenchement manuel pour tests
app.get("/api/visa-reminders/trigger", authenticateToken, async (req, res) => {
  try {
    await checkVisaExpiryReminders();
    res.json({ success: true, message: "Vérification des rappels VISA exécutée" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==================================================
// ✅ ROUTES GÉNÉRATION (DOCX) — sans LibreOffice
// ==================================================

// Générer attestation de travail (DOCX)
app.post("/api/attestation-travail", authenticateToken, requireTunisiaTenant, async (req, res) => {
  const { employeId, docId } = req.body;
  if (!employeId || !docId) return res.status(400).json({ message: "employeId et docId obligatoires" });

  try {
    const emp = await getEmployeeByIdVisa(employeId);
    const nomComplet = `${emp.prenom} ${emp.nom}`;
    const todayStr = new Date().toLocaleDateString("fr-FR");

    const replacements = {
      1: nomComplet,
      2: formatDateFR(emp.date_naissance),
      3: emp.cin || "",
      4: formatDateFR(emp.date_debut),
      5: emp.poste || "",
      6: todayStr,
    };

    const docxResult = await generateDocumentDOCX(
      "Attestation de travail Modèle IA.docx",
      replacements,
      "attestation_travail",
      nomComplet
    );

    const { fileUrl } = await saveGeneratedDocxAndUpdateDoc({
      buffer: docxResult.buffer,
      filename: docxResult.filename,
      docId,
    });

    res.json({ fileUrl, filename: docxResult.filename });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Générer invitation + prise en charge (DOCX)
app.post("/api/invitation-prise-en-charge", authenticateToken, requireTunisiaTenant, async (req, res) => {
  const { employeId, dateDebutSejour, dateFinSejour, docId } = req.body;
  if (!employeId || !dateDebutSejour || !dateFinSejour || !docId) {
    return res.status(400).json({ message: "employeId, dates, docId obligatoires" });
  }

  try {
    const emp = await getEmployeeByIdVisa(employeId);
    const nomComplet = `${emp.prenom} ${emp.nom}`;
    const todayStr = new Date().toLocaleDateString("fr-FR");

    const replacements = {
      1: todayStr,
      2: nomComplet,
      3: formatDateFR(dateDebutSejour),
      4: formatDateFR(dateFinSejour),
      5: nomComplet,
      6: emp.passeport || "",
      7: formatDateFR(emp.date_expiration_passport),
      8: nomComplet,
      9: nomComplet,
    };

    const docxResult = await generateDocumentDOCX(
      "Invitation et prise en charge Modèle IA.docx",
      replacements,
      "invitation_prise_en_charge",
      nomComplet
    );

    const { generatedFileUrl } = await saveGeneratedInvitationDocAndUpdateDoc({
      buffer: docxResult.buffer,
      filename: docxResult.filename,
      docId,
    });

    res.json({ generatedFileUrl, fileUrl: generatedFileUrl, filename: docxResult.filename });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Générer ordre de mission (DOCX)
app.post("/api/ordre-mission", authenticateToken, requireTunisiaTenant, async (req, res) => {
  const { employeId, objectifMission, dateDebutMission, dateFinMission, docId } = req.body;
  if (!employeId || !objectifMission || !dateDebutMission || !dateFinMission || !docId) {
    return res.status(400).json({ message: "champs obligatoires manquants" });
  }

  try {
    const emp = await getEmployeeByIdVisa(employeId);
    const nomComplet = `${emp.prenom} ${emp.nom}`;
    const todayStr = new Date().toLocaleDateString("fr-FR");

    const replacements = {
      1: nomComplet,
      2: emp.passeport || "",
      3: formatDateFR(emp.date_expiration_passport),
      4: emp.poste || "",
      5: objectifMission,
      6: formatDateFR(dateDebutMission),
      7: formatDateFR(dateFinMission),
      8: todayStr,
    };

    const docxResult = await generateDocumentDOCX(
      "Ordre de mission Modèle IA.docx",
      replacements,
      "ordre_mission",
      nomComplet
    );

    const { fileUrl } = await saveGeneratedDocxAndUpdateDoc({
      buffer: docxResult.buffer,
      filename: docxResult.filename,
      docId,
    });

    res.json({ fileUrl, filename: docxResult.filename });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// =============================================================
// CHANGER STATUT : Approuvé → Refusé (manager changed mind)
// =============================================================
app.post('/api/demandes/:id/changer-statut-refuse', authenticateToken, requireDemandeInSiteScope, async (req, res) => {
  const { id } = req.params;
  const { commentaire } = req.body;

  console.log(`🔄 [APP] Changement statut → refusé, demande ${id}`);

  if (!commentaire || !commentaire.trim()) {
    return res.status(400).json({ success: false, error: 'Le motif du refus est obligatoire' });
  }

  try {
    const result = await pool.query(
      `SELECT d.*, e.nom, e.prenom, e.adresse_mail, e.poste, e.matricule
       FROM demande_rh d
       JOIN employees e ON d.employe_id = e.id
       WHERE d.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Demande non trouvée' });
    }

    const demande = result.rows[0];

    if (!isTunisiaTenantUser(req.user)) {
      return res.status(403).json({
        success: false,
        error: 'Vous n’êtes pas autorisé à modifier cette demande.'
      });
    }

    if (demande.statut !== 'approuve') {
      return res.status(400).json({
        success: false,
        error: `Cette demande n'est pas dans le statut approuvé (statut actuel: ${demande.statut})`
      });
    }

    await pool.query(
      `UPDATE demande_rh
       SET statut = 'refuse',
           approuve_responsable1 = false,
           approuve_responsable2 = false,
           commentaire_refus = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [commentaire.trim(), id]
    );

    const typeLabel =
      demande.type_demande === 'conges' ? 'Congé' :
      demande.type_demande === 'autorisation' ? 'Autorisation' : 'Mission';

    // Email à l'employé
    try {
      await sendEmail(
        demande.adresse_mail,
        '🔄 Mise à jour de votre demande RH',
        `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #dc2626; border-bottom: 3px solid #dc2626; padding-bottom: 10px;">
            🔄 Statut de votre demande modifié
          </h2>
          <div style="background: #fef2f2; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #dc2626;">
            <p><strong>Bonjour ${demande.prenom} ${demande.nom},</strong></p>
            <p>Le statut de votre demande a été modifié de <strong>Approuvé</strong> à <strong style="color:#dc2626;">Refusé</strong>.</p>
          </div>
          <div style="background: #f8fafc; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <p><strong>Type :</strong> ${typeLabel}</p>
            <p><strong>Motif :</strong> ${demande.titre}</p>
            <p><strong>Date de départ :</strong> ${formatDateShortApp(demande.date_depart)}</p>
          </div>
          <div style="background: #fef2f2; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #dc2626;">
            <p style="margin: 0;"><strong>💬 Motif du refus :</strong></p>
            <p style="margin: 8px 0 0 0; color: #374151;">${commentaire.trim()}</p>
          </div>
          <p style="color: #6b7280; font-size: 14px;">Pour toute question, contactez le service RH.</p>
        </div>
        `
      );
      console.log(`📧 Email changement → refusé envoyé à ${demande.adresse_mail}`);
    } catch (emailErr) {
      console.error('❌ Erreur email changement statut → refusé:', emailErr.message);
    }

    console.log(`✅ Demande ${id} changée en refusé depuis l'application`);
    res.json({ success: true, message: 'Statut changé en refusé avec succès' });

  } catch (err) {
    console.error('❌ Erreur changement statut → refusé:', err);
    res.status(500).json({ success: false, error: 'Erreur lors du changement de statut', details: err.message });
  }
});

// =============================================================
// CHANGER STATUT : Refusé → Approuvé (manager changed mind)
// =============================================================
app.post('/api/demandes/:id/changer-statut-approuve', authenticateToken, requireDemandeInSiteScope, async (req, res) => {
  const { id } = req.params;

  console.log(`🔄 [APP] Changement statut → approuvé, demande ${id}`);

  try {
    const result = await pool.query(
      `SELECT d.*, e.nom, e.prenom, e.adresse_mail, e.poste, e.matricule
       FROM demande_rh d
       JOIN employees e ON d.employe_id = e.id
       WHERE d.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Demande non trouvée' });
    }

    const demande = result.rows[0];

    if (!isTunisiaTenantUser(req.user)) {
      return res.status(403).json({
        success: false,
        error: 'Vous n’êtes pas autorisé à modifier cette demande.'
      });
    }

    if (demande.statut !== 'refuse') {
      return res.status(400).json({
        success: false,
        error: `Cette demande n'est pas dans le statut refusé (statut actuel: ${demande.statut})`
      });
    }

    await pool.query(
      `UPDATE demande_rh
       SET statut = 'approuve',
           approuve_responsable1 = true,
           approuve_responsable2 = true,
           commentaire_refus = NULL,
           updated_at = CURRENT_TIMESTAMP,
           approved_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [id]
    );

    const typeLabel =
      demande.type_demande === 'conges' ? 'Congé' :
      demande.type_demande === 'autorisation' ? 'Autorisation' : 'Mission';

    // Email à l'employé
    try {
      await sendEmail(
        demande.adresse_mail,
        '🔄 Mise à jour de votre demande RH',
        `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #16a34a; border-bottom: 3px solid #16a34a; padding-bottom: 10px;">
            🔄 Statut de votre demande modifié
          </h2>
          <div style="background: #f0fdf4; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #16a34a;">
            <p><strong>Bonjour ${demande.prenom} ${demande.nom},</strong></p>
            <p>Le statut de votre demande a été modifié de <strong>Refusé</strong> à <strong style="color:#16a34a;">Approuvé</strong>.</p>
          </div>
          <div style="background: #f8fafc; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <p><strong>Type :</strong> ${typeLabel}</p>
            <p><strong>Motif :</strong> ${demande.titre}</p>
            <p><strong>Date de départ :</strong> ${formatDateShortApp(demande.date_depart)}</p>
            ${demande.date_retour ? `<p><strong>Date de retour :</strong> ${formatDateShortApp(demande.date_retour)}</p>` : ''}
          </div>
          <p style="color: #6b7280; font-size: 14px;">Bonne continuation !</p>
        </div>
        `
      );
      console.log(`📧 Email changement → approuvé envoyé à ${demande.adresse_mail}`);
    } catch (emailErr) {
      console.error('❌ Erreur email changement statut → approuvé:', emailErr.message);
    }

    console.log(`✅ Demande ${id} changée en approuvé depuis l'application`);
    res.json({ success: true, message: 'Statut changé en approuvé avec succès' });

  } catch (err) {
    console.error('❌ Erreur changement statut → approuvé:', err);
    res.status(500).json({ success: false, error: 'Erreur lors du changement de statut', details: err.message });
  }
});



// =============================================================
// ✅ NOUVELLES ROUTES : APPROUVER / REFUSER DEPUIS L'APPLICATION
// Coller dans server.js JUSTE AVANT le bloc "Fallback & erreurs"
// c'est-à-dire juste avant : app.use('*', (req, res) => { ...
// =============================================================

function formatDateShortApp(date) {
  if (!date) return '';
  const d = new Date(date);
  if (isNaN(d.getTime())) return String(date);
  return d.toLocaleDateString('fr-FR');
}

const EXTRA_TYPE_CONGE_LABELS_APP = {
  rtt: 'RTT',
  casual: 'Congé occasionnel',
  sick: 'Congé maladie',
  personal: 'Congé personnel',
  incapacidad: 'Incapacité médicale',
  permiso: 'Permission',
  family_event: 'Congé événement familial',
  family_reasons: 'Congé pour raisons familiales'
};

function getTypeCongeTextApp(type_conge, type_conge_autre) {
  if (!type_conge) return '';
  if (type_conge === 'annuel') return 'Congé annuel';
  if (type_conge === 'sans_solde') return 'Congé sans solde';
  if (type_conge === 'autre') return `Autre${type_conge_autre ? ` (${type_conge_autre})` : ''}`;
  return EXTRA_TYPE_CONGE_LABELS_APP[type_conge] || type_conge;
}

// ==================== FONCTION DE GÉNÉRATION PDF POUR L'ÉQUIPE RH ====================
async function genererPDFDemandeApprouvee(demande, joursOuvres = 0) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFKitDocument({
        size: 'A4',
        margins: { top: 50, bottom: 50, left: 50, right: 50 }
      });

      const chunks = [];
      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // En-tête
      doc.rect(0, 0, doc.page.width, 80).fill('#1976d2');
      doc.fillColor('#ffffff')
        .fontSize(24)
        .font('Helvetica-Bold')
        .text('Demande RH Approuvée', 50, 30, { align: 'center' });
      doc.fillColor('#000000');

      // Bannière d'information
      doc.rect(50, 100, doc.page.width - 100, 60)
        .fillAndStroke('#e3f2fd', '#1976d2');
      doc.fillColor('#1565c0')
        .fontSize(12)
        .font('Helvetica-Bold')
        .text('Une demande RH vient d\'être approuvée', 60, 115)
        .font('Helvetica')
        .text('Cette demande nécessite votre attention pour le suivi administratif.', 60, 135);

      let yPosition = 180;

      // Informations Employé
      doc.fontSize(16)
        .font('Helvetica-Bold')
        .fillColor('#1976d2')
        .text('Informations Employé', 50, yPosition);

      yPosition += 25;
      doc.moveTo(50, yPosition).lineTo(doc.page.width - 50, yPosition).stroke('#e0e0e0');
      yPosition += 15;

      const employeInfo = [
        { label: 'Nom complet:', value: `${demande.nom} ${demande.prenom}` },
        { label: 'Matricule:', value: demande.matricule || 'Non spécifié' },
        { label: 'Poste:', value: demande.poste || 'Non spécifié' },
        { label: 'Email:', value: demande.adresse_mail }
      ];

      employeInfo.forEach(info => {
        doc.fontSize(11)
          .font('Helvetica-Bold')
          .text(info.label, 60, yPosition, { width: 150, continued: true })
          .font('Helvetica')
          .text(info.value, { width: 350 });
        yPosition += 20;
      });

      yPosition += 15;

      // Détails de la Demande
      doc.fontSize(16)
        .font('Helvetica-Bold')
        .fillColor('#1976d2')
        .text('Détails de la Demande', 50, yPosition);

      yPosition += 25;
      doc.moveTo(50, yPosition).lineTo(doc.page.width - 50, yPosition).stroke('#e0e0e0');
      yPosition += 15;

      const typeDemandeLabel = demande.type_demande === 'conges' ? 'Congé' :
        demande.type_demande === 'autorisation' ? 'Autorisation' : 'Mission';

      const typeCongeLabel = demande.type_demande === 'conges'
        ? (demande.type_conge === 'annuel' ? 'Congé annuel' :
           demande.type_conge === 'sans_solde' ? 'Congé sans solde' :
           demande.type_conge === 'autre' ? `Autre (${demande.type_conge_autre || ''})` : 'Non spécifié')
        : null;

      const demandeInfo = [
        { label: 'Type de demande:', value: typeDemandeLabel },
        { label: 'Motif:', value: demande.titre },
        { label: 'Date de départ:', value: new Date(demande.date_depart).toLocaleDateString('fr-FR') }
      ];

      if (demande.date_retour) {
        demandeInfo.push({ label: 'Date de retour:', value: new Date(demande.date_retour).toLocaleDateString('fr-FR') });
      }

      if (demande.type_demande === 'conges' && joursOuvres > 0) {
        demandeInfo.push({
          label: 'Nombre de jours ouvrés:',
          value: `${joursOuvres} jour${joursOuvres > 1 ? 's' : ''}`,
          highlight: true
        });
      }

      if (typeCongeLabel) {
        demandeInfo.push({ label: 'Type de congé:', value: typeCongeLabel });
      }

      if (demande.demi_journee) {
        demandeInfo.push({ label: 'Demi-journée:', value: 'Oui' });
      }

      if (demande.heure_depart) {
        demandeInfo.push({ label: 'Heure de départ:', value: demande.heure_depart });
      }

      if (demande.heure_retour) {
        demandeInfo.push({ label: 'Heure de retour:', value: demande.heure_retour });
      }

      if (demande.frais_deplacement) {
        demandeInfo.push({ label: 'Frais de déplacement:', value: `${demande.frais_deplacement} TND` });
      }

      demandeInfo.forEach(info => {
        doc.fontSize(11)
          .font('Helvetica-Bold')
          .text(info.label, 60, yPosition, { width: 150, continued: true });

        if (info.highlight) {
          doc.fillColor('#1976d2')
            .fontSize(14)
            .font('Helvetica-Bold')
            .text(info.value, { width: 350 });
          doc.fillColor('#000000');
        } else {
          doc.font('Helvetica')
            .text(info.value, { width: 350 });
        }

        yPosition += 25;
      });

      // Pied de page
      const footerY = doc.page.height - 60;
      doc.rect(0, footerY, doc.page.width, 60).fill('#f5f5f5');
      doc.fillColor('#666666')
        .fontSize(9)
        .font('Helvetica')
        .text('Cet email est envoyé automatiquement par le système de gestion RH', 50, footerY + 20, {
          align: 'center',
          width: doc.page.width - 100
        })
        .text(`Généré le ${new Date().toLocaleDateString('fr-FR')}`, 50, footerY + 35, {
          align: 'center',
          width: doc.page.width - 100
        });

      doc.end();

    } catch (error) {
      reject(error);
    }
  });
}

// Fonction pour calculer les jours ouvrés
function calculerJoursOuvres(dateDebut, dateFin) {
  if (!dateDebut || !dateFin) return 0;

  const debut = new Date(dateDebut);
  const fin = new Date(dateFin);

  debut.setHours(0, 0, 0, 0);
  fin.setHours(0, 0, 0, 0);

  if (fin < debut) return 0;

  let joursOuvres = 0;
  const dateActuelle = new Date(debut);

  while (dateActuelle <= fin) {
    const jourSemaine = dateActuelle.getDay();
    if (jourSemaine >= 1 && jourSemaine <= 5) {
      joursOuvres++;
    }
    dateActuelle.setDate(dateActuelle.getDate() + 1);
  }

  return joursOuvres;
}

// ─── APPROUVER DEPUIS L'APP ────────────────────────────────────────────────
// ─── APPROUVER DEPUIS L'APP ────────────────────────────────────────────────
app.post('/api/demandes/:id/approuver-app', authenticateToken, requireDemandeInSiteScope, async (req, res) => {
  const { id } = req.params;
  console.log(`✅ [APP] Approbation demande ${id}`);

  const { schema: actionSchema, tenantKey } = resolveActionSchemaAndTenantApp(req);
  if (tenantKey !== 'tunisia') {
    return handleNonTunisiaApprove(req, res, id, tenantKey, actionSchema);
  }

  try {
    const result = await pool.query(
      `SELECT d.*,
              e.nom, e.prenom, e.adresse_mail, e.poste, e.matricule,
              e.mail_responsable1,
              e.mail_responsable2,
              e.mail_responsable_fonctionnel
       FROM demande_rh d
       JOIN employees e ON d.employe_id = e.id
       WHERE d.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Demande non trouvée' });
    }

    const demande = result.rows[0];

if (demande.statut !== 'en_attente') {
  return res.status(400).json({
    success: false,
    error: `Cette demande a déjà été traitée (statut: ${demande.statut})`
  });
}

// ✅ FIX: any authenticated Tunisia tenant user can approve the demande
if (!isTunisiaTenantUser(req.user)) {
  return res.status(403).json({
    success: false,
    error: 'Vous n’êtes pas autorisé à approuver cette demande.'
  });
}

const approverStates = {
  approuve_responsable1: true,
  approuve_responsable2: true
};

const newStatut = 'approuve';
  const updateResult = await pool.query(
  `UPDATE demande_rh 
   SET statut = $1, 
       approuve_responsable2 = $2,
       approuve_responsable1 = $3,
       updated_at = CURRENT_TIMESTAMP,
       approved_at = CURRENT_TIMESTAMP
   WHERE id = $4
   RETURNING *`,
  [
    newStatut,
    approverStates.approuve_responsable2,
    approverStates.approuve_responsable1,
    id
  ]
);


    const updatedDemande = {
      ...demande,
      ...updateResult.rows?.[0],
      statut: newStatut,
      approuve_responsable1: approverStates.approuve_responsable1,
      approuve_responsable2: approverStates.approuve_responsable2
    };

    if (newStatut !== 'approuve') {
      return res.json({
        success: true,
        message: 'Validation enregistrée. Demande en attente du second responsable.',
        demande: updatedDemande
      });
    }

    const typeLabel =
      demande.type_demande === 'conges' ? 'Congé' :
      demande.type_demande === 'autorisation' ? 'Autorisation' : 'Mission';

    const typeCongeLabel = getTypeCongeTextApp(demande.type_conge, demande.type_conge_autre);
    const canCancelFromEmail = isDemandeCancellationAllowed(updatedDemande);
    const cancelUrl = canCancelFromEmail ? getDemandeCancelUrl(req, id) : null;

    // ... rest of your code continues unchanged

    // Email à l'employé
    const htmlEmploye = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #16a34a; border-bottom: 3px solid #16a34a; padding-bottom: 10px;">
          ✅ Votre demande a été approuvée
        </h2>
        <div style="background: #f0fdf4; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #16a34a;">
          <p><strong>Bonjour ${demande.prenom} ${demande.nom},</strong></p>
          <p>Nous avons le plaisir de vous informer que votre demande a été <strong style="color: #16a34a;">approuvée</strong>.</p>
        </div>
        <div style="background: #f8fafc; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <h3 style="color: #374151; margin-top: 0;">📋 Détails de la demande</h3>
          <p><strong>Type :</strong> ${typeLabel}</p>
          <p><strong>Motif :</strong> ${demande.titre}</p>
          <p><strong>Date de départ :</strong> ${formatDateShortApp(demande.date_depart)}</p>
          ${demande.date_retour ? `<p><strong>Date de retour :</strong> ${formatDateShortApp(demande.date_retour)}</p>` : ''}
          ${typeCongeLabel ? `<p><strong>Type de congé :</strong> ${typeCongeLabel}</p>` : ''}
          ${demande.heure_depart ? `<p><strong>Heure de départ :</strong> ${demande.heure_depart}</p>` : ''}
          ${demande.heure_retour ? `<p><strong>Heure de retour :</strong> ${demande.heure_retour}</p>` : ''}
          ${demande.frais_deplacement ? `<p><strong>Frais de déplacement :</strong> ${demande.frais_deplacement} TND</p>` : ''}
        </div>
        ${cancelUrl ? `
          <div style="background: #fff7ed; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #f97316;">
            <p style="margin-top: 0; color: #9a3412;">
              Si cette demande n'est plus valable, vous pouvez l'annuler tant que la période n'est pas passée.
            </p>
            <a href="${cancelUrl}" style="display: inline-block; background: #dc2626; color: #ffffff; padding: 12px 18px; border-radius: 8px; text-decoration: none; font-weight: bold;">
              Annuler la demande
            </a>
          </div>
        ` : ''}

        <p style="color: #6b7280; font-size: 14px;">Si vous avez des questions, contactez le service RH.</p>
      </div>
    `;

    try {
      await sendEmail(demande.adresse_mail, '✅ Votre demande RH a été approuvée', htmlEmploye);
      console.log(`📧 Email approbation envoyé à ${demande.adresse_mail}`);
    } catch (emailErr) {
      console.error('❌ Erreur email employé (approbation):', emailErr.message);
    }

    // Notification responsable fonctionnel — Tunisia only, full approval only
    if (demande.mail_responsable_fonctionnel) {
      try {
        const htmlFonctionnel = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #2563eb; border-bottom: 2px solid #2563eb; padding-bottom: 10px;">
              📋 Information — Demande RH approuvée
            </h2>
            <div style="background: #f0f9ff; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #2563eb;">
              <p>Bonjour,</p>
              <p>Pour information, la demande RH de <strong>${demande.prenom} ${demande.nom}</strong>
                 a été <strong style="color:#16a34a;">approuvée</strong>.</p>
            </div>
            <div style="background: #f8fafc; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <p><strong>Employé :</strong> ${demande.prenom} ${demande.nom}</p>
              <p><strong>Matricule :</strong> ${demande.matricule || 'N/A'}</p>
              <p><strong>Type :</strong> ${typeLabel}</p>
              <p><strong>Motif :</strong> ${demande.titre}</p>
              <p><strong>Date de départ :</strong> ${formatDateShortApp(demande.date_depart)}</p>
              ${demande.date_retour ? `<p><strong>Date de retour :</strong> ${formatDateShortApp(demande.date_retour)}</p>` : ''}
              ${typeCongeLabel ? `<p><strong>Type de congé :</strong> ${typeCongeLabel}</p>` : ''}
            </div>
            <p style="color: #6b7280; font-size: 13px;">
              Vous recevez cet email en tant que responsable fonctionnel de cet employé.<br/>
              Ceci est une notification automatique à titre informatif uniquement.
            </p>
          </div>
        `;
        await sendEmail(
          demande.mail_responsable_fonctionnel,
          `📋 Info — Demande approuvée : ${demande.prenom} ${demande.nom}`,
          htmlFonctionnel
        );
        console.log(`📧 Notification fonctionnel envoyée à ${demande.mail_responsable_fonctionnel}`);
      } catch (emailErr) {
        console.error('❌ Erreur email responsable fonctionnel:', emailErr.message);
      }
    }

    // Calcul du nombre de jours ouvrés pour les congés
    let joursOuvres = 0;
    if (demande.type_demande === 'conges' && demande.date_retour) {
      joursOuvres = calculerJoursOuvres(demande.date_depart, demande.date_retour);
    }

   
    console.log(`✅ Demande ${id} approuvée depuis l'application`);
    res.json({
      success: true,
      message: 'Demande approuvée avec succès',
      demande: updatedDemande
    });

  } catch (err) {
    console.error('❌ Erreur approbation app:', err);
    res.status(500).json({ success: false, error: "Erreur lors de l'approbation", details: err.message });
  }
});

// ─── REFUSER DEPUIS L'APP ──────────────────────────────────────────────────
app.get('/api/demandes/:id/annuler', async (req, res) => {
  const { id } = req.params;
  const { token } = req.query;

  try {
    if (!isValidDemandeCancelToken(id, token)) {
      const page = renderDemandeCancellationPage({
        title: 'Lien invalide',
        message: "Ce lien d'annulation est invalide.",
        status: 403,
        color: '#dc2626'
      });
      return res.status(page.status).send(page.html);
    }

    const demande = await getDemandeCancellationContext(id);
    const blockReason = getDemandeCancellationBlockReason(demande);

    if (blockReason) {
      const page = renderDemandeCancellationPage({
        title: 'Annulation impossible',
        message: blockReason,
        details: demande ? getDemandeDetailsHtml(demande) : '',
        status: 400,
        color: '#dc2626'
      });
      return res.status(page.status).send(page.html);
    }

    const confirmAction = `/api/demandes/${encodeURIComponent(id)}/annuler/confirm?token=${encodeURIComponent(token)}`;
    const page = renderDemandeCancellationPage({
      title: 'Confirmer l\'annulation',
      message: 'Veuillez confirmer que vous souhaitez annuler cette demande RH approuvée.',
      details: getDemandeDetailsHtml(demande),
      actionHtml: `
        <form method="POST" action="${escapeHtml(confirmAction)}" class="actions">
          <button type="submit" class="danger">Confirmer l'annulation</button>
          <a href="javascript:window.close();" class="link-button secondary">Fermer</a>
        </form>
      `,
      color: '#f97316'
    });

    return res.status(page.status).send(page.html);
  } catch (err) {
    console.error('Erreur page annulation demande:', err);
    const page = renderDemandeCancellationPage({
      title: 'Erreur',
      message: "Une erreur est survenue lors de la préparation de l'annulation.",
      status: 500,
      color: '#dc2626'
    });
    return res.status(page.status).send(page.html);
  }
});

app.post('/api/demandes/:id/annuler/confirm', async (req, res) => {
  const { id } = req.params;
  const { token } = req.query;

  try {
    if (!isValidDemandeCancelToken(id, token)) {
      const page = renderDemandeCancellationPage({
        title: 'Lien invalide',
        message: "Ce lien d'annulation est invalide.",
        status: 403,
        color: '#dc2626'
      });
      return res.status(page.status).send(page.html);
    }

    const demande = await getDemandeCancellationContext(id);
    const blockReason = getDemandeCancellationBlockReason(demande);

    if (blockReason) {
      const page = renderDemandeCancellationPage({
        title: 'Annulation impossible',
        message: blockReason,
        details: demande ? getDemandeDetailsHtml(demande) : '',
        status: 400,
        color: '#dc2626'
      });
      return res.status(page.status).send(page.html);
    }

    const updateResult = await pool.query(
      `UPDATE demande_rh
       SET statut = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
         AND statut = 'approuve'
         AND COALESCE(date_retour, date_depart) >= CURRENT_DATE
       RETURNING *`,
      [DEMANDE_STATUS_ANNULEE, id]
    );

    if (updateResult.rows.length === 0) {
      const refreshedDemande = await getDemandeCancellationContext(id);
      const page = renderDemandeCancellationPage({
        title: 'Annulation impossible',
        message: getDemandeCancellationBlockReason(refreshedDemande) || "Cette demande ne peut plus être annulée.",
        details: refreshedDemande ? getDemandeDetailsHtml(refreshedDemande) : '',
        status: 400,
        color: '#dc2626'
      });
      return res.status(page.status).send(page.html);
    }

    try {
      await sendDemandeCancellationNotification({
        ...demande,
        ...updateResult.rows[0],
        nom: demande.nom,
        prenom: demande.prenom,
        adresse_mail: demande.adresse_mail,
        matricule: demande.matricule,
        mail_responsable1: demande.mail_responsable1,
        mail_responsable2: demande.mail_responsable2
      });
    } catch (emailErr) {
      console.error('Erreur email notification annulation:', emailErr.message);
    }

    const page = renderDemandeCancellationPage({
      title: 'Demande annulée',
      message: 'Votre demande RH a été annulée avec succès. Le service RH et vos responsables ont été notifiés.',
      details: getDemandeDetailsHtml({ ...demande, ...updateResult.rows[0], nom: demande.nom, prenom: demande.prenom }),
      color: '#16a34a'
    });

    return res.status(page.status).send(page.html);
  } catch (err) {
    console.error('Erreur annulation demande:', err);
    const page = renderDemandeCancellationPage({
      title: 'Erreur',
      message: "Une erreur est survenue lors de l'annulation de la demande.",
      status: 500,
      color: '#dc2626'
    });
    return res.status(page.status).send(page.html);
  }
});

// ─── PRIME DE GRATIFICATION -- LIEN D'ÉVALUATION MANAGER (SANS LOGIN) ───────
// SAHEL-only annual bonus (see services/paie/gratification.js). No real
// "manager login scoped to their reports" exists in this app (see plan
// notes), so this reuses the same no-login, HMAC-signed-token pattern as
// the demande cancellation flow just above, and the same
// renderDemandeCancellationPage() HTML shell.
function getGratificationEmployeeDetailsHtml(employee, existing) {
  const total = existing
    ? Number(existing.note_delais) + Number(existing.note_qualite) + Number(existing.note_attitude) + Number(existing.note_rigueur)
    : null;
  return `
    <div class="details">
      <p><strong>Employé :</strong> ${escapeHtml(`${employee.prenom || ''} ${employee.nom || ''}`.trim())}</p>
      <p><strong>Matricule :</strong> ${escapeHtml(employee.matricule || '')}</p>
      ${existing ? `<p><strong>Dernière note enregistrée :</strong> ${escapeHtml(String(total))}/20 (par ${escapeHtml(existing.submitted_by_email)})</p>` : ''}
    </div>
  `;
}

function isValidGratificationYear(annee) {
  return /^\d{4}$/.test(String(annee || ''));
}

const GRATIFICATION_ROLE_LABELS = {
  hierarchique: 'responsable hiérarchique',
  fonctionnel: 'responsable fonctionnel',
};

app.get('/api/gratification-eval/:employeeId', async (req, res) => {
  const { employeeId } = req.params;
  const { annee, role, token } = req.query;

  try {
    if (
      !isValidGratificationYear(annee) ||
      !GRATIFICATION_ROLES.includes(role) ||
      !isValidGratificationEvalToken(employeeId, annee, role, token)
    ) {
      const page = renderDemandeCancellationPage({
        title: 'Lien invalide',
        message: "Ce lien d'évaluation est invalide.",
        status: 403,
        color: '#dc2626'
      });
      return res.status(page.status).send(page.html);
    }

    const employeeResult = await pool.query(
      `SELECT id, matricule, nom, prenom FROM public.employees WHERE id = $1`,
      [employeeId]
    );
    const employee = employeeResult.rows[0];
    if (!employee) {
      const page = renderDemandeCancellationPage({
        title: 'Employé introuvable',
        message: "Cet employé n'existe pas ou plus.",
        status: 404,
        color: '#dc2626'
      });
      return res.status(page.status).send(page.html);
    }

    const existingResult = await pool.query(
      `SELECT note_delais, note_qualite, note_attitude, note_rigueur, submitted_by_email
       FROM public.paie_gratification_evaluations WHERE employee_id = $1 AND annee = $2 AND role = $3`,
      [employeeId, annee, role]
    );
    const existing = existingResult.rows[0] || null;

    const inputStyle = 'width:100%;padding:10px;border:1px solid #d1d5db;border-radius:8px;font-size:16px;box-sizing:border-box;';
    const field = (name, label, value) => `
      <label style="display:block;margin:12px 0 4px;font-weight:700;">${escapeHtml(label)} (0 à 5)</label>
      <input type="number" name="${name}" min="0" max="5" step="0.5" required value="${value != null ? escapeHtml(String(value)) : ''}" style="${inputStyle}">
    `;

    const confirmAction = `/api/gratification-eval/${encodeURIComponent(employeeId)}/confirm?annee=${encodeURIComponent(annee)}&role=${encodeURIComponent(role)}&token=${encodeURIComponent(token)}`;
    const roleLabel = GRATIFICATION_ROLE_LABELS[role];
    const page = renderDemandeCancellationPage({
      title: 'Évaluation annuelle — Prime de Gratification',
      message: `En tant que ${roleLabel}, merci de noter chacun des 4 critères ci-dessous pour l'année ${annee} (0 = insuffisant, 5 = excellent). Les notes des deux responsables (hiérarchique et fonctionnel) seront combinées (moyenne) pour la note finale.`,
      details: getGratificationEmployeeDetailsHtml(employee, existing),
      actionHtml: `
        <form method="POST" action="${escapeHtml(confirmAction)}">
          ${field('note_delais', 'Respect des délais', existing?.note_delais)}
          ${field('note_qualite', 'Qualité de travail', existing?.note_qualite)}
          ${field('note_attitude', 'Attitude', existing?.note_attitude)}
          ${field('note_rigueur', 'Rigueur et discipline', existing?.note_rigueur)}
          <label style="display:block;margin:12px 0 4px;font-weight:700;">Votre email</label>
          <input type="email" name="submitted_by_email" required style="${inputStyle}" value="${escapeHtml(existing?.submitted_by_email || '')}">
          <div class="actions">
            <button type="submit" class="link-button" style="background:#2563eb;color:white;border:0;">Enregistrer la note</button>
          </div>
        </form>
      `,
      color: '#2563eb'
    });

    return res.status(page.status).send(page.html);
  } catch (err) {
    console.error('Erreur page évaluation gratification:', err);
    const page = renderDemandeCancellationPage({
      title: 'Erreur',
      message: "Une erreur est survenue lors de la préparation du formulaire.",
      status: 500,
      color: '#dc2626'
    });
    return res.status(page.status).send(page.html);
  }
});

app.post('/api/gratification-eval/:employeeId/confirm', async (req, res) => {
  const { employeeId } = req.params;
  const { annee, role, token } = req.query;

  try {
    if (
      !isValidGratificationYear(annee) ||
      !GRATIFICATION_ROLES.includes(role) ||
      !isValidGratificationEvalToken(employeeId, annee, role, token)
    ) {
      const page = renderDemandeCancellationPage({
        title: 'Lien invalide',
        message: "Ce lien d'évaluation est invalide.",
        status: 403,
        color: '#dc2626'
      });
      return res.status(page.status).send(page.html);
    }

    const parseScore = (raw) => {
      const n = Number(raw);
      return Number.isFinite(n) ? n : NaN;
    };
    const noteDelais = parseScore(req.body.note_delais);
    const noteQualite = parseScore(req.body.note_qualite);
    const noteAttitude = parseScore(req.body.note_attitude);
    const noteRigueur = parseScore(req.body.note_rigueur);
    const submittedByEmail = String(req.body.submitted_by_email || '').trim();

    const scoresValid = [noteDelais, noteQualite, noteAttitude, noteRigueur].every(
      (n) => Number.isFinite(n) && n >= 0 && n <= 5
    );

    if (!scoresValid || !isValidEmail(submittedByEmail)) {
      const page = renderDemandeCancellationPage({
        title: 'Formulaire invalide',
        message: 'Chaque note doit être comprise entre 0 et 5, et une adresse email valide est requise.',
        status: 400,
        color: '#dc2626'
      });
      return res.status(page.status).send(page.html);
    }

    const employeeResult = await pool.query(
      `SELECT id, matricule, nom, prenom, mail_responsable1, mail_responsable2 FROM public.employees WHERE id = $1`,
      [employeeId]
    );
    const employee = employeeResult.rows[0];
    if (!employee) {
      const page = renderDemandeCancellationPage({
        title: 'Employé introuvable',
        message: "Cet employé n'existe pas ou plus.",
        status: 404,
        color: '#dc2626'
      });
      return res.status(page.status).send(page.html);
    }

    await pool.query(
      `INSERT INTO public.paie_gratification_evaluations
         (employee_id, annee, role, note_delais, note_qualite, note_attitude, note_rigueur, submitted_by_email, submitted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)
       ON CONFLICT (employee_id, annee, role) DO UPDATE SET
         note_delais = EXCLUDED.note_delais,
         note_qualite = EXCLUDED.note_qualite,
         note_attitude = EXCLUDED.note_attitude,
         note_rigueur = EXCLUDED.note_rigueur,
         submitted_by_email = EXCLUDED.submitted_by_email,
         submitted_at = CURRENT_TIMESTAMP`,
      [employeeId, annee, role, noteDelais, noteQualite, noteAttitude, noteRigueur, submittedByEmail]
    );

    // Tell them whether the other manager role (if the employee has one on
    // file) still needs to submit, or already has -- the final note is the
    // average of both once both exist, not just this one submission.
    const otherRole = role === 'hierarchique' ? 'fonctionnel' : 'hierarchique';
    const otherExpected = role === 'hierarchique' ? !!employee.mail_responsable2 : !!employee.mail_responsable1;
    const otherResult = otherExpected
      ? await pool.query(
          `SELECT 1 FROM public.paie_gratification_evaluations WHERE employee_id = $1 AND annee = $2 AND role = $3`,
          [employeeId, annee, otherRole]
        )
      : { rows: [] };
    const otherSubmitted = otherResult.rows.length > 0;

    const total = noteDelais + noteQualite + noteAttitude + noteRigueur;
    const roleLabel = GRATIFICATION_ROLE_LABELS[role];
    let statusLine;
    if (!otherExpected) {
      statusLine = 'Cet employé n\'a qu\'un seul responsable renseigné -- votre note sera utilisée directement comme note finale.';
    } else if (otherSubmitted) {
      statusLine = 'Le/la ' + GRATIFICATION_ROLE_LABELS[otherRole] + ' a déjà soumis sa note -- la note finale (moyenne des deux) est maintenant complète.';
    } else {
      statusLine = 'En attente de la note du/de la ' + GRATIFICATION_ROLE_LABELS[otherRole] + ' -- la note finale sera la moyenne des deux.';
    }

    const page = renderDemandeCancellationPage({
      title: 'Note enregistrée',
      message: `Merci — votre note (${roleLabel}) pour ${`${employee.prenom || ''} ${employee.nom || ''}`.trim()} en ${annee} a bien été enregistrée : ${total}/20. ${statusLine}`,
      color: '#16a34a'
    });
    return res.status(page.status).send(page.html);
  } catch (err) {
    console.error('Erreur enregistrement évaluation gratification:', err);
    const page = renderDemandeCancellationPage({
      title: 'Erreur',
      message: "Une erreur est survenue lors de l'enregistrement de la note.",
      status: 500,
      color: '#dc2626'
    });
    return res.status(page.status).send(page.html);
  }
});

// Authenticated (HR/payroll) trigger that emails the no-login evaluation
// link above to every active employee's managers. A "send real emails to
// real managers" write action, so gated by isPaieSalaryAuthorized on top of
// the SAHEL-only schema check -- stricter than the read-only oversight list
// in routes/gratification.cjs, which any authenticated SAHEL user can view.
app.post('/api/gratification/envoyer-liens', authenticateToken, async (req, res) => {
  try {
    // Tunisia-only check removed: every tenant gets Paie (2026-11-18); the salary allowlist below still applies.
    if (!isPaieSalaryAuthorized(req.user)) {
      return res.status(403).json({ error: "Vous n'êtes pas autorisé à déclencher l'envoi des liens d'évaluation." });
    }

    const annee = parseInt(req.body.annee, 10);
    if (!Number.isInteger(annee)) {
      return res.status(400).json({ error: 'annee is required (e.g. 2025)' });
    }

    const employeesResult = await pool.query(
      `SELECT id, matricule, nom, prenom, mail_responsable1, mail_responsable2
       FROM public.employees
       WHERE statut = 'actif' OR statut IS NULL`
    );

    // Group by recipient email so a manager with several reports gets ONE
    // email listing all of them, instead of one separate email per
    // employee (2026-09-30). Each entry still carries its own
    // role-scoped link (hierarchique for mail_responsable1, fonctionnel
    // for mail_responsable2 -- NOT mail_responsable_fonctionnel, a
    // different, unrelated field used elsewhere for demande RH
    // notifications; the developer confirmed 2026-09-30 that mail_responsable2 is
    // the real second-level/functional approver in practice, usually
    // Jamie), so the two roles' notes stay tracked and combined
    // separately even though they now travel in a batched email -- see
    // ensureGratificationTable's comment.
    const entriesByRecipient = new Map();
    const skipped = [];
    for (const employee of employeesResult.rows) {
      const employeeName = `${employee.prenom || ''} ${employee.nom || ''}`.trim();

      // Matricule 1 (Jamie Lambert, site CEO) is deliberately never
      // auto-emailed here (2026-09-30): his mail_responsable1/2 are
      // corporate-level contacts (jamie.becker/jamie.laurent), and
      // it isn't appropriate to route a routine local evaluation request
      // to them for the site's own CEO. He stays visible in the oversight
      // table and still counts in the prime calculation if a note is
      // recorded for him some other way -- only this automated email is
      // skipped.
      if (String(employee.matricule) === '1') {
        skipped.push({ matricule: employee.matricule, nom: employeeName, reason: 'CEO du site -- emails non envoyés automatiquement' });
        continue;
      }

      const roleAssignments = [
        ['hierarchique', employee.mail_responsable1],
        ['fonctionnel', employee.mail_responsable2],
      ].filter(([, email]) => !!email);

      if (roleAssignments.length === 0) {
        skipped.push({ matricule: employee.matricule, nom: employeeName, reason: 'aucun responsable renseigné' });
        continue;
      }

      for (const [role, to] of roleAssignments) {
        if (!entriesByRecipient.has(to)) entriesByRecipient.set(to, []);
        entriesByRecipient.get(to).push({
          employeeName,
          matricule: employee.matricule,
          role,
          url: getGratificationEvalUrl(req, employee.id, annee, role),
        });
      }
    }

    let emailsSent = 0;
    for (const [to, entries] of entriesByRecipient) {
      const rowsHtml = entries
        .map(
          (e) => `
            <tr>
              <td style="padding:8px;border-bottom:1px solid #e5e7eb;">${escapeHtml(e.employeeName)} (matricule ${escapeHtml(e.matricule || '')})</td>
              <td style="padding:8px;border-bottom:1px solid #e5e7eb;">${escapeHtml(GRATIFICATION_ROLE_LABELS[e.role])}</td>
              <td style="padding:8px;border-bottom:1px solid #e5e7eb;">
                <a href="${e.url}" style="display:inline-block;background:#2563eb;color:#ffffff;padding:8px 14px;border-radius:6px;text-decoration:none;font-weight:bold;">Saisir la note</a>
              </td>
            </tr>`
        )
        .join('');
      const html = `
        <div style="font-family: Arial, sans-serif; max-width: 680px; margin: 0 auto;">
          <h2 style="color: #2563eb;">Évaluation annuelle — Prime de Gratification ${annee}</h2>
          <p>Bonjour,</p>
          <p>Merci de noter chacun des employés ci-dessous sur les 4 critères de la Prime de Gratification pour l'année ${annee}.</p>
          <table style="width:100%;border-collapse:collapse;">${rowsHtml}</table>
          <p style="color: #6b7280; font-size: 14px; margin-top: 24px;">Chaque lien est personnel et sécurisé.</p>
        </div>
      `;
      try {
        await sendEmail(to, `Évaluation annuelle — Prime de Gratification ${annee}`, html);
        emailsSent += 1;
      } catch (emailErr) {
        console.error(`❌ Erreur email évaluation gratification à ${to}:`, emailErr.message);
      }
    }

    res.json({
      success: true,
      annee,
      employeesCount: employeesResult.rows.length,
      recipientsCount: entriesByRecipient.size,
      emailsSent,
      skipped,
    });
  } catch (err) {
    console.error('❌ Erreur envoi liens gratification:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── DÉVERROUILLAGE DES DONNÉES DE PAIE (chiffrées) ─────────────────────────
// See services/paie/salaryCrypto.js. The code is never stored -- only a
// salt+verifier (paie_encryption_config) used to confirm a submitted code
// and derive the same AES key it was derived with originally. The key then
// lives only in server memory for the unlock session's lifetime (see
// salaryCrypto's UNLOCK_SESSION_TTL_MS).

// Lets the frontend show the right form (initialize vs. unlock) up front,
// instead of guessing from a failed /unlock attempt.
app.get('/api/paie/encryption-status', authenticateToken, async (req, res) => {
  try {
    // Tunisia-only check removed: every tenant gets Paie (2026-11-18); the salary allowlist below still applies.
    if (!isPaieSalaryAuthorized(req.user)) {
      return res.status(403).json({ error: "Vous n'êtes pas autorisé à consulter cet état." });
    }
    const result = await pool.query('SELECT id FROM public.paie_encryption_config LIMIT 1');
    res.json({ initialized: result.rows.length > 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// First-time setup: encrypts every existing Tunisia salary/allowance value
// under a brand-new code (services/paie/initializeSalaryEncryption.js).
// Sent over HTTP deliberately -- Jamie (HR, no technical background) needs
// to be able to do this himself from the app; it's no riskier than /unlock
// or /rotate-code below, which already send a code over this same
// authenticated connection. A CLI version also exists
// (scripts/setup-salary-encryption.js) for anyone who prefers it.
app.post('/api/paie/initialize-code', authenticateToken, async (req, res) => {
  try {
    // Tunisia-only check removed: every tenant gets Paie (2026-11-18); the salary allowlist below still applies.
    if (!isPaieSalaryAuthorized(req.user)) {
      return res.status(403).json({ error: "Vous n'êtes pas autorisé à initialiser le chiffrement des données de paie." });
    }

    const { code } = req.body;
    const { employeesCount, configCount, key } = await initializeSalaryEncryption(pool, code);

    // Seamlessly unlock the caller's session under the code they just set,
    // rather than making them submit it a second time right away.
    const { token, expiresAt } = await salaryCrypto.createUnlockSession(key);

    res.json({ success: true, unlockToken: token, expiresAt, employeesCount, configCount });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    console.error('❌ Erreur initialisation chiffrement paie:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/paie/unlock', authenticateToken, async (req, res) => {
  try {
    // Tunisia-only check removed: every tenant gets Paie (2026-11-18); the salary allowlist below still applies.
    if (!isPaieSalaryAuthorized(req.user)) {
      return res.status(403).json({ error: "Vous n'êtes pas autorisé à déverrouiller les données de paie." });
    }

    const { code } = req.body;
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: 'code is required' });
    }

    const configResult = await pool.query(
      'SELECT salt, verifier FROM public.paie_encryption_config ORDER BY id DESC LIMIT 1'
    );
    if (configResult.rows.length === 0) {
      return res.status(409).json({ error: "Le chiffrement des données de paie n'a pas encore été configuré.", needsInitialization: true });
    }

    const { salt, verifier } = configResult.rows[0];
    // A stray space (copy-paste, autofill) made a right code fail with
    // "Code incorrect." -- the field is masked, so it can't be seen. Try the
    // code as typed first (in case it was deliberately set with spaces),
    // then trimmed.
    const key = salaryCrypto.checkCode(code, salt, verifier)
      || (code.trim() !== code ? salaryCrypto.checkCode(code.trim(), salt, verifier) : null);
    if (!key) {
      return res.status(401).json({ error: 'Code incorrect.' });
    }

    const { token, expiresAt } = await salaryCrypto.createUnlockSession(key);
    res.json({ success: true, unlockToken: token, expiresAt });
  } catch (err) {
    console.error('❌ Erreur déverrouillage paie:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/paie/lock', authenticateToken, (req, res) => {
  const token = req.headers['x-paie-unlock-token'];
  if (token) salaryCrypto.revokeUnlockSession(token);
  res.json({ success: true });
});

// Changes the secret code: re-encrypts every Tunisia salary/allowance value
// under a new key (services/paie/rotateSalaryEncryption.js), in one
// transaction. Sent over HTTP deliberately -- unlike the very first setup
// (scripts/setup-salary-encryption.js, CLI-only), this is no riskier than
// the /unlock call above, which already sends the code over this same
// authenticated HTTPS connection every time someone unlocks a session.
app.post('/api/paie/rotate-code', authenticateToken, async (req, res) => {
  try {
    // Tunisia-only check removed: every tenant gets Paie (2026-11-18); the salary allowlist below still applies.
    if (!isPaieSalaryAuthorized(req.user)) {
      return res.status(403).json({ error: "Vous n'êtes pas autorisé à changer le code de déverrouillage." });
    }

    const { oldCode, newCode } = req.body;
    if (!oldCode || !newCode) {
      return res.status(400).json({ error: 'oldCode and newCode are required' });
    }

    const { employeesCount, configCount, newKey } = await rotateSalaryEncryptionCode(pool, oldCode, newCode);

    // Seamlessly re-unlock the caller's session under the new key, rather
    // than making them submit the code they just chose a second time.
    // Every other session still holds the OLD key -- drop them all.
    await salaryCrypto.revokeAllUnlockSessions();
    const { token, expiresAt } = await salaryCrypto.createUnlockSession(newKey);

    res.json({ success: true, unlockToken: token, expiresAt, employeesCount, configCount });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    console.error('❌ Erreur changement code paie:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/demandes/:id/refuser-app', authenticateToken, requireDemandeInSiteScope, async (req, res) => {
  const { id } = req.params;
  const { commentaire } = req.body;

  console.log(`❌ [APP] Refus demande ${id}`);

  if (!commentaire || !commentaire.trim()) {
    return res.status(400).json({ success: false, error: 'Le motif du refus est obligatoire' });
  }

  const { schema: actionSchema, tenantKey } = resolveActionSchemaAndTenantApp(req);
  if (tenantKey !== 'tunisia') {
    return handleNonTunisiaRefuse(req, res, id, tenantKey, actionSchema, commentaire);
  }

  try {
    const result = await pool.query(
      `SELECT d.*,
              e.nom, e.prenom, e.adresse_mail, e.poste, e.matricule
       FROM demande_rh d
       JOIN employees e ON d.employe_id = e.id
       WHERE d.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Demande non trouvée' });
    }

    const demande = result.rows[0];

    if (demande.statut !== 'en_attente') {
      return res.status(400).json({
        success: false,
        error: `Cette demande a déjà été traitée (statut: ${demande.statut})`
      });
    }

    // ✅ FIX: any authenticated Tunisia tenant user can refuse the demande
    if (!isTunisiaTenantUser(req.user)) {
      return res.status(403).json({
        success: false,
        error: 'Vous n\'êtes pas autorisé à refuser cette demande.'
      });
    }

    const updateResult = await pool.query(
      `UPDATE demande_rh 
       SET statut = 'refuse', 
           approuve_responsable1 = false,
           approuve_responsable2 = false,
           commentaire_refus = $1,
           updated_at = CURRENT_TIMESTAMP 
       WHERE id = $2
       RETURNING *`,
      [
        commentaire.trim(),
        id
      ]
    );

    const updatedDemande = {
      ...demande,
      ...updateResult.rows[0],
      statut: 'refuse',
      approuve_responsable1: false,
      approuve_responsable2: false,
      commentaire_refus: commentaire.trim()
    };

    const typeLabel =
      demande.type_demande === 'conges' ? 'Congé' :
      demande.type_demande === 'autorisation' ? 'Autorisation' : 'Mission';

    const typeCongeLabel = getTypeCongeTextApp(demande.type_conge, demande.type_conge_autre);

    // Email à l'employé
    const htmlEmploye = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #dc2626; border-bottom: 3px solid #dc2626; padding-bottom: 10px;">
          ❌ Votre demande a été refusée
        </h2>
        <div style="background: #fef2f2; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #dc2626;">
          <p><strong>Bonjour ${demande.prenom} ${demande.nom},</strong></p>
          <p>Nous vous informons que votre demande a été <strong style="color: #dc2626;">refusée</strong>.</p>
        </div>
        <div style="background: #f8fafc; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <h3 style="color: #374151; margin-top: 0;">📋 Détails de la demande</h3>
          <p><strong>Type :</strong> ${typeLabel}</p>
          <p><strong>Motif :</strong> ${demande.titre}</p>
          <p><strong>Date de départ :</strong> ${formatDateShortApp(demande.date_depart)}</p>
          ${demande.date_retour ? `<p><strong>Date de retour :</strong> ${formatDateShortApp(demande.date_retour)}</p>` : ''}
          ${typeCongeLabel ? `<p><strong>Type de congé :</strong> ${typeCongeLabel}</p>` : ''}
        </div>
        <div style="background: #fef2f2; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #dc2626;">
          <p style="margin: 0;"><strong>💬 Motif du refus :</strong></p>
          <p style="margin: 8px 0 0 0; color: #374151;">${commentaire.trim()}</p>
        </div>
        <p style="color: #6b7280; font-size: 14px;">Pour toute question, contactez le service RH.</p>
      </div>
    `;

    try {
      await sendEmail(demande.adresse_mail, '❌ Votre demande RH a été refusée', htmlEmploye);
      console.log(`📧 Email refus envoyé à ${demande.adresse_mail}`);
    } catch (emailErr) {
      console.error('❌ Erreur email employé (refus):', emailErr.message);
    }

    console.log(`✅ Demande ${id} refusée depuis l'application`);
    res.json({
      success: true,
      message: 'Demande refusée avec succès',
      demande: updatedDemande
    });

  } catch (err) {
    console.error('❌ Erreur refus app:', err);
    res.status(500).json({ success: false, error: 'Erreur lors du refus', details: err.message });
  }
});

// =========================
// JOB PLANIFIÉ : RAPPORT HEBDOMADAIRE RH (LUNDI 10H)
// =========================

const HR_WEEKLY_REPORT_EMAIL = 'noel.rossi@example.com';

async function generateAndSendWeeklyHRReport() {
  try {
    const now = new Date();

    const lastMonday = new Date(now);
    lastMonday.setDate(now.getDate() - 7);
    lastMonday.setHours(0, 0, 0, 0);

    const lastSunday = new Date(now);
    lastSunday.setDate(now.getDate() - 1);
    lastSunday.setHours(23, 59, 59, 999);

    const periodLabel = `${lastMonday.toLocaleDateString('fr-FR')} → ${lastSunday.toLocaleDateString('fr-FR')}`;

    console.log(`📊 Rapport hebdomadaire: ${periodLabel}`);

    const result = await pool.query(`
      SELECT 
        e.matricule,
        e.prenom || ' ' || e.nom AS employe,
        d.type_demande,
        d.type_conge,
        d.type_conge_autre,
        d.statut,
        d.date_depart,
        d.date_retour,
        d.heure_depart,
        d.heure_retour,
        d.demi_journee,
        d.approved_at
      FROM public.demande_rh d
      LEFT JOIN public.employees e ON d.employe_id = e.id
      WHERE d.statut = 'approuve'
        AND d.date_depart <= $2
        AND COALESCE(d.date_retour, d.date_depart) >= $1
      ORDER BY d.date_depart ASC
    `, [lastMonday, lastSunday]);

    if (result.rows.length === 0) {
      const info = await emailTransporter.sendMail({
        from: { name: EMAIL_FROM_NAME, address: EMAIL_FROM },
        to: HR_WEEKLY_REPORT_EMAIL,
        subject: '✅ Test email rapport RH',
        html: `
          <div style="font-family: Arial, sans-serif;">
            <h2>✅ Test Email RH</h2>
            <p>Le système d'envoi email fonctionne.</p>
            <p>Aucune demande approuvée trouvée pour la période :</p>
            <p><strong>${periodLabel}</strong></p>
          </div>
        `
      });

      return {
        sent: true,
        test: true,
        reason: 'Aucune demande approuvée, email test envoyé',
        count: 0,
        to: HR_WEEKLY_REPORT_EMAIL,
        mail: {
          messageId: info.messageId,
          accepted: info.accepted,
          rejected: info.rejected,
          response: info.response
        },
        period: {
          from: lastMonday,
          to: lastSunday,
          label: periodLabel
        }
      };
    }

    function calcWorkingDays(dateDepart, dateRetour, demiJournee, typeDemande) {
      if (!dateDepart || !dateRetour) return '';

      const start = new Date(dateDepart);
      const end = new Date(dateRetour);

      start.setHours(0, 0, 0, 0);
      end.setHours(0, 0, 0, 0);

      if (typeDemande === 'congé' && end.getTime() === start.getTime()) {
        const day = start.getDay();
        const base = day !== 0 && day !== 6 ? 1 : 0;
        return demiJournee && base > 0 ? `${base - 0.5}` : `${base}`;
      }

      if (end < start) return '0';

      let count = 0;
      const current = new Date(start);

      while (current < end) {
        const day = current.getDay();
        if (day !== 0 && day !== 6) count++;
        current.setDate(current.getDate() + 1);
      }

      return demiJournee && count > 0 ? `${count - 0.5}` : `${count}`;
    }

    function formatDateFrench(dateString) {
      if (!dateString) return 'N/A';

      const date = new Date(dateString);
      if (isNaN(date.getTime())) return String(dateString);

      return date.toLocaleDateString('fr-FR');
    }

    function getTypeDemandeLabel(type) {
      if (type === 'congé' || type === 'conges') return 'Congé';
      if (type === 'autorisation_absence' || type === 'autorisation') return "Autorisation d'absence";
      if (type === 'mission') return 'Mission';
      return type || '';
    }

    function getTypeCongeLabel(type_conge, type_conge_autre) {
      if (!type_conge) return 'N/A';
      if (type_conge === 'autre') return type_conge_autre || 'Autre';
      return type_conge;
    }

    const headers = [
      'Matricule',
      'Employé',
      'Type de demande',
      'Type de congé',
      'Statut',
      'Date de début',
      'Date de retour',
      'Heure de départ',
      'Heure de retour',
      'Nombre de jours ouvrables',
      'Demi-journée',
      'Date d\'approbation',
    ];

    const rows = result.rows.map(d => [
      d.matricule || 'N/A',
      d.employe || 'N/A',
      getTypeDemandeLabel(d.type_demande),
      getTypeCongeLabel(d.type_conge, d.type_conge_autre),
      'Approuvé',
      formatDateFrench(d.date_depart),
      formatDateFrench(d.date_retour),
      d.heure_depart || 'N/A',
      d.heure_retour || 'N/A',
      calcWorkingDays(d.date_depart, d.date_retour, d.demi_journee, d.type_demande),
      d.demi_journee ? 'Oui' : 'Non',
      formatDateFrench(d.approved_at),
    ]);

    const csv = '\uFEFF' + [headers, ...rows]
      .map(row => row.map(cell => `"${String(cell || '').replace(/"/g, '""')}"`).join(';'))
      .join('\n');

    const dateStr = now.toLocaleDateString('fr-FR').replace(/\//g, '-');
    const filename = `rapport_demandes_approuvees_${dateStr}.csv`;

  const info = await emailTransporter.sendMail({
    from: { name: EMAIL_FROM_NAME, address: EMAIL_FROM },
    to: HR_WEEKLY_REPORT_EMAIL,
    cc: 'noel.dupuis@example.com',
    subject: `Rapport hebdomadaire RH — Demandes approuvées (${periodLabel})`,
    html: `
    <!DOCTYPE html>
    <html lang="fr">
    <head><meta charset="UTF-8"></head>
    <body style="margin:0; padding:30px 20px; background:#f4f4f4; font-family: Arial, sans-serif;">

      <div style="width:100%; max-width:640px; margin:0 auto; background:#ffffff; border:1px solid #ddd; border-radius:6px; overflow:hidden;">

        <div style="background:#2d4a6e; padding:24px 32px;">
          <p style="margin:0; color:#94a3b8; font-size:12px; text-transform:uppercase; letter-spacing:1px;">Administration SAHEL</p>
          <h1 style="margin:6px 0 0; color:#ffffff; font-size:20px; font-weight:700;">Rapport hebdomadaire RH</h1>
          <p style="margin:4px 0 0; color:#94a3b8; font-size:13px;">Demandes approuvées &nbsp;•&nbsp; ${periodLabel}</p>
        </div>

        <div style="border-bottom:1px solid #e5e7eb; padding:20px 32px; background:#f9fafb;">
          <span style="font-size:28px; font-weight:700; color:#1e293b;">${result.rows.length}</span>
          <span style="font-size:13px; color:#6b7280; margin-left:8px;">demande(s) approuvée(s) sur cette période</span>
        </div>

        <div style="padding:28px 32px;">
          <p style="margin:0; font-size:14px; color:#374151; line-height:1.6;">
            Le fichier CSV récapitulatif des demandes approuvées sur cette période est joint à cet email.
          </p>
        </div>

        <div style="background:#f9fafb; border-top:1px solid #e5e7eb; padding:16px 32px; text-align:center;">
          <p style="margin:0; font-size:12px; color:#9ca3af;">
            Rapport automatique — Système RH SAHEL &nbsp;•&nbsp; généré chaque lundi à 10h00
          </p>
        </div>

      </div>

    </body>
    </html>
  `,
  attachments: [
    {
      filename,
      content: Buffer.from(csv, 'utf-8'),
      contentType: 'text/csv; charset=utf-8',
    }
  ]
});

    return {
      sent: true,
      test: false,
      count: result.rows.length,
      to: HR_WEEKLY_REPORT_EMAIL,
      from: EMAIL_FROM,
      filename,
      mail: {
        messageId: info.messageId,
        accepted: info.accepted,
        rejected: info.rejected,
        response: info.response
      },
      period: {
        from: lastMonday,
        to: lastSunday,
        label: periodLabel
      }
    };

  } catch (error) {
    console.error('❌ Erreur rapport hebdomadaire:', error);
    throw error;
  }
}
// Check every minute — fires only on Monday at 10:00
setInterval(() => {
  const now = new Date();

  if (now.getDay() === 1 && now.getHours() === 10 && now.getMinutes() === 0) {
    generateAndSendWeeklyHRReport()
      .then(result => console.log('📊 Résultat job hebdomadaire:', result))
      .catch(error => console.error('❌ Job hebdomadaire échoué:', error));
  }
}, 60000);

// Manual trigger for testing with Postman
app.get('/api/weekly-report/trigger', authenticateToken, async (req, res) => {
  try {
    const result = await generateAndSendWeeklyHRReport();

    res.json({
      success: true,
      message: result.sent ? 'Rapport envoyé avec succès' : 'Rapport non envoyé',
      result
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Erreur pendant génération/envoi rapport',
      error: error.message,
      code: error.code,
      command: error.command,
      response: error.response,
      responseCode: error.responseCode
    });
  }
});
// =========================
// Fallback & erreurs
// =========================

app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Route non trouvée',
    path: req.originalUrl
  });
});

app.use((err, req, res, next) => {
  console.error('💥 Erreur serveur:', err);
  res.status(500).json({
    error: 'Erreur interne du serveur',
    message: err.message
  });
});

// =========================
// Démarrage serveur
// =========================

// Non-Tunisia tenants: fill employees.department from the KPI referential.
startDepartmentSync(pool, dbConfig);
// HR <-> KPI role sync (moved here from the Python copy hosted by
// Audit-Management-Backend) -- see services/hrKpiSync/index.js.
require('./services/hrKpiSync').startHrKpiSync(dbConfig);

app.listen(PORT, () => {
  console.log('\n' + '='.repeat(60));
  console.log('🚀 SERVEUR RH DÉMARRÉ');
  console.log('='.repeat(60));
  console.log(`📍 Port: ${PORT}`);
  console.log(`🌐 URL: http://localhost:${PORT}`);
  console.log(`🗄️  Base: ${process.env.DB_NAME} @ ${process.env.DB_HOST}`);
  console.log(`🔐 JWT: ${process.env.JWT_SECRET ? '✅' : '⚠️'}`);
  console.log(`📧 Email: ${EMAIL_FROM}`);
  console.log(`🌍 ENV: ${process.env.NODE_ENV || 'development'}`);
  console.log('📁 Dossier photos employés:', employeePhotoDir);
  console.log('📁 Dossier PDFs:', pdfStorageDir);
  console.log('📁 Dossier Archive PDFs:', archivePdfDir);
  console.log('='.repeat(60) + '\n');
});

process.on('SIGINT', async () => {
  console.log('\n🛑 Arrêt du serveur...');
  await pool.end();
  process.exit(0);
});
