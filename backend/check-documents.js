require('dotenv').config({ path: __dirname + '/.env' });
const { Client } = require('pg');

const client = new Client({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: Number(process.env.DB_PORT || 5432),
  ssl: { require: true, rejectUnauthorized: false }
});

async function checkDocuments() {
  try {
    await client.connect();
    console.log('✅ Connecté à la base de données');

    const result = await client.query('SELECT id, nom, prenom, dossier_rh FROM employees');
    
    console.log('\n📋 Vérification des documents:');
    console.log('='.repeat(80));
    
    for (const employee of result.rows) {
      console.log(`\n👤 ${employee.prenom} ${employee.nom} (ID: ${employee.id})`);
      console.log(`   📎 Dossier RH: ${employee.dossier_rh || 'NULL'}`);
      
      if (employee.dossier_rh) {
        if (employee.dossier_rh.startsWith('http')) {
          console.log('   ✅ Format: URL valide');
        } else {
          console.log('   ❌ Format: Non-URL (doit commencer par http)');
        }
      }
    }

  } catch (error) {
    console.error('❌ Erreur:', error);
  } finally {
    await client.end();
  }
}

checkDocuments();