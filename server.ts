import "dotenv/config";
import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { WebSocketServer } from "ws";
import { GoogleGenAI, Modality } from "@google/genai";

async function startServer() {
  const app = express();
  const PORT = 3000;

  console.log("Default Environment API KEY:", process.env.GEMINI_API_KEY ? "FOUND" : "MISSING");

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
    
    // ចាប់យក URL parameters រួមទាំង dynamic API Key ពី Client 
    const url = new URL(req.url || "", `http://${req.headers.host || "localhost"}`);
    const source = url.searchParams.get("source") || "km";
    const target = url.searchParams.get("target") || "en";
    const clientApiKey = url.searchParams.get("apiKey"); // ចាប់យក Key ដែលបានបញ្ជូនពី LocalStorage 

    // ជ្រើសរើស Key ប្រើប្រាស់៖ បើ Client បញ្ជូនមក គឺប្រើរបស់ Client បើអត់ទេប្រើក្នុង .env 
    const activeApiKey = clientApiKey || process.env.GEMINI_API_KEY;

    if (!activeApiKey) {
      console.error("Connection rejected: No API Key provided.");
      clientWs.send(JSON.stringify({ error: "Missing Gemini API Key configuration." }));
      clientWs.close();
      return;
    }
    
    // បង្កើត Instance របស់ GoogleGenAI ដោយផ្អែកលើ Key Dynamic 
    const ai = new GoogleGenAI({
      apiKey: activeApiKey,
      httpOptions: {
        headers: { 'User-Agent': 'aistudio-build' }
      }
    });

    const langNames: Record<string, string> = {
      'km': 'Khmer', 
      'en': 'English', 
      'zh': 'Chinese', 
      'vi': 'Vietnamese', 
      'ja': 'Japanese', 
      'ko': 'Korean', 
      'th': 'Thai'
    };

    const lang1Name = langNames[source] || source;
    const lang2Name = langNames[target] || target;

    const systemInstruction = `
You are a real-time interpreter.

Allowed languages:
${lang1Name}
${lang2Name}

If input is ${lang1Name},
output only ${lang2Name}.

If input is ${lang2Name},
output only ${lang1Name}.

Never use a third language.
Never explain.
Never answer.
Translate only.

If unsure, stay silent.
`;

    console.log(`Live 2-Way Interpreter Active: [${lang1Name} ↔ ${lang2Name}] using ${clientApiKey ? "Client Key" : "Server Env Key"}`);
    
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
      console.log("Client session ended");
    });
  });
}

startServer();