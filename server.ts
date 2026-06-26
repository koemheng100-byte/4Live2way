import "dotenv/config";
import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { WebSocketServer } from "ws";
import { GoogleGenAI, Modality } from "@google/genai";
import { pool } from "./db";

// ==========================================
// ផ្នែកទី ១៖ បញ្ជី API Keys ហ្វ្រីទាំងអស់ (Round Robin)
// 🔥 ជំហានទី ១៖ ប្តូរ API Keys ពិតប្រាកដទៅជាអក្សរសម្គាល់ (Placeholder) សិន
// ==========================================
const GEMINI_KEYS_POOL = [
  "GOOGLE_API_KEY_1", // Key ទី ១ ( placeholder )
  "GOOGLE_API_KEY_2", // Key ទី ២ ( placeholder )
   // ដាក់ Key ផ្សេងទៀតដែលមានចូលក្នុងនេះ...
];

// ② ជំនួស getNextGeminiKey() ដោយ getKeyByUser(userId)
function getKeyByUser(userId: string) {
  const keys = GEMINI_KEYS_POOL
    .map(name => process.env[name])
    .filter(Boolean) as string[];

  if (keys.length === 0) return [];

  let hash = 0;
  for (const c of userId) {
    hash += c.charCodeAt(0);
  }

  const start = hash % keys.length;

  return [
    ...keys.slice(start),
    ...keys.slice(0, start)
  ];
}

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

    const startTime = Date.now(); // 🔥 គណនាម៉ោងចាប់ផ្ដើមនិយាយ

    try {
      // 🔥 ១. ឆែកមើលទិន្នន័យ User ពី Database
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

      // 🔥 ២. ប្រព័ន្ធកំណត់ ៥ ម៉ោង (៣០០ នាទី) ប្រចាំថ្ងៃ
      const todayStr = new Date().toISOString().split('T')[0]; // ទាញយកថ្ងៃខែថ្ងៃនេះ
      let currentUsedMinutes = Number(user.usedminutes) || 0;

      // ក. បើចូលដល់ថ្ងៃថ្មី ត្រូវ Reset នាទីឱ្យបាននិយាយ ០ នាទីឡើងវិញដោយស្វ័យប្រវត្ត
      if (user.lastuseddate !== todayStr) {
        try {
          await pool.query("UPDATE users SET usedminutes = 0, lastuseddate = $1 WHERE userid = $2", [todayStr, userId]);
          currentUsedMinutes = 0;
          console.log(`User ${userId} - Daily usage reset to 0 for new date ${todayStr}`);
        } catch (err) {
          console.error("Error resetting daily minutes:", err);
        }
      }

      // ខ. ឆែកមើលលក្ខខណ្ឌ ៥ ម៉ោង (៣០០ នាទី)
      if (currentUsedMinutes >= 300) {
        clientWs.send(JSON.stringify({ error: "អ្នកបានប្រើប្រាស់អស់កំណត់ ៥ ម៉ោងសម្រាប់ថ្ងៃនេះហើយ! សូមរង់ចាំស្អែកទើបអាចប្រើបានម្តងទៀត。" }));
        clientWs.close();
        return;
      }

      // ③ កន្លែងជ្រើស API Key (កែសម្រួលដើម្បី Fallback ទៅរក Pool Keys បើទោះជា Key ផ្ទាល់ខ្លួនរបស់ User ដើរមិនរួច)
      const candidateKeys = user.geminiapikey
        ? [user.geminiapikey, ...getKeyByUser(userId)]
        : getKeyByUser(userId);

      const langNames: Record<string, string> = {
        'km': 'Khmer', 'en': 'English', 'zh': 'Chinese (Mandarin)', 'zh-HK': 'Cantonese',
        'vi': 'Vietnamese', 'ja': 'Japanese', 'ko': 'Korean', 'th': 'Thai',
        'id': 'Indonesian', 'ms': 'Malay', 'lo': 'Lao', 'fr': 'French',
        'de': 'German', 'no': 'Norwegian', 'hi': 'Hindi', 'fil': 'Filipino',
        'mn': 'Mongolian', 'it': 'Italian', 'he': 'Hebrew', 'ru': 'Russian', 'my': 'Burmese'
      };

      const lang1Name = langNames[source] || source;
      const lang2Name = langNames[target] || target;

      console.log(`Live 2-Way Interpreter Active: [${lang1Name} ↔ ${lang2Name}] for User: ${userId}`);
      
      let liveSession: any = null;

      // 🔥 ប្រព័ន្ធ Idle Timeout (២ នាទីផ្ដាច់)
      let idleTimeoutTimer: NodeJS.Timeout;
      
      function resetIdleTimeout() {
        clearTimeout(idleTimeoutTimer);
        idleTimeoutTimer = setTimeout(() => {
          console.log(`User ${userId} ត្រូវដាច់ដោយស្វ័យប្រវត្ត ព្រោះមិននិយាយលើសពី ២ នាទី។`);
          clientWs.send(JSON.stringify({ error: "អ្នកបានផ្អាកការនិយាយលើសពី ២ នាទី ដើម្បីសន្សំសំចៃប្រព័ន្ធ។ សូមភ្ជាប់ឡើងវិញបើចង់និយាយបន្តClient" }));
          clientWs.close();
        }, 120000); // ១២០,០០០ មីលីវិនាទី = ២ នាទី
      }

      // ចាប់ផ្ដើម Timer ភ្លាមៗពេលភ្ជាប់
      resetIdleTimeout();

      // ④ កន្លែង ai.live.connect() ដែលប្រើ Loop ដើម្បីព្យាយាមភ្ជាប់ជាមួយ candidateKeys
      let connected = false;

      for (const key of candidateKeys) {
        try {
          // បន្ថែម Log ថាកំពុងប្រើ Key មួយណា
          console.log(
            "Trying key:",
            key.substring(0, 12) + "..."
          );

          const ai = new GoogleGenAI({
            apiKey: key,
            httpOptions: {
              headers: { 'User-Agent': 'aistudio-build' }
            }
          });

          liveSession = await ai.live.connect({
            model: "gemini-3.1-flash-live-preview",
            config: {
              responseModalities: [Modality.AUDIO],
              outputAudioTranscription: {},
              inputAudioTranscription: {},
              // បន្ថែមការកំណត់សំឡេង Aoede
              generationConfig: {
                speechConfig: {
                  voiceConfig: {
                    prebuiltVoiceConfig: {
                      voiceName: "Aoede",
                    },
                  },
                },
              },
              systemInstruction: `
You are a strict, real-time, low-latency continuous translator.
Selected language pair: A = ${lang1Name}, B = ${lang2Name}

CRITICAL RULES FOR REAL-TIME STREAMING & TRANSLATION:
1. If the input is ${lang1Name}, translate ONLY to ${lang2Name}.
2. If the input is ${lang2Name}, translate ONLY to ${lang1Name}.
3. Any language other than ${lang1Name} or ${lang2Name} MUST ALWAYS be translated into ${lang2Name}.
4. Never alternate translation direction. Never infer speaker roles. Treat every utterance independently.
5. Translate only. Never explain, answer, summarize, or chat.
6. DO NOT wait for the speaker to finish their entire sentence or paragraph.
7. Translate continuously chunk-by-chunk as soon as a phrase or meaningful clause is completed.
8. Keep the translation flowing naturally and rapidly to maintain real-time sync with the speaker.
9. Correct yourself smoothly in the next chunk if context changes, but prioritize speed and immediate translation.
`,
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

          connected = true;
          break;

        } catch (err: any) {
          // កែសម្រួលមិនឱ្យលាក់ Error ដើម្បីបង្ហាញមូលហេតុពិតនៅលើ Render Log
          console.error("Key failed:", err?.message || err);
        }
      }

      if (!connected) {
        clientWs.send(JSON.stringify({
          error: "No available Gemini API Key"
        }));
        clientWs.close();
        return;
      }

      clientWs.on("message", (data) => {
        // 🔥 រាល់ពេល User និយាយ ឬផ្ញើសារមក ឱ្យ reset ពេលវេលា ២ នាទីឡើងវិញ
        resetIdleTimeout();

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

      // 🔥 ផ្នែកទី ៣៖ កូដកាត់នាទីរបស់ User (ពេលគាត់បិទកម្មវិធី ឬដាច់លីង)
      clientWs.on("close", async () => {
        try {
          if (liveSession) {
            await liveSession.close();
            liveSession = null;
          }
        } catch (e) {
          console.error(e);
        }
        
        clearTimeout(idleTimeoutTimer); // 🔥 លុប Timer ចោល ពេលគាត់បិទ

        const endTime = Date.now();
        const sessionMinutes = (endTime - startTime) / 1000 / 60; // គណនាជាំនាទី

        try {
          if (sessionMinutes > 0.05) { // និយាយលើសពី ៣ វិនាទី ទើបកាត់ម៉ោង
            await pool.query(
              "UPDATE users SET usedminutes = usedminutes + $1 WHERE userid = $2",
              [sessionMinutes, userId]
            );
            console.log(`User ${userId} បាននិយាយអស់ ${sessionMinutes.toFixed(2)} នាទី。`);
          }
        } catch (err) {
          console.error("Error updating talk minutes:", err);
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