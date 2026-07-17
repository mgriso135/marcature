const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

const sqliteDbPath = path.join(__dirname, 'presenze.db');
const outputSqlPath = path.join(__dirname, 'migration.sql');

console.log(`Lettura dei dati da SQLite database (${sqliteDbPath})...`);

const db = new sqlite3.Database(sqliteDbPath, sqlite3.OPEN_READONLY, (err) => {
    if (err) {
        console.error("Errore durante l'apertura di SQLite db:", err.message);
        process.exit(1);
    }
});

const all = (query) => new Promise((resolve, reject) => {
    db.all(query, [], (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
    });
});

// Escapa le stringhe per SQL PostgreSQL
function escapeSql(value) {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    if (typeof value === 'number') return String(value);
    // Converti interi SQLite (0/1) usati come booleani
    return `'${String(value).replace(/'/g, "''")}'`;
}

// SQLite salva i booleani come 0/1: convertiamo in TRUE/FALSE PostgreSQL
function toBool(value) {
    if (value === null || value === undefined) return 'NULL';
    return value ? 'TRUE' : 'FALSE';
}

async function runExport() {
    try {
        const users = await all("SELECT * FROM users");
        console.log(`Esportati ${users.length} utenti.`);

        const logs = await all("SELECT * FROM logs");
        console.log(`Esportati ${logs.length} log di timbrature.`);

        const lines = [];

        lines.push('-- ============================================================');
        lines.push('-- Migration da SQLite a PostgreSQL');
        lines.push(`-- Generato il: ${new Date().toISOString()}`);
        lines.push('-- ============================================================');
        lines.push('');

        // --- DROP tabelle esistenti (ordine inverso per rispettare FK) ---
        lines.push('-- Drop tabelle esistenti (se presenti)');
        lines.push('DROP TABLE IF EXISTS logs CASCADE;');
        lines.push('DROP TABLE IF EXISTS users CASCADE;');
        lines.push('');

        // --- Sequenze ---
        lines.push('-- Sequenze per le chiavi primarie');
        lines.push('DROP SEQUENCE IF EXISTS users_id_seq CASCADE;');
        lines.push('DROP SEQUENCE IF EXISTS logs_id_seq CASCADE;');
        lines.push('CREATE SEQUENCE users_id_seq START 1;');
        lines.push('CREATE SEQUENCE logs_id_seq START 1;');
        lines.push('');

        // --- Tabella users ---
        lines.push('-- Tabella: users');
        lines.push('CREATE TABLE users (');
        lines.push('    id          INTEGER PRIMARY KEY DEFAULT nextval(\'users_id_seq\'),');
        lines.push('    nome_cognome TEXT,');
        lines.push('    pin          TEXT UNIQUE,');
        lines.push('    device_token TEXT UNIQUE,');
        lines.push('    device_user_agent TEXT,');
        lines.push('    is_active    BOOLEAN DEFAULT TRUE,');
        lines.push('    is_admin     BOOLEAN DEFAULT FALSE');
        lines.push(');');
        lines.push('');

        // --- Tabella logs ---
        lines.push('-- Tabella: logs');
        lines.push('CREATE TABLE logs (');
        lines.push('    id              INTEGER PRIMARY KEY DEFAULT nextval(\'logs_id_seq\'),');
        lines.push('    user_id         INTEGER,');
        lines.push('    timestamp       TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,');
        lines.push('    tipo_timbratura TEXT,');
        lines.push('    CONSTRAINT fk_logs_user FOREIGN KEY (user_id) REFERENCES users (id)');
        lines.push(');');
        lines.push('');

        // --- Dati users ---
        if (users.length > 0) {
            lines.push('-- Dati: users');
            for (const u of users) {
                lines.push(
                    `INSERT INTO users (id, nome_cognome, pin, device_token, device_user_agent, is_active, is_admin) VALUES (` +
                    `${escapeSql(u.id)}, ` +
                    `${escapeSql(u.nome_cognome)}, ` +
                    `${escapeSql(u.pin)}, ` +
                    `${escapeSql(u.device_token)}, ` +
                    `${escapeSql(u.device_user_agent)}, ` +
                    `${toBool(u.is_active)}, ` +
                    `${toBool(u.is_admin)}` +
                    `);`
                );
            }
            lines.push('');
        }

        // --- Dati logs ---
        if (logs.length > 0) {
            lines.push('-- Dati: logs');
            for (const l of logs) {
                // Normalizza timestamp da SQLite ("YYYY-MM-DD HH:MM:SS") a formato ISO
                const ts = l.timestamp ? l.timestamp.replace(' ', 'T') : null;
                lines.push(
                    `INSERT INTO logs (id, user_id, timestamp, tipo_timbratura) VALUES (` +
                    `${escapeSql(l.id)}, ` +
                    `${escapeSql(l.user_id)}, ` +
                    `${ts ? `'${ts}'` : 'NULL'}, ` +
                    `${escapeSql(l.tipo_timbratura)}` +
                    `);`
                );
            }
            lines.push('');
        }

        // --- Aggiorna le sequenze al valore massimo degli ID inseriti ---
        lines.push('-- Aggiorna le sequenze ai valori corretti dopo l\'import');
        lines.push("SELECT setval('users_id_seq', COALESCE((SELECT MAX(id) FROM users), 1));");
        lines.push("SELECT setval('logs_id_seq',  COALESCE((SELECT MAX(id) FROM logs),  1));");
        lines.push('');

        lines.push('-- ============================================================');
        lines.push('-- Fine migration');
        lines.push('-- ============================================================');

        fs.writeFileSync(outputSqlPath, lines.join('\n'), 'utf-8');
        console.log(`Esportazione completata con successo!`);
        console.log(`File SQL generato: ${outputSqlPath}`);
        console.log(`  - ${users.length} utenti`);
        console.log(`  - ${logs.length} timbrature`);
        console.log(`\nPer importare su PostgreSQL esegui:`);
        console.log(`  psql -U <utente> -d <database> -f migration.sql`);

    } catch (err) {
        console.error("Errore durante l'esportazione:", err.message);
    } finally {
        db.close();
    }
}

runExport();