require('dotenv').config();
const express = require('express');
const nunjucks = require('nunjucks');
const cookieParser = require('cookie-parser');
const sqlite3 = require('sqlite3').verbose();
const { v4: uuidv4 } = require('uuid');
const path = require('path');

function basicAuth(req, res, next) {
    const authheader = req.headers.authorization;
    if (!authheader) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Area Protetta"');
        return res.status(401).send('Accesso negato.');
    }
    const auth = Buffer.from(authheader.split(' ')[1], 'base64').toString().split(':');
    const pass = auth[1];

    if (pass === process.env.ADMIN_PASSWORD) {
        next();
    } else {
        res.setHeader('WWW-Authenticate', 'Basic realm="Area Protetta"');
        return res.status(401).send('Password errata.');
    }
}

const app = express();
const port = 8000;

// Configurazione Nunjucks (motore template compatibile con Jinja2)
nunjucks.configure('templates', {
    autoescape: true,
    express: app
});
app.set('view engine', 'html');

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Setup Database
const db = new sqlite3.Database('./presenze.db');

// Wrapper per usare await con sqlite3
const run = (query, params = []) => new Promise((resolve, reject) => {
    db.run(query, params, function (err) {
        if (err) reject(err);
        else resolve(this);
    });
});
const get = (query, params = []) => new Promise((resolve, reject) => {
    db.get(query, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
    });
});
const all = (query, params = []) => new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
    });
});

async function initDB() {
    await run(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nome_cognome TEXT,
            pin TEXT UNIQUE,
            device_token TEXT UNIQUE,
            device_user_agent TEXT,
            is_active BOOLEAN DEFAULT 1,
            is_admin BOOLEAN DEFAULT 0
        )
    `);
    await run(`
        CREATE TABLE IF NOT EXISTS logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            tipo_timbratura TEXT,
            FOREIGN KEY (user_id) REFERENCES users (id)
        )
    `);

    try {
        await run(`ALTER TABLE users ADD COLUMN device_user_agent TEXT`);
    } catch (e) {
        // Ignora l'errore se la colonna esiste già
    }

    // Crea admin predefinito se non esiste
    const admin = await get(`SELECT * FROM users WHERE is_admin = 1`);
    if (!admin) {
        await run(`INSERT INTO users (nome_cognome, pin, is_admin, is_active) VALUES (?, ?, 1, 1)`, ['Amministratore', '0000']);
    }
}
initDB();

// Helper
async function getCurrentUser(device_token) {
    if (!device_token) return null;
    return await get(`SELECT * FROM users WHERE device_token = ? AND is_active = 1`, [device_token]);
}

// --- ROTTE FRONTEND ---
app.get('/', async (req, res) => {
    const user = await getCurrentUser(req.cookies.device_token);
    const currentUserAgent = req.headers['user-agent'] || 'Sconosciuto';

    // Se l'utente non c'è, o se lo User-Agent registrato è diverso da quello attuale, blocchiamo l'accesso
    if (!user || (user.device_user_agent && user.device_user_agent !== currentUserAgent)) {
        return res.render('login.html');
    }
    return res.render('index.html', { user });
});

app.post('/api/login', async (req, res) => {
    try {
        const pin = req.body.pin;
        const user = await get(`SELECT * FROM users WHERE pin = ?`, [pin]);
        
        if (!user) {
            return res.status(400).json({ detail: 'PIN non valido.' });
        }
        if (!user.is_active) {
            return res.status(400).json({ detail: 'Utente disattivato.' });
        }
        if (user.device_token) {
            return res.status(400).json({ detail: "PIN già associato a un altro dispositivo. Contatta l'amministratore." });
        }

        const newToken = uuidv4();
        const userAgent = req.headers['user-agent'] || 'Sconosciuto';
        await run(`UPDATE users SET device_token = ?, device_user_agent = ? WHERE id = ?`, [newToken, userAgent, user.id]);

        res.cookie('device_token', newToken, { maxAge: 315360000 * 1000, httpOnly: true }); // 10 anni
        res.json({ status: 'ok' });
    } catch (e) {
        res.status(500).json({ detail: 'Errore interno del server' });
    }
});

app.post('/api/timbra', async (req, res) => {
    const user = await getCurrentUser(req.cookies.device_token);
    if (!user) return res.status(401).json({ detail: 'Dispositivo non riconosciuto.' });

    const currentUserAgent = req.headers['user-agent'] || 'Sconosciuto';
    if (user.device_user_agent && user.device_user_agent !== currentUserAgent) {
        return res.status(403).json({ detail: 'Avviso di sicurezza: Il browser o il dispositivo non corrisponde a quello registrato in origine. Azione bloccata.' });
    }

    const { tipo } = req.body;
    if (tipo !== 'IN' && tipo !== 'OUT') return res.status(400).json({ detail: 'Tipo timbratura non valido.' });

    // Verifica l'ultima timbratura per evitare doppi IN o doppi OUT
    const lastLog = await get(`SELECT tipo_timbratura FROM logs WHERE user_id = ? ORDER BY timestamp DESC LIMIT 1`, [user.id]);
    if (lastLog) {
        if (tipo === 'IN' && lastLog.tipo_timbratura === 'IN') {
            return res.status(400).json({ detail: "Hai già registrato l'entrata. Devi prima registrare l'uscita." });
        }
        if (tipo === 'OUT' && lastLog.tipo_timbratura === 'OUT') {
            return res.status(400).json({ detail: "Hai già registrato l'uscita. Devi prima registrare l'entrata." });
        }
    }

    // SQLite usa UTC per default, convertiamo in locale se preferito o salviamo l'orario locale
    await run(`INSERT INTO logs (user_id, tipo_timbratura, timestamp) VALUES (?, ?, datetime('now', 'localtime'))`, [user.id, tipo]);
    res.json({ status: 'ok' });
});

app.post('/api/logout', (req, res) => {
    res.clearCookie('device_token');
    res.json({ status: 'ok' });
});

app.use('/la-stanza-dei-bottoni', basicAuth);
app.use('/api/la-stanza-dei-bottoni', basicAuth);

app.get('/la-stanza-dei-bottoni', async (req, res) => {
    const { user_id, start_date, end_date, sort_by, sort_order } = req.query;
    
    const users = await all(`SELECT * FROM users WHERE is_admin = 0`);
    
    let query = `
        SELECT logs.*, users.nome_cognome 
        FROM logs 
        JOIN users ON logs.user_id = users.id 
        WHERE 1=1
    `;
    const params = [];
    
    if (user_id) {
        query += ` AND logs.user_id = ?`;
        params.push(user_id);
    }
    if (start_date) {
        query += ` AND date(logs.timestamp) >= ?`;
        params.push(start_date);
    }
    if (end_date) {
        query += ` AND date(logs.timestamp) <= ?`;
        params.push(end_date);
    }

    let orderBy = 'logs.timestamp';
    let orderDir = 'DESC';

    if (sort_by === 'dipendente') orderBy = 'users.nome_cognome';
    else if (sort_by === 'data') orderBy = 'logs.timestamp';

    if (sort_order === 'asc' || sort_order === 'ASC') orderDir = 'ASC';
    
    query += ` ORDER BY ${orderBy} ${orderDir} LIMIT 150`;

    const logs = await all(query, params);

    logs.forEach(log => {
        log.formatted_timestamp = log.timestamp; 
    });

    res.render('admin.html', { 
        users, 
        logs, 
        filters: { 
            user_id: user_id || '', 
            start_date: start_date || '', 
            end_date: end_date || '',
            sort_by: sort_by || 'data',
            sort_order: orderDir.toLowerCase()
        } 
    });
});

app.post('/api/la-stanza-dei-bottoni/users', async (req, res) => {
    try {
        const { nome_cognome, pin } = req.body;
        const existing = await get(`SELECT id FROM users WHERE pin = ?`, [pin]);
        if (existing) return res.status(400).json({ detail: 'PIN già in uso.' });

        await run(`INSERT INTO users (nome_cognome, pin, is_active, is_admin) VALUES (?, ?, 1, 0)`, [nome_cognome, pin]);
        res.json({ status: 'ok' });
    } catch (e) {
        res.status(500).json({ detail: 'Errore interno del server' });
    }
});

app.post('/api/la-stanza-dei-bottoni/users/:id/reset', async (req, res) => {
    await run(`UPDATE users SET device_token = NULL WHERE id = ?`, [req.params.id]);
    res.json({ status: 'ok' });
});

app.delete('/api/la-stanza-dei-bottoni/users/:id', async (req, res) => {
    await run(`UPDATE users SET is_active = 0 WHERE id = ?`, [req.params.id]);
    res.json({ status: 'ok' });
});

// Aggiungi record timbratura manualmente
app.post('/api/la-stanza-dei-bottoni/logs', async (req, res) => {
    try {
        const { user_id, tipo_timbratura, timestamp } = req.body;
        if (!user_id || !tipo_timbratura || !timestamp) return res.status(400).json({ detail: 'Dati mancanti.' });
        await run(`INSERT INTO logs (user_id, tipo_timbratura, timestamp) VALUES (?, ?, ?)`, [user_id, tipo_timbratura, timestamp]);
        res.json({ status: 'ok' });
    } catch (e) {
        res.status(500).json({ detail: 'Errore interno del server' });
    }
});

// Modifica record timbratura
app.put('/api/la-stanza-dei-bottoni/logs/:id', async (req, res) => {
    try {
        const { tipo_timbratura, timestamp } = req.body;
        if (!tipo_timbratura || !timestamp) return res.status(400).json({ detail: 'Dati mancanti.' });
        await run(`UPDATE logs SET tipo_timbratura = ?, timestamp = ? WHERE id = ?`, [tipo_timbratura, timestamp, req.params.id]);
        res.json({ status: 'ok' });
    } catch (e) {
        res.status(500).json({ detail: 'Errore interno del server' });
    }
});

// Elimina record timbratura
app.delete('/api/la-stanza-dei-bottoni/logs/:id', async (req, res) => {
    await run(`DELETE FROM logs WHERE id = ?`, [req.params.id]);
    res.json({ status: 'ok' });
});

app.get('/api/la-stanza-dei-bottoni/export', async (req, res) => {
    const { user_id, start_date, end_date, sort_by, sort_order } = req.query;
    
    let query = `
        SELECT logs.*, users.nome_cognome 
        FROM logs 
        JOIN users ON logs.user_id = users.id 
        WHERE 1=1
    `;
    const params = [];
    
    if (user_id) {
        query += ` AND logs.user_id = ?`;
        params.push(user_id);
    }
    if (start_date) {
        query += ` AND date(logs.timestamp) >= ?`;
        params.push(start_date);
    }
    if (end_date) {
        query += ` AND date(logs.timestamp) <= ?`;
        params.push(end_date);
    }

    let orderBy = 'logs.timestamp';
    let orderDir = 'DESC';

    if (sort_by === 'dipendente') orderBy = 'users.nome_cognome';
    else if (sort_by === 'data') orderBy = 'logs.timestamp';

    if (sort_order === 'asc' || sort_order === 'ASC') orderDir = 'ASC';
    
    query += ` ORDER BY ${orderBy} ${orderDir}`;

    const logs = await all(query, params);
    
    let csv = 'ID,Dipendente,Tipo,Data Ora\n';
    logs.forEach(l => {
        csv += `${l.id},"${l.nome_cognome}",${l.tipo_timbratura},${l.timestamp}\n`;
    });

    res.header('Content-Type', 'text/csv');
    res.attachment('timbrature.csv');
    return res.send(csv);
});

app.listen(port, '0.0.0.0', () => {
    console.log(`Server Node.js in ascolto su http://localhost:${port}`);
    console.log(`Pannello admin: http://localhost:${port}/la-stanza-dei-bottoni`);
});
