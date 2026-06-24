import Database from "better-sqlite3";

export const db = new Database("users.db");

// បង្កើត Table users ផ្អែកលើ better-sqlite3
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    userId TEXT PRIMARY KEY,
    phoneNumber TEXT,
    expiredAt TEXT,
    geminiApiKey TEXT,
    plan TEXT DEFAULT '30 Days'
  )
`);

try {
  db.exec(`
    ALTER TABLE users
    ADD COLUMN plan TEXT DEFAULT '30 Days'
  `);
} catch {}