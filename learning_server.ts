import { IncomingMessage } from "http";
import WebSocket from "ws";
import { GoogleGenAI, Modality } from "@google/genai"; 
import { LEARNING_SYSTEM_INSTRUCTION } from "./prompts/learningPrompt";

const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY
});

export async function createLearningSession(
    ws: WebSocket,
    req: IncomingMessage
) {
    let session: any = null;
    let isAlive = true;

    function cleanup() {
        console.log("🔌 Cleaning up sessions...");
        clearInterval(heartbeatInterval);
        if (session) {
            try { session.close(); } catch (e) { console.error("Error closing Gemini session:", e); }
        }
        if (ws.readyState === WebSocket.OPEN) {
            ws.close();
        }
    }

    ws.on("pong", () => {
        isAlive = true;
    });

    const heartbeatInterval = setInterval(() => {
        if (isAlive === false) {
            console.log("☠️ Client unresponsive, terminating connection.");
            cleanup();
            return;
        }
        isAlive = false;
        ws.ping();
    }, 30000);

    try {
        // ប្តូរមកប្រើ Callback Style ទាំងស្រុងនៅក្នុង ai.live.connect
        session = await ai.live.connect({
            model: "gemini-3.5-live-translate-preview",
            config: {
                generationConfig: {
                    responseModalities: [Modality.AUDIO, Modality.TEXT],
                },
                systemInstruction: {
                    parts: [{ text: LEARNING_SYSTEM_INSTRUCTION }]
                }
            },
            callbacks: {
                onmessage: (response: any) => {
                    try {
                        if (response.serverContent) {
                            const modelTurn = response.serverContent.modelTurn;
                            
                            if (modelTurn && modelTurn.parts) {
                                for (const part of modelTurn.parts) {
                                    
                                    // ផ្ញើ Audio Chunk ទៅ Frontend ភ្លាមៗ
                                    if (part.inlineData?.data && part.inlineData.mimeType?.startsWith("audio/")) {
                                        ws.send(JSON.stringify({
                                            audio: part.inlineData.data,
                                            outputTranscript: null,
                                            interrupted: false
                                        }));
                                    }

                                    // ផ្ញើ Output Transcript (អក្សរ) ទៅ Frontend
                                    if (part.text) {
                                        ws.send(JSON.stringify({
                                            audio: null,
                                            outputTranscript: part.text,
                                            interrupted: false
                                        }));
                                    }
                                }
                            }

                            // ផ្ញើ Signal ពេល AI និយាយចប់ ឬត្រូវបានរំខាន (Interrupted)
                            if (response.serverContent.interrupted || response.serverContent.turnComplete) {
                                ws.send(JSON.stringify({
                                    audio: null,
                                    outputTranscript: null,
                                    interrupted: response.serverContent.interrupted || false,
                                    turnComplete: response.serverContent.turnComplete || false
                                }));
                            }
                        }
                    } catch (err) {
                        console.error("Error processing Gemini message in callback:", err);
                    }
                }
            }
        });

        console.log("✈️ Connected to Gemini Live API (Callback Mode)");

        // Session Start: ផ្ញើ Signal "START_LEARNING" ទៅឱ្យ Prompt 
        await session.send({
            clientContent: {
                turns: [{
                    role: "user",
                    parts: [{ text: "START_LEARNING" }]
                }],
                turnComplete: true
            }
        });

        // ទទួលសំឡេងពី Frontend រួចបញ្ជូនទៅ Gemini
        ws.on("message", async (data: Buffer) => {
            try {
                if (data.toString() === "ping") {
                    ws.send(JSON.stringify({ type: "pong" }));
                    return;
                }

                const msg = JSON.parse(data.toString());
                
                if (msg && msg.audio) {
                    await session.send({
                        realtimeInput: {
                            mediaChunks: [{
                                mimeType: "audio/pcm;rate=16000",
                                data: msg.audio
                            }]
                        }
                    });
                }
            } catch (err) {
                console.error("Error parsing frontend data or sending to Gemini:", err);
            }
        });

        // លុប (async () => { for await (...) }) ចេញទាំងស្រុងតាមការណែនាំ

        ws.on("close", () => {
            console.log("🔌 Client disconnected from learning session");
            cleanup();
        });

        ws.on("error", (err) => {
            console.error("WebSocket error occurred:", err);
            cleanup();
        });

    } catch (error) {
        console.error("Failed to initialize Gemini Live Session:", error);
        cleanup();
    }
}