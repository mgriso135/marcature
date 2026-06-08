require('dotenv').config();
const express = require('express');
const nunjucks = require('nunjucks');
const cookieParser = require('cookie-parser');
const { Pool } = require('pg');
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
app.use('/img', express.static(path.join(__dirname, 'img')));

// Setup Database PostgreSQL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

// Helper wrappers compatibili con sqlite3, adattati per pg
const run = async (query, params = []) => {
    return await pool.query(query, params);
};

const get = async (query, params = []) => {
    const res = await pool.query(query, params);
    return res.rows[0];
};

const all = async (query, params = []) => {
    const res = await pool.query(query, params);
    return res.rows;
};

// Formattatore di date per uniformità con formato stringa SQLite (YYYY-MM-DD HH:MM:SS)
function formatTimestamp(d) {
    if (!d) return '';
    const dateObj = d instanceof Date ? d : new Date(String(d).replace(' ', 'T'));
    if (isNaN(dateObj.getTime())) return String(d);
    const pad = n => n.toString().padStart(2, '0');
    return `${dateObj.getFullYear()}-${pad(dateObj.getMonth() + 1)}-${pad(dateObj.getDate())} ${pad(dateObj.getHours())}:${pad(dateObj.getMinutes())}:${pad(dateObj.getSeconds())}`;
}

async function initDB() {
    await run(`
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
    await run(`
        CREATE TABLE IF NOT EXISTS logs (
            id SERIAL PRIMARY KEY,
            user_id INTEGER,
            timestamp TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            tipo_timbratura TEXT,
            FOREIGN KEY (user_id) REFERENCES users (id)
        )
    `);

    // Crea admin predefinito se non esiste
    const admin = await get(`SELECT * FROM users WHERE is_admin = TRUE`);
    if (!admin) {
        await run(`INSERT INTO users (nome_cognome, pin, is_admin, is_active) VALUES ($1, $2, TRUE, TRUE)`, ['Amministratore', '0000']);
    }
}
initDB();

// Helper
async function getCurrentUser(device_token) {
    if (!device_token) return null;
    return await get(`SELECT * FROM users WHERE device_token = $1 AND is_active = TRUE`, [device_token]);
}

// --- ROTTE FRONTEND ---
app.get('/', async (req, res) => {
    /*const user = await getCurrentUser(req.cookies.device_token);
    const currentUserAgent = req.headers['user-agent'] || 'Sconosciuto';

    // Se l'utente non c'è, o se lo User-Agent registrato è diverso da quello attuale, blocchiamo l'accesso
    if (!user || (user.device_user_agent && user.device_user_agent !== currentUserAgent)) {
        return res.render('login.html');
    }*/
    const user = await getCurrentUser(req.cookies.device_token);
    const currentUserAgent = req.headers['user-agent'] || 'Sconosciuto';

    if (!user) {
        return res.render('login.html');
    }

    // Se lo User-Agent è cambiato, aggiornalo silenziosamente
    if (user.device_user_agent && user.device_user_agent !== currentUserAgent) {
        await run(`UPDATE users SET device_user_agent = $1 WHERE id = $2`, [currentUserAgent, user.id]);
    }
    
    const lastLog = await get(`SELECT tipo_timbratura FROM logs WHERE user_id = $1 ORDER BY timestamp DESC LIMIT 1`, [user.id]);
    user.last_status = lastLog ? lastLog.tipo_timbratura : null;

    return res.render('index.html', { user });
});

app.post('/api/login', async (req, res) => {
    try {
        const pin = req.body.pin;
        const user = await get(`SELECT * FROM users WHERE pin = $1`, [pin]);
        
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
        await run(`UPDATE users SET device_token = $1, device_user_agent = $2 WHERE id = $3`, [newToken, userAgent, user.id]);

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
    const lastLog = await get(`SELECT tipo_timbratura FROM logs WHERE user_id = $1 ORDER BY timestamp DESC LIMIT 1`, [user.id]);
    if (lastLog) {
        if (tipo === 'IN' && lastLog.tipo_timbratura === 'IN') {
            return res.status(400).json({ detail: "Hai già registrato l'entrata. Devi prima registrare l'uscita." });
        }
        if (tipo === 'OUT' && lastLog.tipo_timbratura === 'OUT') {
            return res.status(400).json({ detail: "Hai già registrato l'uscita. Devi prima registrare l'entrata." });
        }
    }

    await run(`INSERT INTO logs (user_id, tipo_timbratura, timestamp) VALUES ($1, $2, NOW())`, [user.id, tipo]);
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
    
    const users = await all(`SELECT * FROM users WHERE is_admin = FALSE`);
    
    // Calcolo presenze attuali
    const presenceData = await all(`
        SELECT u.id, u.nome_cognome, 
               (SELECT tipo_timbratura FROM logs WHERE user_id = u.id ORDER BY timestamp DESC LIMIT 1) as last_status
        FROM users u
        WHERE u.is_admin = FALSE AND u.is_active = TRUE
    `);
    const presentEmployees = presenceData.filter(u => u.last_status === 'IN');
    const absentEmployees = presenceData.filter(u => u.last_status !== 'IN');
    
    let query = `
        SELECT logs.*, users.nome_cognome 
        FROM logs 
        JOIN users ON logs.user_id = users.id 
        WHERE 1=1
    `;
    const params = [];
    let pIdx = 1;
    
    if (user_id) {
        query += ` AND logs.user_id = $${pIdx++}`;
        params.push(user_id);
    }
    if (start_date) {
        query += ` AND logs.timestamp::date >= $${pIdx++}`;
        params.push(start_date);
    }
    if (end_date) {
        query += ` AND logs.timestamp::date <= $${pIdx++}`;
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
        log.timestamp = formatTimestamp(log.timestamp);
        log.formatted_timestamp = log.timestamp; 
    });

    // Calcolo ore giornaliere lavorate per ciascun dipendente
    let logsQuery = `
        SELECT logs.*, users.nome_cognome 
        FROM logs 
        JOIN users ON logs.user_id = users.id
        WHERE users.is_admin = FALSE
    `;
    const logsParams = [];
    if (user_id) {
        logsQuery += ` AND logs.user_id = $1`;
        logsParams.push(user_id);
    }
    logsQuery += ` ORDER BY logs.user_id ASC, logs.timestamp ASC`;
    const allLogsForCalc = await all(logsQuery, logsParams);

    allLogsForCalc.forEach(log => {
        log.timestamp = formatTimestamp(log.timestamp);
    });

    const userDailyHours = {};
    const lastIn = {};

    function parseTimestamp(ts) {
        if (!ts) return null;
        return new Date(ts.replace(' ', 'T'));
    }

    allLogsForCalc.forEach(log => {
        const uId = log.user_id;
        if (log.tipo_timbratura === 'IN') {
            lastIn[uId] = log.timestamp;
        } else if (log.tipo_timbratura === 'OUT' && lastIn[uId]) {
            const inTime = parseTimestamp(lastIn[uId]);
            const outTime = parseTimestamp(log.timestamp);
            if (inTime && outTime) {
                const diffMs = outTime.getTime() - inTime.getTime();
                if (diffMs > 0) {
                    const dateStr = lastIn[uId].split(' ')[0]; // YYYY-MM-DD
                    const key = `${uId}_${dateStr}`;
                    if (!userDailyHours[key]) {
                        userDailyHours[key] = {
                            user_id: uId,
                            nome_cognome: log.nome_cognome,
                            date: dateStr,
                            ms: 0
                        };
                    }
                    userDailyHours[key].ms += diffMs;
                }
            }
            lastIn[uId] = null; // Reset per accoppiare la prossima coppia
        }
    });

    let dailyHoursList = Object.values(userDailyHours);
    if (start_date) {
        dailyHoursList = dailyHoursList.filter(item => item.date >= start_date);
    }
    if (end_date) {
        dailyHoursList = dailyHoursList.filter(item => item.date <= end_date);
    }

    dailyHoursList.forEach(item => {
        const totalMinutes = Math.round(item.ms / (1000 * 60));
        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;
        item.formatted_hours = `${hours}h ${minutes.toString().padStart(2, '0')}m`;
        
        const decVal = totalMinutes / 60;
        item.decimal_hours = decVal.toFixed(2);
        
        // Evidenzia in rosso se meno di 8 ore, giallo se più di 9 ore
        if (decVal < 8.0) {
            item.hours_status = 'underwork';
        } else if (decVal > 9.0) {
            item.hours_status = 'overtime';
        } else {
            item.hours_status = 'normal';
        }
    });

    dailyHoursList.sort((a, b) => {
        if (a.date !== b.date) {
            return b.date.localeCompare(a.date);
        }
        return a.nome_cognome.localeCompare(b.nome_cognome);
    });

    res.render('admin.html', { 
        users, 
        logs, 
        presentEmployees,
        absentEmployees,
        dailyHoursList,
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
        const existing = await get(`SELECT id FROM users WHERE pin = $1`, [pin]);
        if (existing) return res.status(400).json({ detail: 'PIN già in uso.' });

        await run(`INSERT INTO users (nome_cognome, pin, is_active, is_admin) VALUES ($1, $2, TRUE, FALSE)`, [nome_cognome, pin]);
        res.json({ status: 'ok' });
    } catch (e) {
        res.status(500).json({ detail: 'Errore interno del server' });
    }
});

app.post('/api/la-stanza-dei-bottoni/users/:id/reset', async (req, res) => {
    await run(`UPDATE users SET device_token = NULL WHERE id = $1`, [req.params.id]);
    res.json({ status: 'ok' });
});

app.delete('/api/la-stanza-dei-bottoni/users/:id', async (req, res) => {
    await run(`UPDATE users SET is_active = FALSE WHERE id = $1`, [req.params.id]);
    res.json({ status: 'ok' });
});

// Aggiungi record timbratura manualmente
app.post('/api/la-stanza-dei-bottoni/logs', async (req, res) => {
    try {
        const { user_id, tipo_timbratura, timestamp } = req.body;
        if (!user_id || !tipo_timbratura || !timestamp) return res.status(400).json({ detail: 'Dati mancanti.' });
        await run(`INSERT INTO logs (user_id, tipo_timbratura, timestamp) VALUES ($1, $2, $3)`, [user_id, tipo_timbratura, timestamp]);
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
        await run(`UPDATE logs SET tipo_timbratura = $1, timestamp = $2 WHERE id = $3`, [tipo_timbratura, timestamp, req.params.id]);
        res.json({ status: 'ok' });
    } catch (e) {
        res.status(500).json({ detail: 'Errore interno del server' });
    }
});

// Elimina record timbratura
app.delete('/api/la-stanza-dei-bottoni/logs/:id', async (req, res) => {
    await run(`DELETE FROM logs WHERE id = $1`, [req.params.id]);
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
    let pIdx = 1;
    
    if (user_id) {
        query += ` AND logs.user_id = $${pIdx++}`;
        params.push(user_id);
    }
    if (start_date) {
        query += ` AND logs.timestamp::date >= $${pIdx++}`;
        params.push(start_date);
    }
    if (end_date) {
        query += ` AND logs.timestamp::date <= $${pIdx++}`;
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
        const tsStr = formatTimestamp(l.timestamp);
        csv += `${l.id},"${l.nome_cognome}",${l.tipo_timbratura},${tsStr}\n`;
    });

    res.header('Content-Type', 'text/csv');
    res.attachment('timbrature.csv');
    return res.send(csv);
});

app.listen(port, '0.0.0.0', () => {
    console.log(`Server Node.js in ascolto su http://localhost:${port}`);
    console.log(`Pannello admin: http://localhost:${port}/la-stanza-dei-bottoni`);
});
