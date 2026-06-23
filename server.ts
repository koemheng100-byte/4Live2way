import "dotenv/config";

console.log("CWD =", process.cwd());
console.log("KEY =", process.env.GEMINI_API_KEY);
console.log("ADMIN =", process.env.ADMIN_PASSWORD);

import express from "express";
import path from "path";
import crypto from "crypto"; 
import { createServer as createViteServer } from "vite";
import { WebSocketServer } from "ws";
import { GoogleGenAI, Modality } from "@google/genai";
import db from "./db"; 

async function startServer() {
  const app = express();
  
  app.use(express.json());

  const PORT = Number(process.env.PORT) || 3000;

  console.log("Default Environment API KEY:", process.env.GEMINI_API_KEY ? "FOUND" : "MISSING");

  // ==========================================
  // --- ផ្នែកគ្រប់គ្រង ADMIN ROUTES ---
  // ==========================================

  // ១. មើល User ទាំងអស់
  app.get("/admin/users", (req, res) => {
    if (req.query.password !== process.env.ADMIN_PASSWORD) {
      return res.status(403).json({ error: "Access denied" });
    }

    try {
      const users = db.prepare("SELECT * FROM users").all();
      res.json(users);
    } catch (err) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ២. បង្កើត User ថ្មី
  app.post("/admin/create-user", (req, res) => {
    if (req.body.password !== process.env.ADMIN_PASSWORD) {
      return res.status(403).json({ error: "Access denied" });
    }

    const { userId, plan, expire_at } = req.body;

    if (!userId || !plan || !expire_at) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    try {
      db.prepare(`
        INSERT INTO users (user_id, plan, expire_at, active)
        VALUES (?, ?, ?, 1)
      `).run(userId, plan, expire_at);

      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to create user" });
    }
  });

  // ៣. បិទ User (Disable) - [កែប្រែរួច៖ ប្រើ userId ជំនួស token]
  app.post("/admin/disable-user", (req, res) => {
    if (req.body.password !== process.env.ADMIN_PASSWORD) {
      return res.status(403).json({ error: "Access denied" });
    }

    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: "Missing userId" });
    }

    try {
      db.prepare(`
        UPDATE users
        SET active = 0
        WHERE user_id = ?
      `).run(userId);

      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to disable user" });
    }
  });

  // ៤. លុប User (Delete) - [កែប្រែរួច៖ ប្រើ userId ជំនួស token]
  app.post("/admin/delete-user", (req, res) => {
    if (req.body.password !== process.env.ADMIN_PASSWORD) {
      return res.status(403).json({ error: "Access denied" });
    }

    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: "Missing userId" });
    }

    try {
      db.prepare("DELETE FROM users WHERE user_id = ?").run(userId);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to delete user" });
    }
  });

  // --- បញ្ចប់ ADMIN ROUTES ---

  // ==========================================
  // --- ផ្នែក VITE & STATIC FILES MIDDLEWARES ---
  // ==========================================

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

  // ------------------------------------------

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });

  const wss = new WebSocketServer({ server });
  
  wss.on("connection", async (clientWs, req) => {
    const url = new URL(req.url || "", `http://${req.headers.host || "localhost"}`);
    const source = url.searchParams.get("source") || "km";
    const target = url.searchParams.get("target") || "en";
    const userId = url.searchParams.get("userId") || "unknown";

    console.log(`Client trying to connect: User=${userId}`);

    // --- ពិនិត្យមើល USER តាមរយៈ USER_ID ពី SQLITE ---
    try {
      // បានកែប្រែ៖ ដក token ចេញពី Type Definition ឱ្យត្រូវតាម Schema ថ្មី
      const user = db.prepare("SELECT * FROM users WHERE user_id = ?").get(userId) as {
        user_id: string;
        plan: string;
        expire_at: string;
        active: number;
      } | undefined;

      if (!user) {
        console.warn(`Access Denied: User ID [${userId}] is invalid.`);
        clientWs.send(JSON.stringify({ error: "Invalid user ID" }));
        clientWs.close();
        return;
      }

      if (user.active === 0) {
        console.warn(`Access Denied: Account associated with User ID [${userId}] is suspended.`);
        clientWs.send(JSON.stringify({ error: "Account suspended" }));
        clientWs.close();
        return;
      }

      const expireDate = new Date(user.expire_at);
      const currentDate = new Date();
      if (expireDate < currentDate) {
        console.warn(`Access Denied: Subscription expired for User ID [${userId}] on ${user.expire_at}.`);
        clientWs.send(JSON.stringify({ error: "Subscription expired" }));
        clientWs.close();
        return;
      }

    } catch (dbError) {
      console.error("Database authorization error:", dbError);
      clientWs.send(JSON.stringify({ error: "Internal authentication error" }));
      clientWs.close();
      return;
    }
    // --- បញ្ចប់ការពិនិត្យមើល USER_ID ---

    console.log(`Client authenticated successfully: User ID: ${userId}`);
    
    const activeApiKey = process.env.GEMINI_API_KEY;
    if (!activeApiKey) {
      console.error("Connection rejected: No API Key provided.");
      clientWs.send(JSON.stringify({ error: "Missing Gemini API Key configuration." }));
      clientWs.close();
      return;
    }
    
    const ai = new GoogleGenAI({
      apiKey: activeApiKey,
      httpOptions: { headers: { 'User-Agent': 'aistudio-build' } }
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
4. Never alternate translation direction.
5. Never infer speaker roles.
6. Never use conversation history to decide direction.
7. Treat every utterance independently.
8. The same language must always produce the same target language.
9. Translate only.
10. Never explain, answer, summarize, or chat.
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
      clientWs.send(JSON.stringify({ error: "Gemini session connection failed. Invalid Key?" }));
      clientWs.close();
    }

    clientWs.on("close", () => {
      if (liveSession) {
        liveSession.close();
      }
      console.log(`Client disconnected: ${userId}`);
    });
  });
}

startServer();