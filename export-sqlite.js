const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

const sqliteDbPath = path.join(__dirname, 'presenze.db');
const outputJsonPath = path.join(__dirname, 'migration_data.json');

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

async function runExport() {
    try {
        const users = await all("SELECT * FROM users");
        console.log(`Esportati ${users.length} utenti.`);

        const logs = await all("SELECT * FROM logs");
        console.log(`Esportati ${logs.length} log di timbrature.`);

        const data = {
            users,
            logs
        };

        fs.writeFileSync(outputJsonPath, JSON.stringify(data, null, 2), 'utf-8');
        console.log(`Esportazione completata con successo! I dati sono salvati in: ${outputJsonPath}`);
    } catch (err) {
        console.error("Errore durante l'esportazione:", err.message);
    } finally {
        db.close();
    }
}

runExport();
