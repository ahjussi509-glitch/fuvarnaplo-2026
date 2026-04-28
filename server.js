const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Adatbázis ──────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'fuvarnaplo.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS rides (
    id             TEXT PRIMARY KEY,
    year           INTEGER,
    month          INTEGER,
    day            INTEGER,
    amount         REAL,
    payType        TEXT,
    currency       TEXT,
    currencyAmount TEXT,
    time           TEXT,
    arrivalTime    TEXT,
    fromZone       TEXT,
    toZone         TEXT,
    category       TEXT,
    from_addr      TEXT,
    to_addr        TEXT,
    km             TEXT,
    pickupKm       TEXT,
    pickupTime     TEXT,
    note           TEXT
  );

  CREATE TABLE IF NOT EXISTS shifts (
    key      TEXT PRIMARY KEY,
    start    TEXT,
    end      TEXT,
    startKm  TEXT,
    endKm    TEXT,
    breaks   TEXT
  );

  CREATE TABLE IF NOT EXISTS goals (
    id      INTEGER PRIMARY KEY CHECK (id = 1),
    daily   REAL DEFAULT 0,
    weekly  REAL DEFAULT 0
  );

  INSERT OR IGNORE INTO goals (id, daily, weekly) VALUES (1, 0, 0);
`);

// ── Prepared statements ────────────────────────────────────
const stmts = {
  allRides:  db.prepare('SELECT * FROM rides ORDER BY year, month, day, time'),
  allShifts: db.prepare('SELECT * FROM shifts'),
  goals:     db.prepare('SELECT daily, weekly FROM goals WHERE id = 1'),

  upsertRide: db.prepare(`
    INSERT OR REPLACE INTO rides
      (id,year,month,day,amount,payType,currency,currencyAmount,
       time,arrivalTime,fromZone,toZone,category,from_addr,to_addr,
       km,pickupKm,pickupTime,note)
    VALUES
      (@id,@year,@month,@day,@amount,@payType,@currency,@currencyAmount,
       @time,@arrivalTime,@fromZone,@toZone,@category,@from_addr,@to_addr,
       @km,@pickupKm,@pickupTime,@note)
  `),

  deleteRide:  db.prepare('DELETE FROM rides WHERE id = ?'),
  clearRides:  db.prepare('DELETE FROM rides'),

  upsertShift: db.prepare(`
    INSERT OR REPLACE INTO shifts (key,start,end,startKm,endKm,breaks)
    VALUES (@key,@start,@end,@startKm,@endKm,@breaks)
  `),
  clearShifts: db.prepare('DELETE FROM shifts'),

  upsertGoals: db.prepare(
    'INSERT OR REPLACE INTO goals (id,daily,weekly) VALUES (1,?,?)'
  ),
};

// ── Helperek ──────────────────────────────────────────────
function rowToRide(r) {
  return {
    ...r,
    from: r.from_addr,
    to:   r.to_addr,
    category: (() => { try { return JSON.parse(r.category || '[]'); } catch { return []; } })(),
  };
}

function rowsToShifts(rows) {
  const obj = {};
  for (const s of rows) {
    const { key, ...rest } = s;
    rest.breaks = (() => { try { return JSON.parse(s.breaks || '[]'); } catch { return []; } })();
    obj[key] = rest;
  }
  return obj;
}

function rideToRow(r) {
  return {
    id:             r.id,
    year:           r.year,
    month:          r.month,
    day:            r.day,
    amount:         r.amount,
    payType:        r.payType        || '',
    currency:       r.currency       || '',
    currencyAmount: r.currencyAmount || '',
    time:           r.time           || '',
    arrivalTime:    r.arrivalTime    || '',
    fromZone:       r.fromZone       || '',
    toZone:         r.toZone         || '',
    category:       JSON.stringify(Array.isArray(r.category) ? r.category : []),
    from_addr:      r.from           || '',
    to_addr:        r.to             || '',
    km:             r.km             || '',
    pickupKm:       r.pickupKm       || '',
    pickupTime:     r.pickupTime     || '',
    note:           r.note           || '',
  };
}

// ── Middleware ─────────────────────────────────────────────
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── API végpontok ──────────────────────────────────────────

app.get('/api/data', (req, res) => {
  try {
    const rides  = stmts.allRides.all().map(rowToRide);
    const shifts = rowsToShifts(stmts.allShifts.all());
    const goals  = stmts.goals.get() || { daily: 0, weekly: 0 };
    res.json({ rides, shifts, goals });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.post('/api/rides', (req, res) => {
  try {
    const { rides } = req.body;
    if (!Array.isArray(rides)) return res.status(400).json({ error: 'rides must be array' });
    db.transaction(rides => { for (const r of rides) stmts.upsertRide.run(rideToRow(r)); })(rides);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.delete('/api/rides/:id', (req, res) => {
  try {
    stmts.deleteRide.run(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/shifts', (req, res) => {
  try {
    const { shifts } = req.body;
    db.transaction(shifts => {
      for (const [key, s] of Object.entries(shifts)) {
        stmts.upsertShift.run({
          key, start: s.start||'', end: s.end||'',
          startKm: s.startKm||'', endKm: s.endKm||'',
          breaks: JSON.stringify(s.breaks || []),
        });
      }
    })(shifts);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.post('/api/goals', (req, res) => {
  try {
    const { daily, weekly } = req.body;
    stmts.upsertGoals.run(daily || 0, weekly || 0);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/import', (req, res) => {
  try {
    const { rides = [], shifts = {}, goals = {} } = req.body;
    db.transaction(() => {
      stmts.clearRides.run();
      stmts.clearShifts.run();
      for (const r of rides) stmts.upsertRide.run(rideToRow(r));
      for (const [key, s] of Object.entries(shifts)) {
        stmts.upsertShift.run({
          key, start: s.start||'', end: s.end||'',
          startKm: s.startKm||'', endKm: s.endKm||'',
          breaks: JSON.stringify(s.breaks || []),
        });
      }
      if (goals.daily !== undefined || goals.weekly !== undefined) {
        stmts.upsertGoals.run(goals.daily || 0, goals.weekly || 0);
      }
    })();
    res.json({ ok: true, ridesImported: rides.length });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.delete('/api/all', (req, res) => {
  try {
    db.transaction(() => { stmts.clearRides.run(); stmts.clearShifts.run(); })();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('*', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

app.listen(PORT, () =>
  console.log(`🚕 Fuvarnapló fut: http://localhost:${PORT}`)
);
