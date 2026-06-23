import "dotenv/config";
import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { WebSocketServer } from "ws";
import { GoogleGenAI, Modality } from "@google/genai";

// 1. បង្កើត In-Memory Database សម្រាប់ផ្ទុកទិន្នន័យ User ( ID, លេខទូរសព្ទ, ថ្ងៃផុតកំណត់, និង API Key ផ្ទាល់ខ្លួន )
interface UserSubscription {
  userId: string;
  phoneNumber?: string;
  expiredAt: string; // ISO String format
  geminiApiKey?: string; // API Key ជាក់លាក់សម្រាប់ ID នេះ (បើគ្មានគឺប្រើ Key រួមក្នុង .env)
}

// ទិន្នន័យគំរូ និងផ្ទុកបណ្តោះអាសន្នលើ Server
const userDatabase: Record<string, UserSubscription> = {};

async function startServer() {
  const app = express();
  app.use(express.json()); // អនុញ្ញាតឱ្យទទួល JSON body

  const PORT = Number(process.env.PORT) || 3000;

  console.log("Default Environment API KEY:", process.env.GEMINI_API_KEY ? "FOUND" : "MISSING");

  // --- API ROUTES ថ្មីសម្រាប់ប្រព័ន្ធគ្រប់គ្រងការបង់ប្រាក់ និង API KEY ---

  // API សម្រាប់ Client ឆែកស្ថានភាព ID របស់ខ្លួន
  app.get("/api/check-status/:userId", (req, res) => {
    const { userId } = req.params;
    const user = userDatabase[userId];

    if (!user) {
      return res.json({ active: false, expiredAt: null, phoneNumber: "" });
    }

    const isExpired = new Date(user.expiredAt).getTime() < Date.now();
    res.json({
      active: !isExpired,
      expiredAt: user.expiredAt,
      phoneNumber: user.phoneNumber || ""
    });
  });

  // API សម្រាប់ឱ្យ Client ផ្ញើលេខទូរស័ព្ទមក Save ភ្ជាប់ជាមួយ ID
  app.post("/api/save-phone", (req, res) => {
    const { userId, phoneNumber } = req.body;
    if (!userId) return res.status(400).json({ error: "Missing userId" });

    if (!userDatabase[userId]) {
      // បង្កើត profile ថ្មីបើមិនទាន់មាន (ករណីទើបបង់ប្រាក់)
      userDatabase[userId] = {
        userId,
        expiredAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() // default 1 ថ្ងៃសាកល្បង
      };
    }

    userDatabase[userId].phoneNumber = phoneNumber;
    res.json({ success: true, message: "រក្សាទុកលេខទូរស័ព្ទជោគជ័យ" });
  });

  // API ពិសេសសម្រាប់អ្នក (Admin) កំណត់ ឬប្តូរ API Key និងថ្ងៃផុតកំណត់ឱ្យ User ID ណាៗតាមចិត្ត
  // របៀបប្រើ៖ ផ្ញើ POST ទៅកាន់ https://fourlive2way.onrender.com/api/admin/set-user 
  app.post("/api/admin/set-user", (req, res) => {
    const { password, userId, days, geminiApiKey } = req.body;

    // ការពារសុវត្ថិភាពដោយប្រើ password ក្នុង .env
    if (password !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ error: "Password មិនត្រឹមត្រូវទេ!" });
    }

    if (!userId || !days) {
      return res.status(400).json({ error: "សូមបំពេញ userId និង days ឱ្យបានត្រឹមត្រូវ" });
    }

    const expiredDate = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

    userDatabase[userId] = {
      ...userDatabase[userId],
      userId,
      expiredAt: expiredDate.toISOString(),
      geminiApiKey: geminiApiKey || undefined // បើមិនដាក់ទេ វានឹងប្រើ Key រួមក្នុង .env
    };

    res.json({
      success: true,
      message: `បានកំណត់ ID: ${userId} ឱ្យប្រើប្រាស់បាន ${days} ថ្ងៃ ដល់ថ្ងៃទី ${expiredDate.toLocaleString()}`,
      data: userDatabase[userId]
    });
  });

  // -------------------------------------------------------------

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

    // ត្រួតពិនិត្យការទូទាត់ និងសុពលភាពថ្ងៃផុតកំណត់នៅលើ Server មុននឹងឱ្យតភ្ជាប់ទៅ Gemini
    const user = userDatabase[userId];
    const isExpired = user ? new Date(user.expiredAt).getTime() < Date.now() : true;

    if (isExpired) {
      console.error(`Connection rejected: ID ${userId} មិនទាន់បង់ប្រាក់ ឬអស់សុពលភាពប្រើប្រាស់។`);
      clientWs.send(JSON.stringify({ error: "គណនី ID របស់អ្នកមិនមានសុពលភាព ឬអស់ថ្ងៃប្រើប្រាស់ហើយ។ សូមធ្វើការបង់ប្រាក់!" }));
      clientWs.close();
      return;
    }

    // ពិនិត្យលក្ខខណ្ឌ Gemini API Key: បើមាន Key ផ្ទាល់ខ្លួនរបស់ ID នោះ គឺយកមកប្រើ បើគ្មានទេទើបប្រើ Key រួមនៅក្នុង .env
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
  });
}

startServer();