import Database from "better-sqlite3";
import path from "path";

const dbPath = path.join(process.cwd(), "database.sqlite");
const db = new Database(dbPath);

// បង្កើត Table ប្រសិនបមិនទាន់មាន (រក្សាទុកទិន្នន័យចាស់ ទោះបីជា Restart Server ក៏ដោយ)
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    plan TEXT,
    expire_at TEXT,
    active INTEGER DEFAULT 1
  );
`);

export default db;