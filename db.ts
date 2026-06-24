import sqlite3 from "sqlite3";

// បានប្តូរពី "./users.db" ទៅជា "./database.sqlite"
export const db = new sqlite3.Database("./database.sqlite");

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