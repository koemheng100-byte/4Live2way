import Database from "better-sqlite3";
import path from "path";

// បង្កើត ឬភ្ជាប់ទៅកាន់ database.sqlite
const dbPath = path.join(process.cwd(), "database.sqlite");
const db = new Database(dbPath);

// បង្កើត Table users បើមិនទាន់មាន (បន្ថែម token TEXT UNIQUE)
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    token TEXT UNIQUE,
    plan TEXT,
    expire_at TEXT,
    active INTEGER DEFAULT 1
  );
`);

export default db;