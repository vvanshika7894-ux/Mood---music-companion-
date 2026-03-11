const Database = require("better-sqlite3");
const path = require("path");
const { app } = require("electron");

// Safe location
const dbPath = path.join(app.getPath("userData"), "moodmusic.db");

const db = new Database(dbPath);

// Performance + reliability
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
`);

// USERS TABLE
db.exec(`
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`);

// 🔥 NEW: TRANSITIONS TABLE
db.exec(`
CREATE TABLE IF NOT EXISTS transitions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    current_mood TEXT NOT NULL,
    desired_mood TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS transition_tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transition_id INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  source TEXT,
  name TEXT,
  artist_name TEXT,
  audio TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(transition_id) REFERENCES transitions(id) ON DELETE CASCADE
);
`);


module.exports = db;
