const fs = require('fs');
const path = require('path');

// File-backed data store so the backend survives restarts.
// (Replaces the previous pure in-memory db that lost all data on restart.)
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json');

let db = { users: [], verificationCodes: {} };

function loadDb() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      db = {
        users: Array.isArray(parsed.users) ? parsed.users : [],
        verificationCodes: parsed.verificationCodes || {},
      };
      console.log(`Loaded ${db.users.length} user(s) from ${DATA_FILE}`);
    } else {
      console.log(`No data file at ${DATA_FILE}, starting with an empty database`);
    }
  } catch (err) {
    console.error('Failed to load database, starting fresh:', err.message);
    db = { users: [], verificationCodes: {} };
  }
  return db;
}

function saveDb() {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
  } catch (err) {
    console.error('Failed to save database:', err.message);
  }
}

module.exports = { loadDb, saveDb, getDb: () => db };
