import "dotenv/config";
import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { WebSocketServer } from "ws";
import { GoogleGenAI, Modality } from "@google/genai";
import { pool } from "./db";

async function startServer() {
  const app = express();
  app.use(express.json());
  app.use(express.static("public"));

  const PORT = Number(process.env.PORT) || 3000;

  console.log("Default Environment API KEY:", process.env.GEMINI_API_KEY ? "FOUND" : "MISSING");

  // ១. API សម្រាប់ Client ឆែកស្ថានភាព ID របស់ខ្លួន
  app.get("/api/check-status/:userId", async (req, res) => {
    const { userId } = req.params;

    try {
      const result = await pool.query("SELECT * FROM users WHERE userid = $1 AND deleted != 1", [userId]);
      const user = result.rows[0];

      if (!user) {
        return res.json({
          active: false,
          expiredAt: null,
          phoneNumber: ""
        });
      }

      const isExpired = new Date() > new Date(user.expiredat);

      res.json({
        active: !isExpired,
        expiredAt: user.expiredat,
        phoneNumber: user.phonenumber || ""
      });
    } catch (err) {
      res.status(500).json({ error: "Database error occurred." });
    }
  });

  // ២. API សម្រាប់ឱ្យ Client ផ្ញើលេខទូរស័ព្ទមក Save ភ្ជាប់ជាមួយ ID
  app.post("/api/save-phone", async (req, res) => {
    const { userId, phoneNumber } = req.body;
    if (!userId) return res.status(400).json({ error: "Missing userId" });

    try {
      const result = await pool.query("SELECT * FROM users WHERE userid = $1 AND deleted != 1", [userId]);
      const user = result.rows[0];

      if (!user) {
        return res.status(404).json({
          error: "User not found"
        });
      }

      await pool.query(`
        UPDATE users
        SET phonenumber = $1
        WHERE userid = $2
      `, [phoneNumber, userId]);

      res.json({ success: true, message: "រក្សាទុកលេខទូរស័ព្ទជោគជ័យ" });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ៣. API សម្រាប់ឱ្យ Admin ទាញយកទិន្នន័យ User ទាំងអស់មកមើល និងគណនាស្ថិតិ
  app.post("/api/admin/users", async (req, res) => {
    const { password } = req.body;

    if (password !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ error: "លេខសម្ងាត់មិនត្រឹមត្រូវ!" });
    }

    try {
      const result = await pool.query("SELECT * FROM users ORDER BY expiredat DESC");
      const rows = result.rows;

      const activeUsers = rows.filter(
        u => new Date(u.expiredat).getTime() > Date.now()
      ).length;

      const expiredUsers = rows.length - activeUsers;

      res.json({
        success: true,
        totalUsers: rows.length,
        activeUsers,
        expiredUsers,
        users: rows.map(u => ({
          userId: u.userid,
          phoneNumber: u.phonenumber,
          expiredAt: u.expiredat,
          geminiApiKey: u.geminiapikey,
          plan: u.plan,
          deleted: u.deleted,
          apiDisplay: u.geminiapikey
            ? u.geminiapikey.substring(0, 20) + "..."
            : "ENV DEFAULT KEY"
        })),
        envApiKey: process.env.GEMINI_API_KEY || "មិនទាន់មាន Key ក្នុង .env ទេ"
      });
    } catch (err) {
      res.status(500).json({ error: "Database error" });
    }
  });

  // ៤. API សម្រាប់ Admin លុប User (លុបដាច់)
  app.post("/api/admin/delete-user", async (req, res) => {
    const { password, userId } = req.body;

    if (password !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ error: "លេខសម្ងាត់មិនត្រឹមត្រូវ!" });
    }

    try {
      await pool.query("DELETE FROM users WHERE userid = $1", [userId]);
      res.json({ success: true, message: "បានលុប User នេះដាច់ដោយជោគជ័យ!" });
    } catch (err) {
      res.status(500).json({ error: "មិនអាចលុបបានទេ!" });
    }
  });

  // ៥. API សម្រាប់ Admin ផ្អាកការប្រើប្រាស់របស់ User
  app.post("/api/admin/suspend-user", async (req, res) => {
    const { password, userId } = req.body;

    if (password !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ error: "Password មិនត្រឹមត្រូវ" });
    }

    try {
      await pool.query(
        "UPDATE users SET expiredat = $1 WHERE userid = $2",
        [new Date(0).toISOString(), userId]
      );
      res.json({ success: true });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ៦. API សម្រាប់ Admin បើកដំណើរការ User ឡើងវិញ (Reactivate)
  app.post("/api/admin/reactivate-user", async (req, res) => {
    const { password, userId, days, plan } = req.body;

    if (password !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ error: "Password មិនត្រឹមត្រូវ" });
    }

    try {
      const expiredAt = new Date(
        Date.now() + (days || 30) * 24 * 60 * 60 * 1000
      ).toISOString();

      await pool.query(
        "UPDATE users SET expiredat = $1, plan = $2, deleted = 0 WHERE userid = $3",
        [expiredAt, plan || "30 Days", userId]
      );

      res.json({ success: true });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ៧. API សម្រាប់ Admin កំណត់ ឬប្តូរ API Key និងថ្ងៃផុតកំណត់ឱ្យ User ID (ON CONFLICT)
  app.post("/api/admin/set-user", async (req, res) => {
    const { password, userId, days, plan, geminiApiKey } = req.body;

    if (password !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ error: "លេខសម្ងាត់មិនត្រឹមត្រូវ!" });
    }

    const daysNum = Number(days) || 30;
    const expiredDate = new Date();
    expiredDate.setDate(expiredDate.getDate() + daysNum);

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
      `, [userId, "", expiredDate.toISOString(), geminiApiKey || null, plan || "30 Days"]);

      res.json({ success: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "មិនអាចរក្សាទុកក្នុង Database បានទេ!" });
    }
  });

  // ៨. API សម្រាប់ Admin ធ្វើបច្ចុប្បន្នភាព Plan របស់ User
  app.post("/api/admin/update-plan", async (req, res) => {
    const { password, userId, plan, days } = req.body;

    if (password !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({
        error: "Password មិនត្រឹមត្រូវ"
      });
    }

    try {
      const newExpiredAt = new Date(
        Date.now() + (days || 30) * 24 * 60 * 60 * 1000
      ).toISOString();

      await pool.query(
        "UPDATE users SET plan = $1, expiredat = $2 WHERE userid = $3",
        [plan, newExpiredAt, userId]
      );

      res.json({ success: true });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ៩. API សម្រាប់ទទួលការកែប្រែ API Key ផ្ទាល់ខ្លួនរបស់ User
  app.post("/api/admin/update-api-key", async (req, res) => {
    const { password, userId, geminiApiKey } = req.body;

    if (password !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ error: "Password មិនត្រឹមត្រូវ" });
    }

    try {
      await pool.query(
        "UPDATE users SET geminiapikey = $1 WHERE userid = $2",
        [geminiApiKey || null, userId]
      );

      res.json({ success: true, message: "ធ្វើបច្ចុប្បន្នភាព API Key ជោគជ័យ" });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // Route សម្រាប់ Admin Page
  app.get("/admin.html", (req, res) => {
    res.sendFile(path.join(process.cwd(), "public", "admin.html"));
  });

  if (process.env.NODE_ENV === "production") {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => res.sendFile(path.join(distPath, 'index.html')));
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  }

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });

  const wss = new WebSocketServer({ server });
  
  wss.on("connection", async (clientWs, req) => {
    console.log("Client connected via WebSocket");
    
    const url = new URL(req.url || "", `http://${req.headers.host || "localhost"}`);
    const source = url.searchParams.get("source") || "km";
    const target = url.searchParams.get("target") || "en";
    const userId = url.searchParams.get("userId") || "";

    try {
      const result = await pool.query("SELECT * FROM users WHERE userid = $1 AND deleted != 1", [userId]);
      const user = result.rows[0];

      if (!user) {
        clientWs.send(JSON.stringify({ error: "User ID នេះមិនមានក្នុងប្រព័ន្ធ ឬត្រូវបានលុបចោលហើយ!" }));
        clientWs.close();
        return;
      }

      const isExpired = new Date() > new Date(user.expiredat);
      if (isExpired) {
        clientWs.send(JSON.stringify({ error: "គណនីរបស់អ្នកបានហួសកាលកំណត់ប្រើប្រាស់ហើយ (Expired)!" }));
        clientWs.close();
        return;
      }

      const apiKeyToUse = user.geminiapikey || process.env.GEMINI_API_KEY;

      if (!apiKeyToUse) {
        console.error("Connection rejected: No API Key found in server environment.");
        clientWs.send(JSON.stringify({ error: "Server missing Gemini API Key configuration." }));
        clientWs.close();
        return;
      }
      
      const ai = new GoogleGenAI({
        apiKey: apiKeyToUse,
        httpOptions: {
          headers: { 'User-Agent': 'aistudio-build' }
        }
      });

      const langNames: Record<string, string> = {
        'km': 'Khmer', 'en': 'English', 'zh': 'Chinese (Mandarin)', 'zh-HK': 'Cantonese',
        'vi': 'Vietnamese', 'ja': 'Japanese', 'ko': 'Korean', 'th': 'Thai',
        'id': 'Indonesian', 'ms': 'Malay', 'lo': 'Lao', 'fr': 'French',
        'de': 'German', 'no': 'Norwegian', 'hi': 'Hindi', 'fil': 'Filipino',
        'mn': 'Mongolian', 'it': 'Italian', 'he': 'Hebrew', 'ru': 'Russian', 'my': 'Burmese'
      };

      const lang1Name = langNames[source] || source;
      const lang2Name = langNames[target] || target;

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
`;

      console.log(`Live 2-Way Interpreter Active: [${lang1Name} ↔ ${lang2Name}] for User: ${userId}`);
      
      let liveSession: any = null;

      try {
        liveSession = await ai.live.connect({
          model: "gemini-3.1-flash-live-preview",
          config: {
            responseModalities: [Modality.AUDIO],
            outputAudioTranscription: {},
            inputAudioTranscription: {},
            systemInstruction,
          },
          callbacks: {
            onmessage: (message: any) => {
              if (clientWs.readyState !== clientWs.OPEN) return;

              const audio = message.serverContent?.modelTurn?.parts
                ?.find((p: any) => p.inlineData)?.inlineData?.data;

              const inputTranscript = message.inputAudioTranscription?.text;
              const outputTranscript = message.outputAudioTranscription?.text;
              const interrupted = message.serverContent?.interrupted;

              if (audio || inputTranscript || outputTranscript || interrupted) {
                clientWs.send(JSON.stringify({ audio, inputTranscript, outputTranscript, interrupted }));
              }
            },
          },
        });

        clientWs.on("message", (data) => {
          try {
            const msg = JSON.parse(data.toString());
            const { audio } = msg;
            if (audio && liveSession) {
              liveSession.sendRealtimeInput({
                audio: { data: audio, mimeType: "audio/pcm;rate=16000" },
              });
            }
          } catch (err) {
            console.error("Error piping audio to Gemini:", err);
          }
        });

      } catch (err) {
        console.error("Gemini Live connection failure:", err);
        clientWs.send(JSON.stringify({ error: "Gemini session connection failed." }));
        clientWs.close();
      }

      clientWs.on("close", () => {
        if (liveSession) {
          liveSession.close();
        }
        console.log(`Client session ended for ${userId}`);
      });
    } catch (err) {
      clientWs.send(JSON.stringify({ error: "Database error occurred." }));
      clientWs.close();
      return;
    }
  });
}

startServer();