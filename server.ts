import "dotenv/config";
import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { WebSocketServer } from "ws";
import { GoogleGenAI, Modality } from "@google/genai";
import { pool } from "./db";
import { Telegraf } from "telegraf"; // 🔥 បន្ថែមសម្រាប់ Telegram
import axios from "axios"; // 🔥 បន្ថែមសម្រាប់បាញ់ទៅ Google Vision API

// ==========================================
// ផ្នែកទី ១៖ បញ្ជី API Keys ហ្វ្រីទាំងអស់ (Round Robin)
// ==========================================
const GEMINI_KEYS_POOL = [
  "AIzaSyA5y993SdsdPRn9igoF_d1AlHX2vAmLB24", // Key ទី ១ (Account A)
  "AIzaSyCqvwRA_G9ybcPSDdjOmYrs7TQ33cC6990", // Key ទី ២ (Account B)
  "AQ.Ab8RN6IzjyMLPaN9WVVVi-i4X36YUf0jAZrfMpD9VBfNQ2fkNQ", // Key ទី ៣ (Account C)
    // ដាក់ Key ផ្សេងទៀតដែលមានចូលក្នុងនេះ...
];

let currentKeyIndex = 0;

function getNextGeminiKey() {
  if (GEMINI_KEYS_POOL.length === 0) return null; //
  const key = GEMINI_KEYS_POOL[currentKeyIndex]; //
  currentKeyIndex = (currentKeyIndex + 1) % GEMINI_KEYS_POOL.length; //
  return key; //
}

// ==========================================
// 🔥 ផ្នែកថ្មី៖ មុខងារស្កែនអាន Slip តាម Google Vision
// ==========================================
async function analyzeSlipText(imageUrl: string): Promise<string> {
  const apiKey = process.env.GOOGLE_VISION_API_KEY;
  if (!apiKey) return "";
  
  const url = `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`;
  const requestBody = {
    requests: [
      {
        image: { source: { imageUri: imageUrl } },
        features: [{ type: "TEXT_DETECTION" }]
      }
    ]
  };

  try {
    const response = await axios.post(url, requestBody);
    const text = response.data.responses[0]?.fullTextAnnotation?.text;
    return text || "";
  } catch (err) {
    console.error("Google Vision Error:", err);
    return "";
  }
}

async function startServer() {
  const app = express();
  app.use(express.json()); //
  app.use(express.static("public")); //

  const PORT = Number(process.env.PORT) || 3000; //

  console.log("Default Environment API KEY:", process.env.GEMINI_API_KEY ? "FOUND" : "MISSING"); //

  // ==========================================
  // 🔥 ផ្នែកថ្មី៖ បង្កើត និងកំណត់តួនាទី Telegram Bot ស្វ័យប្រវត្តិ
  // ==========================================
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (botToken) {
    const bot = new Telegraf(botToken);

    // ពេលភ្ញៀវចុច /start លើ Bot
    bot.start((ctx) => {
      ctx.reply(
        "👋 សួស្ដី! ខ្ញុំជាប្រព័ន្ធទទួលការទូទាត់ប្រាក់ស្វ័យប្រវត្តរបស់ 4LIVE 2WAY។\n\n" +
        "👉 សូមផ្ញើរូបភាពវិក្កយបត្រ (Slip) បង់ប្រាក់របស់អ្នកចូលទីនេះ រួចវាយលេខ User ID របស់អ្នកនៅក្នុង Caption (ចំណងជើងរូបភាព) ដើម្បីឱ្យប្រព័ន្ធឆែក និងបើកគម្រោងជូនភ្លាមៗ!"
      );
    });

    // ពេលភ្ញៀវផ្ញើរូបភាពចូល
    bot.on("photo", async (ctx) => {
      const userId = ctx.message.caption?.trim(); // យក User ID ពី Caption
      
      if (!userId) {
        return ctx.reply("❌ សូមផ្ញើរូបភាព Slip ម្តងទៀត ដោយវាយបញ្ចូលលេខ User ID របស់អ្នកនៅក្នុង Caption (ចំណងជើងរូបភាព) ផង!");
      }

      ctx.reply("⏳ ប្រព័ន្ធកំពុងពិនិត្យវិក្កយបត្ររបស់អ្នក ដោយស្វ័យប្រវត្ត... សូមរង់ចាំមួយភ្លែត។");

      try {
        // ១. ទាញយក Link រូបភាពពី Telegram
        const photo = ctx.message.photo[ctx.message.photo.length - 1];
        const fileLink = await ctx.telegram.getFileLink(photo.file_id);
        const imageUrl = fileLink.href;

        // ២. ឱ្យ Google Vision អានអក្សរលើ Slip
        const slipText = await analyzeSlipText(imageUrl);
        const lowerSlipText = slipText.toLowerCase();
        console.log(`--- ទិន្នន័យអានបានពី User ${userId} ---`, lowerSlipText);

        // ៣. ពិនិត្យលក្ខខណ្ឌជោគជ័យ
        const isSuccessful = 
          lowerSlipText.includes("successful") || 
          lowerSlipText.includes("success") || 
          lowerSlipText.includes("ជោគជ័យ") || 
          lowerSlipText.includes("ផ្ទេរប្រាក់ដោយជោគជ័យ");

        if (!isSuccessful) {
          return ctx.reply("❌ វិក្កយបត្រនេះមិនទាន់មានស្ថានភាពផ្ទេរប្រាក់ជោគជ័យ ឬរូបភាពមិនច្បាស់ឡើយ។");
        }

        // ៤. ឆែករកមើលគម្រោងតម្លៃនៅលើ Slip ស្វ័យប្រវត្តិ
        let daysToAdd = 0;
        let planName = "";

        if (lowerSlipText.includes("0.50") || lowerSlipText.includes("0,50")) {
          daysToAdd = 1;
          planName = "1 Day";
        } else if (lowerSlipText.includes("1.00") || lowerSlipText.includes("1,00")) {
          daysToAdd = 7;
          planName = "1 Week";
        } else if (lowerSlipText.includes("3.00") || lowerSlipText.includes("3,00") || lowerSlipText.includes("12,000")) {
          // ដុតទាំងតម្លៃរៀល (ប្រហែល 12,000៛) ក្នុងករណីមាន
          daysToAdd = 30;
          planName = "30 Days";
        }

        // បើឆែកតម្លៃលុយទៅរកមិនឃើញគម្រោងណាមួយឡើយ
        if (daysToAdd === 0) {
          return ctx.reply("❌ ចំនួនទឹកប្រាក់នៅលើ Slip មិនត្រូវនឹងគម្រោងណាមួយឡើយ (គម្រោងមាន៖ 0.50$, 1.00$, 3.00$)។");
        }

        // ៥. គណនាថ្ងៃ Expired ថ្មី (បូកបន្ថែមថ្ងៃពីលើថ្ងៃបច្ចុប្បន្ន)
        const now = new Date();
        now.setDate(now.getDate() + daysToAdd);
        const expiredAtStr = now.toISOString().split('T')[0]; // ទម្រង់ YYYY-MM-DD

        // ៦. រត់កូដកែប្រែទិន្នន័យក្នុង Database Neon ភ្លាមៗ
        const checkUser = await pool.query("SELECT * FROM users WHERE userid = $1", [userId]);
        
        if (checkUser.rows.length === 0) {
          // បើរកមិនឃើញ User ទេ គឺបង្កើតថ្មីឱ្យតែម្តង
          await pool.query(
            "INSERT INTO users (userid, expiredat, plan) VALUES ($1, $2, $3)",
            [userId, expiredAtStr, planName]
          );
        } else {
          // បើមាន User ស្រាប់ គឺកែប្រែថ្ងៃផុតកំណត់ និងឈ្មោះគម្រោង
          await pool.query(
            "UPDATE users SET expiredat = $1, plan = $2 WHERE userid = $3",
            [expiredAtStr, planName, userId]
          );
        }

        ctx.reply(`✅ អបអរសាទរ! ការទូទាត់ត្រឹមត្រូវ។ គម្រោង "${planName}" របស់ User ID: ${userId} ត្រូវបានបើកដោយស្វ័យប្រវត្តហើយ! ផុតកំណត់ថ្ងៃទី៖ ${expiredAtStr}`);

      } catch (error) {
        console.error("Bot Processing Error:", error);
        ctx.reply("💥 មានបញ្ហាបច្ទេកទេសក្នុងការពិនិត្យ Slip។ ក្រុមការងារនឹងពិនិត្យជូនផ្ទាល់ដៃ!");
      }
    });

    // ភ្ជាប់ Webhook ជាមួយ Render Server របស់អ្នក
    const appUrl = process.env.APP_URL || "https://fourlive2way.onrender.com";
    app.use(bot.webhookCallback("/webhook/telegram"));
    bot.telegram.setWebhook(`${appUrl}/webhook/telegram`);
    console.log(`🤖 Telegram Bot Webhook set to: ${appUrl}/webhook/telegram`);
  }

  // ១. API សម្រាប់ Client ឆែកស្ថានភាព ID របស់ខ្លួន
  app.get("/api/check-status/:userId", async (req, res) => {
    const { userId } = req.params; //

    try {
      const result = await pool.query("SELECT * FROM users WHERE userid = $1 AND deleted != 1", [userId]); //
      const user = result.rows[0]; //

      if (!user) {
        return res.json({ //
          active: false, //
          expiredAt: null, //
          phoneNumber: "" //
        });
      }

      const isExpired = new Date() > new Date(user.expiredat); //

      res.json({
        active: !isExpired, //
        expiredAt: user.expiredat, //
        phoneNumber: user.phonenumber || "" //
      });
    } catch (err) {
      res.status(500).json({ error: "Database error occurred." }); //
    }
  });

  // ២. API សម្រាប់ឱ្យ Client ផ្ញើលេខទូរស័ព្ទមក Save ភ្ជាប់ជាមួយ ID
  app.post("/api/save-phone", async (req, res) => {
    const { userId, phoneNumber } = req.body; //
    if (!userId) return res.status(400).json({ error: "Missing userId" }); //

    try {
      const result = await pool.query("SELECT * FROM users WHERE userid = $1 AND deleted != 1", [userId]); //
      const user = result.rows[0]; //

      if (!user) {
        return res.status(404).json({ //
          error: "User not found" //
        });
      }

      await pool.query(`
        UPDATE users
        SET phonenumber = $1
        WHERE userid = $2
      `, [phoneNumber, userId]); //

      res.json({ success: true, message: "រក្សាទុកលេខទូរស័ព្ទជោគជ័យ" }); //
    } catch (err: any) {
      return res.status(500).json({ error: err.message }); //
    }
  });

  // ៣. API សម្រាប់ឱ្យ Admin ទាញយកទិន្នន័យ User ទាំងអស់មកមើល និងគណនាស្ថិតិ
  app.post("/api/admin/users", async (req, res) => {
    const { password } = req.body; //

    if (password !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ error: "លេខសម្ងាត់មិនត្រឹមត្រូវ!" }); //
    }

    try {
      const result = await pool.query("SELECT * FROM users ORDER BY expiredat DESC"); //
      const rows = result.rows; //

      const activeUsers = rows.filter(
        u => new Date(u.expiredat).getTime() > Date.now() //
      ).length;

      const expiredUsers = rows.length - activeUsers; //

      res.json({
        success: true, //
        totalUsers: rows.length, //
        activeUsers, //
        expiredUsers, //
        users: rows.map(u => ({
          userId: u.userid, //
          phoneNumber: u.phonenumber, //
          expiredAt: u.expiredat, //
          geminiApiKey: u.geminiapikey, //
          plan: u.plan, //
          deleted: u.deleted, //
          apiDisplay: u.geminiapikey //
            ? u.geminiapikey.substring(0, 20) + "..." //
            : "ENV DEFAULT KEY" //
        })),
        envApiKey: process.env.GEMINI_API_KEY || "មិនទាន់មាន Key ក្នុង .env ទេ" //
      });
    } catch (err) {
      res.status(500).json({ error: "Database error" }); //
    }
  });

  // ៤. API សម្រាប់ Admin លុប User (លុបដាច់)
  app.post("/api/admin/delete-user", async (req, res) => {
    const { password, userId } = req.body; //

    if (password !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ error: "លេខសម្ងាត់មិនត្រឹមត្រូវ!" }); //
    }

    try {
      await pool.query("DELETE FROM users WHERE userid = $1", [userId]); //
      res.json({ success: true, message: "បានលុប User នេះដាច់ដោយជោគជ័យ!" }); //
    } catch (err) {
      res.status(500).json({ error: "មិនអាចលុបបានទេ!" }); //
    }
  });

  // ៥. API សម្រាប់ Admin ផ្អាកការប្រើប្រាស់របស់ User
  app.post("/api/admin/suspend-user", async (req, res) => {
    const { password, userId } = req.body; //

    if (password !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ error: "Password មិនត្រឹមត្រូវ" }); //
    }

    try {
      await pool.query(
        "UPDATE users SET expiredat = $1 WHERE userid = $2", //
        [new Date(0).toISOString(), userId] //
      );
      res.json({ success: true }); //
    } catch (err: any) {
      return res.status(500).json({ error: err.message }); //
    }
  });

  // ៦. API សម្រាប់ Admin បើកដំណើរការ User ឡើងវិញ (Reactivate)
  app.post("/api/admin/reactivate-user", async (req, res) => {
    const { password, userId, days, plan } = req.body; //

    if (password !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ error: "Password មិនត្រឹមត្រូវ" }); //
    }

    try {
      const expiredAt = new Date(
        Date.now() + (days || 30) * 24 * 60 * 60 * 1000 //
      ).toISOString();

      await pool.query(
        "UPDATE users SET expiredat = $1, plan = $2, deleted = 0 WHERE userid = $3", //
        [expiredAt, plan || "30 Days", userId] //
      );

      res.json({ success: true }); //
    } catch (err: any) {
      return res.status(500).json({ error: err.message }); //
    }
  });

  // ៧. API សម្រាប់ Admin កំណត់ ឬប្តូរ API Key និងថ្ងៃផុតកំណត់ឱ្យ User ID (ON CONFLICT)
  app.post("/api/admin/set-user", async (req, res) => {
    const { password, userId, days, plan, geminiApiKey } = req.body; //

    if (password !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ error: "លេខសម្ងាត់មិនត្រឹមត្រូវ!" }); //
    }

    const daysNum = Number(days) || 30; //
    const expiredDate = new Date(); //
    expiredDate.setDate(expiredDate.getDate() + daysNum); //

    try {
      await pool.query(`
        INSERT INTO users (userid, phonenumber, expiredat, geminiapikey, plan, deleted)
        VALUES ($1, $2, $3, $4, $5, 0)
        ON CONFLICT (userid) 
        DO UPDATE SET 
          expiredat = EXCLUDED.expiredat,
          geminiapikey = EXCLUDED.geminiapikey,
          plan = EXCLUDED.plan,
          deleted = 0
      `, [userId, "", expiredDate.toISOString(), geminiApiKey || null, plan || "30 Days"]); //

      res.json({ success: true }); //
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "មិនអាចរក្សាទុកក្នុង Database បានទេ!" }); //
    }
  });

  // ៨. API សម្រាប់ Admin ធ្វើបច្ចុប្បន្នភាព Plan របស់ User
  app.post("/api/admin/update-plan", async (req, res) => {
    const { password, userId, plan, days } = req.body; //

    if (password !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ //
        error: "Password មិនត្រឹមត្រូវ" //
      });
    }

    try {
      const newExpiredAt = new Date(
        Date.now() + (days || 30) * 24 * 60 * 60 * 1000 //
      ).toISOString();

      await pool.query(
        "UPDATE users SET plan = $1, expiredat = $2 WHERE userid = $3", //
        [plan, newExpiredAt, userId] //
      );

      res.json({ success: true }); //
    } catch (err: any) {
      return res.status(500).json({ error: err.message }); //
    }
  });

  // ៩. API សម្រាប់ទទួលការកែប្រែ API Key ផ្ទាល់ខ្លួនរបស់ User
  app.post("/api/admin/update-api-key", async (req, res) => {
    const { password, userId, geminiApiKey } = req.body; //

    if (password !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ error: "Password មិនត្រឹមត្រូវ" }); //
    }

    try {
      await pool.query(
        "UPDATE users SET geminiapikey = $1 WHERE userid = $2", //
        [geminiApiKey || null, userId] //
      );

      res.json({ success: true, message: "ធ្វើបច្ចុប្បន្នភាព API Key ជោគជ័យ" }); //
    } catch (err: any) {
      return res.status(500).json({ error: err.message }); //
    }
  });

  // 🔥 API សម្រាប់ទទួលបញ្ជាពីប្រព័ន្ធអូតូ (Telegram Bot / Webhook)
  app.post("/api/payment/auto-approve", async (req, res) => {
    const { userId, secretToken, days } = req.body;

    if (secretToken !== "HENG_AUTO_SECRET_TOKEN_999") {
      return res.status(401).json({ error: "ការបញ្ជូនទិន្នន័យមិនមានសុវត្ថិភាព!" });
    }

    if (!userId) {
      return res.status(400).json({ error: "ខ្វះ User ID របស់ម៉ាស៊ីន" });
    }

    const daysNum = Number(days) || 30; 
    const expiredDate = new Date();
    expiredDate.setDate(expiredDate.getDate() + daysNum);

    try {
      await pool.query(`
        INSERT INTO users (userid, phonenumber, expiredat, plan, deleted, usedminutes)
        VALUES ($1, $2, $3, $4, 0, 0)
        ON CONFLICT (userid) 
        DO UPDATE SET 
          expiredat = EXCLUDED.expiredat,
          plan = EXCLUDED.plan,
          deleted = 0
      `, [userId, "", expiredDate.toISOString(), `${daysNum} Days (Telegram Auto)`]);

      console.log(`🤖 [Auto-Approve] បានបើកថ្ងៃឱ្យ ID: ${userId} ចំនួន ${daysNum} ថ្ងៃជោគជ័យ!`);
      res.json({ success: true, message: `បានថែមជូន ${daysNum} ថ្ងៃដោយជោគជ័យ!` });
    } catch (err) {
      console.error("Auto approve error:", err);
      res.status(500).json({ error: "មានបញ្ហាបច្ទេកទេសក្នុង Database" });
    }
  });

  // Route សម្រាប់ Admin Page
  app.get("/admin.html", (req, res) => {
    res.sendFile(path.join(process.cwd(), "public", "admin.html")); //
  });

  if (process.env.NODE_ENV === "production") {
    const distPath = path.join(process.cwd(), 'dist'); //
    app.use(express.static(distPath)); //
    app.get('*', (req, res) => res.sendFile(path.join(distPath, 'index.html'))); //
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true }, //
      appType: "spa", //
    });
    app.use(vite.middlewares); //
  }

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`); //
  });

  const wss = new WebSocketServer({ server }); //
  
  // ==========================================
  // ⚡ ផ្នែក WebSocket សម្រាប់ Gemini Live (រក្សាទុកកូដចាស់របស់អ្នកដដែលទាំងស្រុង)
  // ==========================================
  wss.on("connection", async (clientWs, req) => {
    console.log("Client connected via WebSocket"); //
    
    const url = new URL(req.url || "", `http://${req.headers.host || "localhost"}`); //
    const source = url.searchParams.get("source") || "km"; //
    const target = url.searchParams.get("target") || "en"; //
    const userId = url.searchParams.get("userId") || ""; //

    const startTime = Date.now(); // 🔥 គណនាម៉ោងចាប់ផ្ដើមនិយាយ

    try {
      // 🔥 ១. ឆែកមើលទិន្នន័យ User ពី Database
      const result = await pool.query("SELECT * FROM users WHERE userid = $1 AND deleted != 1", [userId]); //
      const user = result.rows[0]; //

      if (!user) {
        clientWs.send(JSON.stringify({ error: "User ID នេះមិនមានក្នុងប្រព័ន្ធ ឬត្រូវបានលុបចោលហើយ!" })); //
        clientWs.close(); //
        return; //
      }

      const isExpired = new Date() > new Date(user.expiredat); //
      if (isExpired) {
        clientWs.send(JSON.stringify({ error: "គណនីរបស់អ្នកបានហួសកាលកំណត់ប្រើប្រាស់ហើយ (Expired)!" })); //
        clientWs.close(); //
        return; //
      }

      // 🔥 ២. ប្រព័ន្ធកំណត់ ៥ ម៉ោង (៣០០ នាទី) ប្រចាំថ្ងៃ
      const todayStr = new Date().toISOString().split('T')[0]; // ទាញយកថ្ងៃខែថ្ងៃនេះ
      let currentUsedMinutes = Number(user.usedminutes) || 0; //

      // ក. បើចូលដល់ថ្ងៃថ្មី ត្រូវ Reset នាទីឱ្យបាននិយាយ ០ នាទីឡើងវិញដោយស្វ័យប្រវត្ត
      if (user.lastuseddate !== todayStr) {
        try {
          await pool.query("UPDATE users SET usedminutes = 0, lastuseddate = $1 WHERE userid = $2", [todayStr, userId]); //
          currentUsedMinutes = 0; //
          console.log(`User ${userId} - Daily usage reset to 0 for new date ${todayStr}`); //
        } catch (err) {
          console.error("Error resetting daily minutes:", err); //
        }
      }

      // ខ. ឆែកមើលលក្ខខណ្ឌ ៥ ម៉ោង (៣០០ នាទី)
      if (currentUsedMinutes >= 300) {
        clientWs.send(JSON.stringify({ error: "អ្នកបានប្រើប្រាស់អស់កំណត់ ៥ ម៉ោងសម្រាប់ថ្ងៃនេះហើយ! សូមរង់ចាំស្អែកទើបអាចប្រើបានម្តងទៀត。" })); //
        clientWs.close(); //
        return; //
      }

      // 🔥 គ. ជ្រើសរើស Key: បើ User មាន Key ខ្លួនឯង ប្រើ Key ខ្លួនឯង បើអត់ទេប្រើ Key បង្វិលជុំ (Pool)
      let apiKeyToUse = user.geminiapikey || getNextGeminiKey(); //

      if (!apiKeyToUse) {
        console.error("Connection rejected: No API Key found in server environment."); //
        clientWs.send(JSON.stringify({ error: "Server missing Gemini API Key configuration." })); //
        clientWs.close(); //
        return; //
      }
      
      const ai = new GoogleGenAI({
        apiKey: apiKeyToUse, //
        httpOptions: {
          headers: { 'User-Agent': 'aistudio-build' } //
        }
      });

      const langNames: Record<string, string> = {
        'km': 'Khmer', 'en': 'English', 'zh': 'Chinese (Mandarin)', 'zh-HK': 'Cantonese', //
        'vi': 'Vietnamese', 'ja': 'Japanese', 'ko': 'Korean', 'th': 'Thai', //
        'id': 'Indonesian', 'ms': 'Malay', 'lo': 'Lao', 'fr': 'French', //
        'de': 'German', 'no': 'Norwegian', 'hi': 'Hindi', 'fil': 'Filipino', //
        'mn': 'Mongolian', 'it': 'Italian', 'he': 'Hebrew', 'ru': 'Russian', 'my': 'Burmese' //
      };

      const lang1Name = langNames[source] || source; //
      const lang2Name = langNames[target] || target; //

      const systemInstruction = `
You are a strict real-time translator.
Selected language pair: A = ${lang1Name}, B = ${lang2Name}
Translation rules:
1. If the input is ${lang1Name}, translate ONLY to ${lang2Name}.
2. If the input is ${lang2Name}, translate ONLY to ${lang1Name}.
3. Any language other than ${lang1Name} or ${lang2Name} MUST ALWAYS be translated into ${lang2Name}.
4. Never alternate translation direction. Never infer speaker roles.
5. Never use conversation history to decide direction. Treat every utterance independently.
6. Translate only. Never explain, answer, summarize, or chat.
`; //

      console.log(`Live 2-Way Interpreter Active: [${lang1Name} ↔ ${lang2Name}] for User: ${userId}`); //
      
      let liveSession: any = null; //

      // 🔥 ប្រព័ន្ធ Idle Timeout (២ នាទីផ្ដាច់)
      let idleTimeoutTimer: NodeJS.Timeout; //
      
      function resetIdleTimeout() {
        clearTimeout(idleTimeoutTimer); //
        idleTimeoutTimer = setTimeout(() => {
          console.log(`User ${userId} ត្រូវដាច់ដោយស្វ័យប្រវត្ត ព្រោះមិននិយាយលើសពី ២ នាទី។`); //
          clientWs.send(JSON.stringify({ error: "អ្នកបានផ្អាកការនិយាយលើសពី ២ នាទី ដើម្បីសន្សំសំចៃប្រព័ន្ធ។ សូមភ្ជាប់ឡើងវិញបើចង់និយាយបន្តClient" })); //
          clientWs.close(); //
        }, 120000); // ១២០,០០០ មីលីវិនាទី = ២ នាទី
      }

      // ចាប់ផ្ដើម Timer ភ្លាមៗពេលភ្ជាប់
      resetIdleTimeout(); //

      try {
        liveSession = await ai.live.connect({
          model: "gemini-3.1-flash-live-preview", //
          config: {
            responseModalities: [Modality.AUDIO], //
            outputAudioTranscription: {}, //
            inputAudioTranscription: {}, //
            systemInstruction, //
          },
          callbacks: {
            onmessage: (message: any) => {
              if (clientWs.readyState !== clientWs.OPEN) return; //

              const audio = message.serverContent?.modelTurn?.parts
                ?.find((p: any) => p.inlineData)?.inlineData?.data; //

              const inputTranscript = message.inputAudioTranscription?.text; //
              const outputTranscript = message.outputAudioTranscription?.text; //
              const interrupted = message.serverContent?.interrupted; //

              if (audio || inputTranscript || outputTranscript || interrupted) {
                clientWs.send(JSON.stringify({ audio, inputTranscript, outputTranscript, interrupted })); //
              }
            },
          },
        });

        clientWs.on("message", (data) => {
          // 🔥 រាល់ពេល User និយាយ ឬផ្ញើសារមក ឱ្យ reset ពេលវេលា ២ នាទីឡើងវិញ
          resetIdleTimeout(); //

          try {
            const msg = JSON.parse(data.toString()); //
            const { audio } = msg; //
            if (audio && liveSession) {
              liveSession.sendRealtimeInput({ //
                audio: { data: audio, mimeType: "audio/pcm;rate=16000" }, //
              });
            }
          } catch (err) {
            console.error("Error piping audio to Gemini:", err); //
          }
        });

      } catch (err) {
        console.error("Gemini Live connection failure:", err); //
        clientWs.send(JSON.stringify({ error: "Gemini session connection failed." })); //
        clientWs.close(); //
      }

      // 🔥 ផ្នែកទី ៣៖ កូដកាត់នាទីរបស់ User (ពេលគាត់បិទកម្មវិធី ឬដាច់លីង)
      clientWs.on("close", async () => {
        if (liveSession) {
          liveSession.close(); //
        }
        clearTimeout(idleTimeoutTimer); // 🔥 លុប Timer ចោល ពេលគាត់បិទ

        const endTime = Date.now(); //
        const sessionMinutes = (endTime - startTime) / 1000 / 60; // គណនាជាំនាទី

        try {
          if (sessionMinutes > 0.05) { // និយាយលើសពី ៣ វិនាទី ទើបកាត់ម៉ោង
            await pool.query(
              "UPDATE users SET usedminutes = usedminutes + $1 WHERE userid = $2", //
              [sessionMinutes, userId] //
            );
            console.log(`User ${userId} បាននិយាយអស់ ${sessionMinutes.toFixed(2)} នាទី។`); //
          }
        } catch (err) {
          console.error("Error updating talk minutes:", err); //
        }

        console.log(`Client session ended for ${userId}`); //
      });

    } catch (err) {
      clientWs.send(JSON.stringify({ error: "Database error occurred." })); //
      clientWs.close(); //
      return; //
    }
  });
}

startServer();