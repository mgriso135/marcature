require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const inputJsonPath = path.join(__dirname, 'migration_data.json');

async function runImport() {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
        console.error("Errore: la variabile d'ambiente DATABASE_URL non è configurata nel file .env.");
        console.error("Esempio: DATABASE_URL=postgres://utente:password@host:5432/nome_db");
        process.exit(1);
    }

    if (!fs.existsSync(inputJsonPath)) {
        console.error(`Errore: il file di dati '${inputJsonPath}' non esiste.`);
        console.error("Assicurati di aver eseguito prima 'node export-sqlite.js' sulla macchina sorgente e di aver copiato il file generato.");
        process.exit(1);
    }

    console.log(`Caricamento dati da ${inputJsonPath}...`);
    let data;
    try {
        const raw = fs.readFileSync(inputJsonPath, 'utf-8');
        data = JSON.parse(raw);
    } catch (e) {
        console.error("Errore durante la lettura o il parsing del file JSON:", e.message);
        process.exit(1);
    }

    const { users = [], logs = [] } = data;
    console.log(`Pronto ad importare ${users.length} utenti e ${logs.length} log di timbrature.`);

    const pgClient = new Client({ connectionString: databaseUrl });
    try {
        await pgClient.connect();
        console.log("Connessione a PostgreSQL riuscita.");
    } catch (err) {
        console.error("Impossibile connettersi a PostgreSQL:", err.message);
        process.exit(1);
    }

    try {
        await pgClient.query('BEGIN');

        console.log("Creazione dello schema tabelle in PostgreSQL se non esistente...");
        await pgClient.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                nome_cognome TEXT,
                pin TEXT UNIQUE,
                device_token TEXT UNIQUE,
                device_user_agent TEXT,
                is_active BOOLEAN DEFAULT TRUE,
                is_admin BOOLEAN DEFAULT FALSE
            )
        `);
        await pgClient.query(`
            CREATE TABLE IF NOT EXISTS logs (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users (id),
                timestamp TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                tipo_timbratura TEXT
            )
        `);

        console.log("Importazione utenti...");
        for (const u of users) {
            const isActive = u.is_active === 1 || u.is_active === '1' || u.is_active === true || u.is_active === 'true';
            const isAdmin = u.is_admin === 1 || u.is_admin === '1' || u.is_admin === true || u.is_admin === 'true';

            await pgClient.query(
                `INSERT INTO users (id, nome_cognome, pin, device_token, device_user_agent, is_active, is_admin)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 ON CONFLICT (id) DO UPDATE SET 
                    nome_cognome = EXCLUDED.nome_cognome,
                    pin = EXCLUDED.pin,
                    device_token = EXCLUDED.device_token,
                    device_user_agent = EXCLUDED.device_user_agent,
                    is_active = EXCLUDED.is_active,
                    is_admin = EXCLUDED.is_admin`,
                [u.id, u.nome_cognome, u.pin, u.device_token, u.device_user_agent, isActive, isAdmin]
            );
        }
        console.log("Utenti importati.");

        console.log("Importazione log timbrature...");
        for (const l of logs) {
            await pgClient.query(
                `INSERT INTO logs (id, user_id, timestamp, tipo_timbratura)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (id) DO UPDATE SET
                    user_id = EXCLUDED.user_id,
                    timestamp = EXCLUDED.timestamp,
                    tipo_timbratura = EXCLUDED.tipo_timbratura`,
                [l.id, l.user_id, l.timestamp, l.tipo_timbratura]
            );
        }
        console.log("Log timbrature importati.");

        console.log("Allineamento delle sequenze ID seriali...");
        await pgClient.query("SELECT setval(pg_get_serial_sequence('users', 'id'), COALESCE(MAX(id), 1)) FROM users");
        await pgClient.query("SELECT setval(pg_get_serial_sequence('logs', 'id'), COALESCE(MAX(id), 1)) FROM logs");

        await pgClient.query('COMMIT');
        console.log("Importazione completata con SUCCESSO!");
    } catch (err) {
        console.error("Errore durante l'importazione. Esecuzione ROLLBACK...");
        try {
            await pgClient.query('ROLLBACK');
        } catch (rollbackErr) {
            console.error("Errore durante il rollback:", rollbackErr.message);
        }
        console.error(err);
    } finally {
        await pgClient.end();
        console.log("Connessione PostgreSQL chiusa.");
    }
}

runImport();
