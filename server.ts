import "dotenv/config";
import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { WebSocketServer } from "ws";
import { GoogleGenAI, Modality } from "@google/genai";
import { db } from "./db";

// ធានាថាមាន Column deleted នៅក្នុង Database Table (ចំណុចទី ២)
try {
  db.exec(`
    ALTER TABLE users
    ADD COLUMN deleted INTEGER DEFAULT 0
  `);
} catch (err) {
  // ប្រសិនបើមាន column នេះរួចហើយ វានឹងរំលងដោយមិនមានបញ្ហាអ្វីឡើយ
}

async function startServer() {
  const app = express();
  app.use(express.json());
  app.use(express.static("public"));

  const PORT = Number(process.env.PORT) || 3000;

  console.log("Default Environment API KEY:", process.env.GEMINI_API_KEY ? "FOUND" : "MISSING");

  // API សម្រាប់ Client ឆែកស្ថានភាព ID របស់ខ្លួន (ចំណុចទី ៤៖ បន្ថែម AND deleted != 1)
  app.get("/api/check-status/:userId", (req, res) => {
    const { userId } = req.params;

    try {
      const user = db.prepare("SELECT * FROM users WHERE userId = ? AND deleted != 1").get(userId) as any;

      if (!user) {
        return res.json({
          active: false,
          expiredAt: null,
          phoneNumber: ""
        });
      }

      const isExpired =
        new Date(user.expiredAt).getTime() < Date.now();

      res.json({
        active: !isExpired,
        expiredAt: user.expiredAt,
        phoneNumber: user.phoneNumber || ""
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // API សម្រាប់ឱ្យ Client ផ្ញើលេខទូរស័ព្ទមក Save ភ្ជាប់ជាមួយ ID (ចំណុចទី ១ និងទី ៤)
  app.post("/api/save-phone", (req, res) => {
    const { userId, phoneNumber } = req.body;
    if (!userId) return res.status(400).json({ error: "Missing userId" });

    try {
      // ឆែកមើលថាតើមាន User រួចហើយឬនៅ និងមិនទាន់លុប (deleted != 1)
      const user = db.prepare("SELECT * FROM users WHERE userId = ? AND deleted != 1").get(userId) as any;

      if (!user) {
        return res.status(404).json({
          error: "User not found"
        });
      }

      // កែប្រែទៅជា UPDATE វិញ ដើម្បីកុំឱ្យបង្កើត User ថ្មីដោយស្វ័យប្រវត្តិ
      db.prepare(`
        UPDATE users
        SET phoneNumber = ?
        WHERE userId = ?
      `).run(phoneNumber, userId);

      res.json({ success: true, message: "រក្សាទុកលេខទូរស័ព្ទជោគជ័យ" });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ====================================================
  // API សម្រាប់ឱ្យ Admin ទាញយកទិន្នន័យ User ទាំងអស់មកមើល (កែប្រែថ្មីដើម្បីបង្ហាញ ENV DEFAULT KEY)
  // ====================================================
  app.post("/api/admin/users", (req, res) => {
    const { password } = req.body;

    if (password !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ error: "Password មិនត្រឹមត្រូវទេ!" });
    }

    try {
      const rows = db.prepare("SELECT * FROM users WHERE deleted != 1").all() as any[];

      const activeUsers = rows.filter(
        u => new Date(u.expiredAt).getTime() > Date.now()
      ).length;

      const expiredUsers = rows.length - activeUsers;

      res.json({
        success: true,
        totalUsers: rows.length,
        activeUsers,
        expiredUsers,
        users: rows.map(u => ({
          ...u,
          // បើមាន Key ផ្ទាល់ខ្លួន បង្ហាញ Key ខ្លួនឯង បើអត់ទេ បង្ហាញពាក្យ ENV DEFAULT KEY
          apiDisplay: u.geminiApiKey
            ? u.geminiApiKey.substring(0, 20) + "..."
            : "ENV DEFAULT KEY"
        })),
        envApiKey: process.env.GEMINI_API_KEY || "មិនទាន់មាន Key ក្នុង .env ទេ"
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // API សម្រាប់ Admin លុប User (ចំណុចទី ៣៖ ប្តូរពី DELETE ទៅជា UPDATE វិញ)
  app.post("/api/admin/delete-user", (req, res) => {
    const { password, userId } = req.body;

    if (password !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ error: "Password មិនត្រឹមត្រូវ" });
    }

    try {
      db.prepare(
        "UPDATE users SET deleted = 1 WHERE userId = ?"
      ).run(userId);
      res.json({ success: true });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // API សម្រាប់ Admin ផ្អាកការប្រើប្រាស់របស់ User (កំណត់ឱ្យអស់សុពលភាព)
  app.post("/api/admin/suspend-user", (req, res) => {
    const { password, userId } = req.body;

    if (password !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ error: "Password មិនត្រឹមត្រូវ" });
    }

    try {
      db.prepare(
        "UPDATE users SET expiredAt = ? WHERE userId = ?"
      ).run(
        new Date(0).toISOString(),
        userId
      );
      res.json({ success: true });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // API ថ្មី៖ សម្រាប់ Admin បើកដំណើរការ User ឡើងវិញ (Reactivate) - [កែប្រែរួចរាល់]
  app.post("/api/admin/reactivate-user", (req, res) => {
    const { password, userId, days, plan } = req.body; // 🔥 ទទួលយកតម្លៃ plan ពី client

    if (password !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ error: "Password មិនត្រឹមត្រូវ" });
    }

    try {
      const expiredAt = new Date(
        Date.now() + (days || 30) * 24 * 60 * 60 * 1000
      ).toISOString();

      // 🔥 កែប្រែ SQL ឱ្យ Update ទាំង expiredAt, plan និង deleted = 0
      db.prepare(
        "UPDATE users SET expiredAt = ?, plan = ?, deleted = 0 WHERE userId = ?"
      ).run(expiredAt, plan || "30 Days", userId);

      res.json({ success: true });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // API ពិសេសសម្រាប់ Admin កំណត់ ឬប្តូរ API Key និងថ្ងៃផុតកំណត់ឱ្យ User ID
  app.post("/api/admin/set-user", (req, res) => {
    const {
      password,
      userId,
      days,
      geminiApiKey,
      plan
    } = req.body;

    if (password !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ error: "Password មិនត្រឹមត្រូវទេ!" });
    }

    if (!userId || days === undefined) {
      return res.status(400).json({ error: "សូមបំពេញ userId និង days ឱ្យបានត្រឹមត្រូវ" });
    }

    const expiredDate = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

    try {
      db.prepare(
        `
        INSERT OR REPLACE INTO users
        (userId, phoneNumber, expiredAt, geminiApiKey, plan, deleted)
        VALUES (?, ?, ?, ?, ?, 0)
        `
      ).run(
        userId,
        "",
        expiredDate.toISOString(),
        geminiApiKey || null,
        plan || "30 Days"
      );

      res.json({
        success: true,
        message: `បានកំណត់ ID ${userId} ជោគជ័យ`
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // API ថ្មី៖ សម្រាប់ Admin ធ្វើបច្ចុប្បន្នភាព Plan របស់ User និងគណនាថ្ងៃ Expire ឡើងវិញ
  app.post("/api/admin/update-plan", (req, res) => {
    const { password, userId, plan, days } = req.body; // 🔥 ទទួលយកតម្លៃ days បន្ថែមពី Client

    if (password !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({
        error: "Password មិនត្រឹមត្រូវ"
      });
    }

    try {
      // 🔥 គណនាថ្ងៃផុតកំណត់ (Expire) ថ្មី ចាប់គិតពីម៉ោងដែល Admin កំពុងចុច Edit នេះទៅ
      const newExpiredAt = new Date(
        Date.now() + (days || 30) * 24 * 60 * 60 * 1000
      ).toISOString();

      // 🔥 កែប្រែ SQL ឱ្យ Update ទាំង plan ផង និង expiredAt ថ្មីផង
      db.prepare(
        "UPDATE users SET plan = ?, expiredAt = ? WHERE userId = ?"
      ).run(plan, newExpiredAt, userId);

      res.json({ success: true });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ====================================================
  // API ថ្មី៖ សម្រាប់ទទួលការកែប្រែ API Key ផ្ទាល់ខ្លួនរបស់ User (ប៊ូតុងខ្មៅដៃ)
  // ====================================================
  app.post("/api/admin/update-api-key", (req, res) => {
    const { password, userId, geminiApiKey } = req.body;

    if (password !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ error: "Password មិនត្រឹមត្រូវ" });
    }

    try {
      db.prepare(
        "UPDATE users SET geminiApiKey = ? WHERE userId = ?"
      ).run(geminiApiKey || null, userId);

      res.json({ success: true, message: "ធ្វើបច្ចុប្បន្នភាព API Key ជោគជ័យ" });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // បន្ថែម Route សម្រាប់ Admin Page នៅត្រង់នេះ
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

    // ទាញយកទិន្នន័យ User ពី Database សម្រាប់ WebSocket Connection (ចំណុចទី ៤៖ បន្ថែម AND deleted != 1)
    try {
      const user = db.prepare("SELECT * FROM users WHERE userId = ? AND deleted != 1").get(userId) as any;

      const isExpired = user ? new Date(user.expiredAt).getTime() < Date.now() : true;

      if (isExpired) {
        console.error(`Connection rejected: ID ${userId} មិនទាន់បង់ប្រាក់ ឬអស់សុពលភាពប្រើប្រាស់។`);
        clientWs.send(JSON.stringify({ error: "គណនី ID របស់អ្នកមិនមានសុពលភាព ឬអស់ថ្ងៃប្រើប្រាស់ហើយ។ សូមធ្វើការបង់ប្រាក់!" }));
        clientWs.close();
        return;
      }

      const activeApiKey = user?.geminiApiKey || process.env.GEMINI_API_KEY;

      if (!activeApiKey) {
        console.error("Connection rejected: No API Key found in server environment.");
        clientWs.send(JSON.stringify({ error: "Server missing Gemini API Key configuration." }));
        clientWs.close();
        return;
      }
      
      const ai = new GoogleGenAI({
        apiKey: activeApiKey,
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