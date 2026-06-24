import { Pool } from "pg";

// ភ្ជាប់ទៅកាន់ Neon Cloud Database តាមរយៈ DATABASE_URL ដែលអ្នកបានដាក់លើ Render មិញនេះ
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// បង្កើត Table users នៅក្នុង Neon ស្វ័យប្រវត្តិ (បើមិនទាន់មាន)
async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        userId TEXT PRIMARY KEY,
        phoneNumber TEXT,
        expiredAt TEXT,
        geminiApiKey TEXT,
        plan TEXT DEFAULT '30 Days',
        deleted INTEGER DEFAULT 0
      )
    `);
    console.log("Database initialized successfully on Neon!");
  } catch (err) {
    console.error("Error initializing database on Neon:", err);
  }
}

initDb();