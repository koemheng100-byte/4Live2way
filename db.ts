import { Pool } from "pg";

// ភ្ជាប់ទៅកាន់ Neon Cloud Database
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// បង្កើត Table users នៅក្នុង Neon (បើមិនទាន់មាន)
// យើងបន្ថែម usedMinutes និង lastUsedDate ដើម្បីកំណត់ ៥ ម៉ោងប្រចាំថ្ងៃ
async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        userId TEXT PRIMARY KEY,
        phoneNumber TEXT,
        expiredAt TEXT,
        geminiApiKey TEXT,
        plan TEXT DEFAULT '30 Days',
        deleted INTEGER DEFAULT 0,
        usedMinutes REAL DEFAULT 0,       -- 🔥 ចំនួននាទីដែលបានប្រើសរុបក្នុងថ្ងៃនេះ
        lastUsedDate TEXT DEFAULT ''      -- 🔥 ថ្ងៃខែចុងក្រោយដែលបានប្រើ (ឧទាហរណ៍៖ "2026-03-29")
      )
    `);
    console.log("Database initialized successfully on Neon!");
  } catch (err) {
    console.error("Error initializing database:", err);
  }
}

initDb();