import sqlite3 from "sqlite3";

export const db = new sqlite3.Database("./users.db");

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      userId TEXT PRIMARY KEY,
      phoneNumber TEXT,
      expiredAt TEXT,
      geminiApiKey TEXT
    )
  `);
});