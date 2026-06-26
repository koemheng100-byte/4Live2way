/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { useEffect, useRef, useState } from 'react';
import { Mic, Monitor, Languages, ArrowLeftRight, Copy, Check, Phone, GraduationCap, BookOpen, Lightbulb, CheckCircle2, RotateCcw, Star } from 'lucide-react';

// Optimized High-Speed PCM to Base64 Encoder
const pcmToBase64 = (pcm: Float32Array): string => {
  const bytes = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    bytes[i] = Math.max(-1, Math.min(1, pcm[i])) * 32367;
  }
  const uint8 = new Uint8Array(bytes.buffer);
  let binary = '';
  const len = uint8.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(uint8[i]);
  }
  return btoa(binary);
};

export default function App() {
  const [connected, setConnected] = useState(false);
  const [restarting, setRestarting] = useState(false); 
  const [sourceLang, setSourceLang] = useState('km');
  const [targetLang, setTargetLang] = useState('en');
  const [captureMode, setCaptureMode] = useState<'mic' | 'screen'>('mic');
  const [dubbingMode, setDubbingMode] = useState<'ducking' | 'replacement'>('ducking');

  // ① បន្ថែម Mode នៅខាងលើ
  const [appMode, setAppMode] = useState<"translate" | "learning">("translate");

  // State សម្រាប់ចំណាំពេលអ្នកប្រើកំពុងចុច Focus លើ Select ភាសា
  const [focusedSelect, setFocusedSelect] = useState<'source' | 'target' | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const learningWsRef = useRef<WebSocket | null>(null); // បន្ថែម Ref សម្រាប់ Learning WS
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const displayStreamRef = useRef<MediaStream | null>(null);
  const [transcript, setTranscript] = useState<{original: string, translated: string}[]>([]);

  const [liveSubtitle, setLiveSubtitle] = useState("");
  
  // ② បន្ថែម Learning State
  const [topic, setTopic] = useState("");
  const [hint, setHint] = useState("");
  const [correction, setCorrection] = useState("");
  const [learningTranscript, setLearningTranscript] = useState("");
  const [repeatText, setRepeatText] = useState("");
  const [score, setScore] = useState<number | null>(null);

  const subtitleTimeoutRef = useRef<number | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);

  const nextPlaybackTimeRef = useRef<number>(0);
  const screenGainNodeRef = useRef<GainNode | null>(null);
  const duckTimeoutRef = useRef<number | null>(null);

  // កែប្រែចំណុចទី ៣៖ បន្ថែម lastTranscriptRef ដើម្បីការពារការស្ទួនទិន្នន័យអត្ថបទ
  const lastTranscriptRef = useRef("");

  // --- STATE បន្ថែមថ្មី សម្រាប់ប្រព័ន្ធគ្រប់គ្រងការបង់ប្រាក់ និង NO-AUTH ID ---
  const [userId, setUserId] = useState<string>("");
  const [isPaid, setIsPaid] = useState<boolean>(true); // សន្មតថាតានដានស្ថានភាពជាមុនសិន
  const [showPayModal, setShowPayModal] = useState<boolean>(false);
  const [payStep, setPayStep] = useState<number>(1); // 1: បង្ហាញ ID, 2: ជ្រើសរើសរយៈពេល, 3: ជ្រើសរើសធនាគារ/QR, 4: ដាក់លេខទូរសព្ទ
  const [selectedPlan, setSelectedPlan] = useState<{ name: string; price: string; days: number } | null>(null);
  const [copied, setCopied] = useState<boolean>(false);
  const [inputPhone, setInputPhone] = useState<string>("");
  const [expiryText, setExpiryText] = useState<string>("");
  const [activeBank, setActiveBank] = useState<'aba' | 'acleda'>('aba'); // ចំណាំធនាគារដែលកំពុងជ្រើសរើស

  // ១. បង្កើត ID ម៉ាស៊ីន និងឆែកស្ថានភាពបង់ប្រាក់ពេលបើកកម្មវិធីភ្លាម
  useEffect(() => {
    let localId = localStorage.getItem("user_machine_id");
    if (!localId) {
      // បង្កើត ID គំរូថ្មីមួយដោយស្វ័យប្រវត្តិ (ឧទហរណ៍៖ L2W-XXXXXX)
      localId = "L2W-" + Math.floor(100000 + Math.random() * 900000);
      localStorage.setItem("user_machine_id", localId);
    }
    setUserId(localId);
    checkSubscriptionStatus(localId);

    return () => {
      if (subtitleTimeoutRef.current) clearTimeout(subtitleTimeoutRef.current);
      if (duckTimeoutRef.current) clearTimeout(duckTimeoutRef.current);
    };
  }, []);

  const checkSubscriptionStatus = async (id: string) => {
    try {
      const res = await fetch(`/api/check-status/${id}`);
      const data = await res.json();
      setIsPaid(data.active);
      if (data.active && data.expiredAt) {
        const date = new Date(data.expiredAt);
        setExpiryText(`ផុតកំណត់៖ ${date.toLocaleDateString()} ${date.toLocaleTimeString()}`);
      } else {
        setExpiryText("មិនទាន់បានបង់ប្រាក់ ឬអស់សុពលភាព");
      }
    } catch (e) {
      console.error("Error checking subscription status:", e);
    }
  };

  const copyIdToClipboard = () => {
    navigator.clipboard.writeText(userId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSavePhone = async () => {
    if (inputPhone.trim()) {
      try {
        await fetch("/api/save-phone", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId, phoneNumber: inputPhone })
        });
      } catch (e) {
        console.error("Error saving phone:", e);
      }
    }
    setShowPayModal(false);
    checkSubscriptionStatus(userId);
  };

  const calculateDatesText = (days: number) => {
    const start = new Date();
    const end = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    return `បង់ពីថ្ងៃនេះ៖ ${start.toLocaleDateString()} -> ផុតកំណត់៖ ${end.toLocaleDateString()}`;
  };

  // -------------------------------------------------------------

  // កន្លែងទី២៖ កែប្រែ playAudioChunk ដើម្បីដាស់ AudioContext ដែល suspended លើ Safari/iOS
  const playAudioChunk = (ctx: AudioContext, base64Audio: string) => {
    if (ctx.state === "suspended") {
      ctx.resume();
    }

    const binary = atob(base64Audio);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    
    const buffer = ctx.createBuffer(1, bytes.length / 2, 16000); // ៣. ប្ដូរ rate មក 16000 ដូចគ្នា
    const data = buffer.getChannelData(0);
    const view = new Int16Array(bytes.buffer);
    for (let i = 0; i < view.length; i++) {
      data[i] = view[i] / 32768;
    }

    if (screenGainNodeRef.current) {
      const targetVolume = dubbingMode === 'replacement' ? 0.0 : 0.15;
      screenGainNodeRef.current.gain.setTargetAtTime(targetVolume, ctx.currentTime, 0.05);

      if (duckTimeoutRef.current) clearTimeout(duckTimeoutRef.current);
      duckTimeoutRef.current = window.setTimeout(() => {
        if (screenGainNodeRef.current) {
          screenGainNodeRef.current.gain.setTargetAtTime(1.0, ctx.currentTime, 0.15);
        }
      }, 800);
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    const currentTime = ctx.currentTime;
    if (nextPlaybackTimeRef.current < currentTime) {
      nextPlaybackTimeRef.current = currentTime + 0.02;
    }

    source.start(nextPlaybackTimeRef.current);
    nextPlaybackTimeRef.current += buffer.duration;
  };

  // ៣. ញែក stopTranslation() ចេញពីគ្នា
  const stopTranslation = () => {
    if (wsRef.current) {
      wsRef.current.onmessage = null;
      wsRef.current.onopen = null;
      const ws = wsRef.current;
      ws.onclose = () => { wsRef.current = null; };
      ws.close();
    }
    if (processorRef.current) {
        processorRef.current.disconnect();
        processorRef.current = null;
    }
    if (inputAudioCtxRef.current) {
      inputAudioCtxRef.current.close();
      inputAudioCtxRef.current = null;
    }
    if (outputAudioCtxRef.current) {
      outputAudioCtxRef.current.close();
      outputAudioCtxRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }
    if (displayStreamRef.current) {
      displayStreamRef.current.getTracks().forEach(track => track.stop());
      displayStreamRef.current = null;
    }
    if (duckTimeoutRef.current) clearTimeout(duckTimeoutRef.current);
    
    screenGainNodeRef.current = null;
    nextPlaybackTimeRef.current = 0;
    setConnected(false);
    setLiveSubtitle("");
  };

  // ៣. បង្កើត stopLearning() ដាច់ដោយឡែក
  const stopLearning = () => {
    if (learningWsRef.current) {
      learningWsRef.current.onmessage = null;
      learningWsRef.current.onopen = null;
      const lws = learningWsRef.current;
      lws.onclose = () => { learningWsRef.current = null; };
      lws.close();
    }
    if (processorRef.current) {
        processorRef.current.disconnect();
        processorRef.current = null;
    }
    if (inputAudioCtxRef.current) {
      inputAudioCtxRef.current.close();
      inputAudioCtxRef.current = null;
    }
    if (outputAudioCtxRef.current) {
      outputAudioCtxRef.current.close();
      outputAudioCtxRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }
    if (duckTimeoutRef.current) clearTimeout(duckTimeoutRef.current);
    
    nextPlaybackTimeRef.current = 0;
    setConnected(false);
  };

  const startTranslation = async (activeSource = sourceLang, activeTarget = targetLang, mode = captureMode) => {
    if (!isPaid) {
      setPayStep(1);
      setShowPayModal(true);
      return;
    }

    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    try {
      let stream: MediaStream;
      let audioStream: MediaStream;

      if (mode === 'screen') {
        const isMobile = /Android|iPhone|iPad|iPod|webOS/i.test(navigator.userAgent);
        if (isMobile) {
          alert("មុខងារ Share System Audio មិនគាំទ្រនៅលើទូរស័ព្ទដៃឡើយ ដោយសារការរឹតបន្តឹងប្រព័ន្ធសុវត្ថិភាព (OS Restriction)។ សូមប្រើប្រាស់មុខងារ Microphone ជំនួសវិញ ឬបើកកម្មវិធីនេះនៅលើកុំព្យូទ័រ White成品។");
          setCaptureMode('mic');
          return;
        }

        stream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        });
        displayStreamRef.current = stream;

        const audioTracks = stream.getAudioTracks();
        if (audioTracks.length === 0) {
          stream.getTracks().forEach(track => track.stop());
          alert("សូមប្រាកដថាអ្នកបានធិក (Tick) លើពាក្យ 'Share tab audio' ឬ 'Share system audio' មុនពេលចែករំលែកអេក្រង់។");
          return;
        }

        audioStream = new MediaStream([audioTracks[0]]);
        const videoTracks = stream.getVideoTracks();
        if (videoTracks.length > 0) {
          videoTracks[0].onended = () => stopTranslation();
        }
      } else {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        });
        audioStream = stream;
      }

      mediaStreamRef.current = audioStream;
      const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      
      const ws = new WebSocket(
        `${wsProtocol}//${location.host}/live?source=${activeSource}&target=${activeTarget}&userId=${userId}`
      );
      wsRef.current = ws;

      const inputAudioCtx = new AudioContext({ latencyHint: "interactive", sampleRate: 16000 });
      const outputAudioCtx = new AudioContext({ latencyHint: "interactive" });

      await inputAudioCtx.resume();
      await outputAudioCtx.resume();

      inputAudioCtxRef.current = inputAudioCtx;
      outputAudioCtxRef.current = outputAudioCtx;
      nextPlaybackTimeRef.current = 0;

      if (mode === 'screen') {
        const screenOutputSource = outputAudioCtx.createMediaStreamSource(audioStream);
        const screenGainNode = outputAudioCtx.createGain();
        screenGainNode.gain.setValueAtTime(1.0, outputAudioCtx.currentTime);
        screenOutputSource.connect(screenGainNode);
        screenGainNode.connect(outputAudioCtx.destination);
        screenGainNodeRef.current = screenGainNode;
      }

      const inputSource = inputAudioCtx.createMediaStreamSource(audioStream);
      const processor = inputAudioCtx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;
      inputSource.connect(processor);
      processor.connect(inputAudioCtx.destination);

      processor.onaudioprocess = (e) => {
        if (ws.readyState === WebSocket.OPEN) {
          const inputData = e.inputBuffer.getChannelData(0);
          const base64 = pcmToBase64(inputData);
          ws.send(JSON.stringify({ audio: base64 })); // ២. Format ផ្ញើ { audio: base64 }
        }
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.error) {
          alert(msg.error);
          stopTranslation();
          return;
        }
        if (msg.interrupted) {
          nextPlaybackTimeRef.current = outputAudioCtx.currentTime;
          return;
        }
        if (msg.audio) {
          playAudioChunk(outputAudioCtx, msg.audio);
        }
        
        if (msg.outputTranscript && msg.outputTranscript !== lastTranscriptRef.current) {
          lastTranscriptRef.current = msg.outputTranscript;
          setLiveSubtitle(msg.outputTranscript);
          
          if (subtitleTimeoutRef.current) clearTimeout(subtitleTimeoutRef.current);
          subtitleTimeoutRef.current = window.setTimeout(() => setLiveSubtitle(""), 4000);

          setTranscript(prev => [
            ...prev.slice(-19), 
            { original: msg.inputTranscript || "...", translated: msg.outputTranscript || "" }
          ]);
        }
      };

      ws.onopen = () => {
        setConnected(true);
        setRestarting(false);
      };
      
      ws.onclose = () => {
          if (wsRef.current === ws) {
              wsRef.current = null;
          }
          setConnected(false);
      };
    } catch (err) {
      console.error("Error starting translation", err);
      setConnected(false);
      setRestarting(false);
    }
  };


  // ③ បង្កើត Function ថ្មី startLearning() ដាច់ដោយឡែក
  const startLearning = async () => {
    if (!isPaid) {
      setPayStep(1);
      setShowPayModal(true);
      return;
    }

    if (learningWsRef.current) {
      learningWsRef.current.close();
      learningWsRef.current = null;
    }

    try {
      // សម្អាត State ចាស់ៗចោលមុនរៀន
      setTopic("");
      setHint("");
      setCorrection("");
      setRepeatText("");
      setScore(null);

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      mediaStreamRef.current = stream;

      // ១. ប្ដូរ WebSocket URL មកកាន់ Link ត្រឹមត្រូវ មិនប្រើ location.host
      const learningWs = new WebSocket(
        "wss://fourlive2way.onrender.com/learning?userId=" + userId
      );
      learningWsRef.current = learningWs;

      const inputAudioCtx = new AudioContext({ latencyHint: "interactive", sampleRate: 16000 });
      const outputAudioCtx = new AudioContext({ latencyHint: "interactive" });

      await inputAudioCtx.resume();
      await outputAudioCtx.resume();

      inputAudioCtxRef.current = inputAudioCtx;
      outputAudioCtxRef.current = outputAudioCtx;
      nextPlaybackTimeRef.current = 0;

      const inputSource = inputAudioCtx.createMediaStreamSource(stream);
      const processor = inputAudioCtx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;
      inputSource.connect(processor);
      processor.connect(inputAudioCtx.destination);

      processor.onaudioprocess = (e) => {
        if (learningWs.readyState === WebSocket.OPEN) {
          const inputData = e.inputBuffer.getChannelData(0);
          const base64 = pcmToBase64(inputData);
          learningWs.send(JSON.stringify({ audio: base64 })); // ២. Format ផ្ញើ { audio: base64 }
        }
      };

      // ៥. learningWs.onmessage គ្រប់គ្រង State រៀនសូត្រ តាម Format ថ្មី (៤)
      learningWs.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.error) {
          alert(msg.error);
          stopLearning();
          return;
        }
        
        if (msg.topic) {
          setTopic(msg.topic);
        }
        if (msg.hint) {
          setHint(msg.hint);
        }
        if (msg.correction) {
          setCorrection(msg.correction);
        }
        if (msg.repeat) {
          setRepeatText(msg.repeat);
        }
        if (msg.score !== undefined) {
          setScore(msg.score);
        }
        if (msg.audio) {
          playAudioChunk(outputAudioCtx, msg.audio);
        }
      };

      learningWs.onopen = () => {
        setConnected(true);
        setRestarting(false);
      };
      
      learningWs.onclose = () => {
          if (learningWsRef.current === learningWs) {
              learningWsRef.current = null;
          }
          setConnected(false);
      };
    } catch (err) {
      console.error("Error starting learning system", err);
      setConnected(false);
      setRestarting(false);
    }
  };

  const changeLanguages = (newSource: string, newTarget: string) => {
    setSourceLang(newSource);
    setTargetLang(newTarget);
    if (connected) {
      setRestarting(true);
      if (appMode === "translate") {
        stopTranslation();
      } else {
        stopLearning();
      }

      const waitClose = () => {
        if (wsRef.current === null && learningWsRef.current === null) {
          if (appMode === "translate") {
            startTranslation(newSource, newTarget, captureMode);
          } else {
            startLearning();
          }
        } else {
          setTimeout(waitClose, 100);
        }
      };

      waitClose();
    }
  };

  const handleCaptureModeChange = (mode: 'mic' | 'screen') => {
    if (mode === 'screen') {
      const isMobile = /Android|iPhone|iPad|iPod|webOS/i.test(navigator.userAgent);
      if (isMobile) {
        alert("មុខងារ Share System Audio មិនគាំទ្រនៅលើទូរស័ព្ទដៃឡើយ។ សូមប្រើប្រាស់នៅលើកុំព្យូទ័រ (Desktop)។");
        return;
      }
    }
    
    setCaptureMode(mode);
    if (connected) {
      stopTranslation();

      const waitClose = () => {
        if (wsRef.current === null && learningWsRef.current === null) {
          startTranslation(sourceLang, targetLang, mode);
        } else {
          setTimeout(waitClose, 100);
        }
      };

      waitClose();
    }
  };

  const getLanguageLabel = (code: string) => {
    const labels: Record<string, string> = {
      km: 'ខ្មែរ (Khmer)', en: 'អង់គ្លេស (English)', zh: 'ចិន (Chinese)', 'zh-HK': 'ចិនកាតាំង (Cantonese)',
      vi: 'វៀតណាម (Vietnamese)', ja: 'ជប៉ុន (Japanese)', ko: 'កូរ៉េ (Korean)', th: 'ថៃ (Thai)',
      id: 'ឥណ្ឌូនេស៊ី (Indonesian)', ms: 'ម៉ាឡេស៊ី (Malay)', lo: 'ឡាវ (Lao)', fr: 'បារាំង (French)',
      de: 'អាល្លឺម៉ង់ (German)', no: 'ន័រវែស (Norwegian)', hi: 'ហិណ្ឌី (Hindi)', fil: 'ហ្វីលីពិន (Filipino)',
      mn: 'ម៉ុងហ្គោលី (Mongolian)', it: 'អ៊ីតាលី (Italian)', he: 'ហេប្រឺ (Hebrew)', ru: 'រុស្ស៊ី (Russian)', my: 'ភូមា (Burmese)'
    };
    return labels[code] || code;
  };

  return (
    <div className="w-full h-screen bg-[#060913] text-[#FFFFFF] font-['Inter','Noto_Sans_Khmer',sans-serif] flex flex-col overflow-hidden relative antialiased">
      
      {/* CSS For Premium Animations and Neon Effects */}
      <style>{`
        @keyframes breathe {
          0%, 100% { transform: scale(1); box-shadow: 0 0 25px rgba(30, 80, 255, 0.4), inset 0 0 15px rgba(255,255,255,0.1); }
          50% { transform: scale(1.03); box-shadow: 0 0 45px rgba(30, 80, 255, 0.8), inset 0 0 25px rgba(30, 80, 255, 0.3); }
        }
        @keyframes blink {
          0%, 90%, 100% { transform: scaleY(1); }
          55% { transform: scaleY(0.1); }
        }
        @keyframes wave-height {
          0%, 100% { height: 6px; opacity: 0.4; }
          50% { height: 28px; opacity: 1; }
        }
        .animate-breathe { animation: breathe 3.5s ease-in-out infinite; }
        .animate-blink { animation: blink 1.5s ease-in-out infinite; }
        .animate-wave-bar-1 { animation: wave-height 0.5s ease-in-out infinite alternate; }
        .animate-wave-bar-2 { animation: wave-height 0.35s ease-in-out infinite alternate 0.1s; }
        .animate-wave-bar-3 { animation: wave-height 0.6s ease-in-out infinite alternate 0.2s; }
        .animate-wave-bar-4 { animation: wave-height 0.45s ease-in-out infinite alternate 0.15s; }
        .animate-wave-bar-5 { animation: wave-height 0.55s ease-in-out infinite alternate 0.3s; }
      `}</style>

      {/* HEADER */}
      <header className="h-14 border-b border-white/5 px-6 flex items-center justify-between bg-[#111625]/60 backdrop-blur-xl z-10">
        <div className="flex items-center space-x-3">
          <div 
            onClick={() => { setPayStep(1); setShowPayModal(true); }}
            className="w-8 h-8 bg-[#4F7CFF] rounded-lg flex items-center justify-center border border-white/10 shadow-sm cursor-pointer hover:bg-opacity-80 transition-all"
          >
            <span className="text-white font-bold text-sm">ខ</span>
          </div>
          <div className="cursor-pointer" onClick={() => { setPayStep(1); setShowPayModal(true); }}>
            <h1 className="text-sm font-semibold tracking-tight text-white flex items-center gap-1.5">
              Live-Translate 
              <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-bold ${isPaid ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-red-500/20 text-red-400 border border-red-500/30'}`}>
                {isPaid ? "Premium" : "បង់ប្រាក់"}
              </span>
            </h1>
            <p className="text-[8px] uppercase tracking-[0.2em] text-[#A1A1AA] truncate max-w-[150px] font-mono">{userId || "Loading ID..."}</p>
          </div>
        </div>

        {/* MODE TOGGLER SWITCHER */}
        <div className="flex bg-[#171A21] p-0.5 rounded-xl border border-white/5 text-[11px]">
          <button
            onClick={() => { if(appMode === "translate") stopTranslation(); else stopLearning(); setAppMode("translate"); }}
            className={`px-3 py-1 rounded-lg font-medium transition-all flex items-center gap-1 ${appMode === 'translate' ? 'bg-[#4F7CFF] text-white shadow-md' : 'text-[#A1A1AA] hover:text-white'}`}
          >
            <Languages size={12} />
            Translate
          </button>
          <button
            onClick={() => { if(appMode === "translate") stopTranslation(); else stopLearning(); setAppMode("learning"); }}
            className={`px-3 py-1 rounded-lg font-medium transition-all flex items-center gap-1 ${appMode === 'learning' ? 'bg-[#4F7CFF] text-white shadow-md' : 'text-[#A1A1AA] hover:text-white'}`}
          >
            <GraduationCap size={12} />
            Learn
          </button>
        </div>

        <div className="flex items-center space-x-3">
          {captureMode === 'screen' && appMode === 'translate' && (
            <div className="flex bg-[#171A21] p-0.5 rounded-lg border border-white/5 text-[10px]">
              <button
                onClick={() => setDubbingMode('ducking')}
                className={`px-2.5 py-1 rounded-md font-medium transition-all ${dubbingMode === 'ducking' ? 'bg-white/10 text-white' : 'text-[#A1A1AA]'}`}
              >
                Ducking
              </button>
              <button
                onClick={() => setDubbingMode('replacement')}
                className={`px-2.5 py-1 rounded-md font-medium transition-all ${dubbingMode === 'replacement' ? 'bg-white/10 text-white' : 'text-[#A1A1AA]'}`}
              >
                AI Dub
              </button>
            </div>
          )}

          {appMode === 'translate' && (
            <div className="flex bg-[#171A21] p-0.5 rounded-lg border border-white/5">
              <button
                onClick={() => handleCaptureModeChange('mic')}
                className={`p-1 rounded-md transition-all ${captureMode === 'mic' ? 'bg-[#4F7CFF] text-white' : 'text-[#A1A1AA]'}`}
                title="Microphone"
              >
                <Mic size={14} />
              </button>
              <button
                onClick={() => handleCaptureModeChange('screen')}
                className={`p-1 rounded-md transition-all ${captureMode === 'screen' ? 'bg-[#4F7CFF] text-white' : 'text-[#A1A1AA]'}`}
                title="System Audio"
              >
                <Monitor size={14} />
              </button>
            </div>
          )}
        </div>
      </header>

      {/* MAIN LAYOUT */}
      <main className="flex-1 max-w-md w-full mx-auto flex flex-col p-5 overflow-hidden relative justify-start">
        
        {/* LANGUAGE SELECTOR (លាក់ពេលកំពុងស្ថិតក្នុង Learning Mode) */}
        {appMode === 'translate' && (
          <div className="w-full flex items-center justify-center space-x-2 bg-white/5 border border-white/10 backdrop-blur-xl rounded-full p-1 shadow-sm mb-4">
            {/* SOURCE LANGUAGE SELECT */}
            <div className={`flex-1 relative flex justify-center rounded-full transition-all duration-200 ${
              focusedSelect === 'source' ? 'bg-white/10 ring-1 ring-[#4F7CFF]/50' : 'hover:bg-white/5'
            }`}>
              <span className="text-xs font-semibold px-4 py-1.5 text-white text-center block truncate max-w-[140px]">
                {getLanguageLabel(sourceLang)}
              </span>
              <select
                className="absolute inset-0 opacity-0 w-full cursor-pointer bg-[#171A21] text-white"
                value={sourceLang}
                onFocus={() => setFocusedSelect('source')}
                onBlur={() => setFocusedSelect(null)}
                onChange={(e) => {
                  changeLanguages(e.target.value, targetLang);
                  e.target.blur();
                }}
              >
                <option value="km">ខ្មែរ (Khmer)</option>
                <option value="en">អង់គ្លេស (English)</option>
                <option value="zh">ចិន (Chinese)</option>
                <option value="zh-HK">ចិនកាតាំង (Cantonese)</option>
                <option value="vi">វៀតណាម (Vietnamese)</option>
                <option value="ja">ជប៉ុន (Japanese)</option>
                <option value="ko">កូរ៉េ (Korean)</option>
                <option value="th">ថៃ (Thai)</option>
                <option value="id">ឥណ្ឌូនេស៊ី (Indonesian)</option>
                <option value="ms">ម៉ាឡេស៊ី (Malay)</option>
                <option value="lo">ឡាវ (Lao)</option>
                <option value="fr">បារាំង (French)</option>
                <option value="de">អាល្លឺម៉ង់ (German)</option>
                <option value="no">ន័រវែស (Norwegian)</option>
                <option value="hi">ឥណ្ឌា (Hindi)</option>
                <option value="fil">ហ្វីលីពិន (Filipino)</option>
                <option value="mn">ម៉ុងហ្គោលី (Mongolian)</option>
                <option value="it">អ៊ីតាលី (Italian)</option>
                <option value="he">អ៊ីស្រាអែល (Hebrew)</option>
                <option value="ru">រុស្ស៊ី (Russian)</option>
                <option value="my">ភូមា (Burmese)</option>
              </select>
            </div>
            
            <div className="text-[#A1A1AA] p-1 bg-[#171A21] rounded-full border border-white/5 flex-shrink-0">
              <ArrowLeftRight size={12} />
            </div>

            {/* TARGET LANGUAGE SELECT */}
            <div className={`flex-1 relative flex justify-center rounded-full transition-all duration-200 ${
              focusedSelect === 'target' ? 'bg-white/10 ring-1 ring-[#4F7CFF]/50' : 'hover:bg-white/5'
            }`}>
              <span className="text-xs font-semibold px-4 py-1.5 text-white text-center block truncate max-w-[140px]">
                {getLanguageLabel(targetLang)}
              </span>
              <select
                className="absolute inset-0 opacity-0 w-full cursor-pointer bg-[#171A21] text-white"
                value={targetLang}
                onFocus={() => setFocusedSelect('target')}
                onBlur={() => setFocusedSelect(null)}
                onChange={(e) => {
                  changeLanguages(sourceLang, e.target.value);
                  e.target.blur();
                }}
              >
                <option value="km">ខ្មែរ (Khmer)</option>
                <option value="en">អង់គ្លេស (English)</option>
                <option value="zh">ចិន (Chinese)</option>
                <option value="zh-HK">ចិនកាតាំង (Cantonese)</option>
                <option value="vi">វៀតណាម (Vietnamese)</option>
                <option value="ja">ជប៉ុន (Japanese)</option>
                <option value="ko">កូរ៉េ (Korean)</option>
                <option value="th">ថៃ (Thai)</option>
                <option value="id">ឥណ្ឌូនេស៊ី (Indonesian)</option>
                <option value="ms">ម៉ាឡស៊ី (Malay)</option>
                <option value="lo">ឡាវ (Lao)</option>
                <option value="fr">បារាំង (French)</option>
                <option value="de">អាល្លឺម៉ង់ (German)</option>
                <option value="no">ន័រវែស (Norwegian)</option>
                <option value="hi">ឥណ្ឌា (Hindi)</option>
                <option value="fil">ហ្វីលីពិន (Filipino)</option>
                <option value="mn">ម៉ុងហ្គោលី (Mongolian)</option>
                <option value="it">អ៊ីតាលី (Italian)</option>
                <option value="he">អ៊ីស្រាអែល (Hebrew)</option>
                <option value="ru">រុស្ស៊ី (Russian)</option>
                <option value="my">ភូមា (Burmese)</option>
              </select>
            </div>
          </div>
        )}

        {/* ROBOT HEAD UI SECTION */}
        <div className="flex flex-col items-center justify-center pt-2 pb-4">
          <div className="relative flex flex-col items-center">
            <div className={`w-32 h-24 rounded-[40px] bg-gradient-to-b from-[#1E293B] to-[#0F172A] border-[3px] flex items-center justify-center p-4 shadow-2xl transition-all duration-300 relative
              ${connected 
                ? 'border-[#4F7CFF] shadow-[0_0_30px_rgba(79,124,255,0.4)]' 
                : 'border-[#334155] shadow-black'
              }`}
            >
              <div className="absolute -top-4 w-1 h-4 bg-slate-500 left-1/2 -translate-x-1/2">
                <div className={`absolute -top-2 w-3 h-3 rounded-full left-1/2 -translate-x-1/2 shadow-lg transition-colors duration-300
                  ${connected ? 'bg-[#4F7CFF] shadow-[0_0_10px_#4F7CFF]' : 'bg-slate-400'}`} 
                />
              </div>

              <div className="absolute -left-2.5 w-2 h-8 bg-slate-600 rounded-l-md top-1/2 -translate-y-1/2" />
              <div className="absolute -right-2.5 w-2 h-8 bg-slate-600 rounded-r-md top-1/2 -translate-y-1/2" />

              <div className="w-full h-full bg-[#090D1A] rounded-[24px] border border-white/5 flex items-center justify-center gap-6 px-4">
                <div className={`w-5 h-5 rounded-full transition-all duration-300
                  ${connected 
                    ? 'bg-[#4F7CFF] shadow-[0_0_20px_#4F7CFF] scale-110 animate-blink' 
                    : 'bg-[#2E5BFF] shadow-[0_0_10px_rgba(46,91,255,0.6)]'
                  }`} 
                />
                <div className={`w-5 h-5 rounded-full transition-all duration-300
                  ${connected 
                    ? 'bg-[#4F7CFF] shadow-[0_0_20px_#4F7CFF] scale-110 animate-blink' 
                    : 'bg-[#2E5BFF] shadow-[0_0_10px_rgba(46,91,255,0.6)]'
                  }`} 
                />
              </div>
            </div>

            <p className="text-[11px] text-slate-400 max-w-[260px] leading-relaxed mt-3 text-center">
              {restarting
                ? "កំពុងអនុវត្តភាសាថ្មី..."
                : connected 
                ? (appMode === "translate" ? "ប្រព័ន្ធកំពុងដំណើរការស្តាប់ និងបកប្រែដោយស្វ័យប្រវត្តិ" : "កំពុងដំណើរការរៀនសូត្រ... សូមនិយាយជាភាសាអង់គ្លេស")
                : (appMode === "translate" ? "សូមចុចប៊ូតុង Live Translator ដើម្បីចាប់ផ្តើមបកប្រែ" : "សូមចុចប៊ូតុង Learn Language ដើម្បីចាប់ផ្ដើមអនុវត្ត")
              }
            </p>
          </div>
        </div>

        {/* ⑥ UI CARD sections សម្រាប់ LEARNING MODE (បង្ហាញក្រោម Robot ពេលស្ថិតក្នុង Learning Mode) */}
        {appMode === "learning" && (
          <div className="w-full space-y-3 mb-2 overflow-y-auto max-h-[220px] pr-1 scrollbar-none">
            {/* Topic Card */}
            {topic && (
              <div className="bg-gradient-to-r from-blue-600/20 to-indigo-600/10 border border-blue-500/30 rounded-2xl p-3 shadow-md animate-fadeIn">
                <div className="flex items-center gap-2 text-blue-400 font-bold text-xs mb-1 uppercase tracking-wider">
                  <BookOpen size={14} /> Topic
                </div>
                <p className="text-sm font-semibold text-white">{topic}</p>
              </div>
            )}

            {/* Hint Card */}
            {hint && (
              <div className="bg-gradient-to-r from-amber-600/15 to-amber-500/5 border border-amber-500/20 rounded-2xl p-3 shadow-md animate-fadeIn">
                <div className="flex items-center gap-2 text-amber-400 font-bold text-xs mb-1 uppercase tracking-wider">
                  <Lightbulb size={14} /> Hint / គន្លឹះណែនាំ
                </div>
                <div className="text-xs text-slate-200 font-medium whitespace-pre-line leading-relaxed pl-1">
                  {hint}
                </div>
              </div>
            )}

            {/* Correction Card */}
            {correction && (
              <div className="bg-gradient-to-r from-emerald-600/20 to-teal-600/10 border border-emerald-500/30 rounded-2xl p-3 shadow-md animate-fadeIn">
                <div className="flex items-center gap-2 text-emerald-400 font-bold text-xs mb-1 uppercase tracking-wider">
                  <CheckCircle2 size={14} /> Correction / កែលម្អប្រយោគ
                </div>
                <p className="text-xs font-semibold text-emerald-100 bg-emerald-950/40 p-2 rounded-xl border border-emerald-500/10">{correction}</p>
              </div>
            )}

            {/* Repeat Card */}
            {repeatText && (
              <div className="bg-gradient-to-r from-purple-600/20 to-pink-600/10 border border-purple-500/30 rounded-2xl p-3 shadow-md animate-fadeIn">
                <div className="flex items-center gap-2 text-purple-400 font-bold text-xs mb-1 uppercase tracking-wider">
                  <RotateCcw size={14} /> Repeat / ថាមកវិញ
                </div>
                <p className="text-xs text-purple-100 font-medium italic">{repeatText}</p>
              </div>
            )}

            {/* Score Badge */}
            {score !== null && (
              <div className="flex items-center justify-center gap-2 bg-gradient-to-r from-yellow-500/20 to-amber-500/20 border border-yellow-500/40 rounded-full py-1.5 px-4 w-fit mx-auto animate-fadeIn shadow-lg">
                <Star size={14} className="text-yellow-400 fill-yellow-400" />
                <span className="text-xs font-bold text-yellow-300">ពិន្ទុបញ្ចេញសំឡេង៖ <span className="text-sm font-black text-white font-mono">{score}</span> / 100</span>
              </div>
            )}
          </div>
        )}

        {/* CONVERSATION BUBBLES CONTAINER (បង្ហាញតែក្នុង Translate Mode) */}
        {appMode === "translate" && (
          <div className="flex-1 w-full my-1 overflow-y-auto max-h-[100px] space-y-2 pr-1 scrollbar-none flex flex-col justify-end">
            {transcript.slice(-2).map((item, i) => (
              <div key={i} className="space-y-1 animate-fadeIn max-w-[90%] mx-auto w-full">
                <div className="bg-[#111625] border border-white/5 rounded-xl p-2.5 shadow-sm text-center">
                  <p className="text-xs text-[#4F7CFF] font-semibold">{item.translated}</p>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* LOWER CENTER: MAIN BUTTON CONTROL ORB (DYNAMIC ACTIONS) */}
        <div className="w-full flex justify-center items-center pt-4 pb-[130px] relative">
          {connected && (
            <>
              <div className="absolute left-4 md:left-12 flex items-center gap-1 h-10">
                <div className="w-[3px] bg-cyan-400 rounded-full animate-wave-bar-1" />
                <div className="w-[3px] bg-[#4F7CFF] rounded-full animate-wave-bar-2" />
                <div className="w-[3px] bg-blue-500 rounded-full animate-wave-bar-3" />
                <div className="w-[3px] bg-indigo-400 rounded-full animate-wave-bar-4" />
              </div>
              <div className="absolute right-4 md:right-12 flex items-center gap-1 h-10">
                <div className="w-[3px] bg-indigo-400 rounded-full animate-wave-bar-4" />
                <div className="w-[3px] bg-blue-500 rounded-full animate-wave-bar-3" />
                <div className="w-[3px] bg-[#4F7CFF] rounded-full animate-wave-bar-2" />
                <div className="w-[3px] bg-cyan-400 rounded-full animate-wave-bar-1" />
              </div>
            </>
          )}

          {connected ? (
            <div className="relative flex items-center justify-center">
              <div className="absolute -inset-2 rounded-full border border-red-500/40 animate-ping opacity-75" style={{ animationDuration: '1.8s' }} />
              <div className="absolute -inset-4 rounded-full border border-red-600/20 animate-ping opacity-40" style={{ animationDuration: '2.5s' }} />

              <button 
                onClick={appMode === "translate" ? stopTranslation : stopLearning}
                className="
                  w-[140px] h-[140px] md:w-[180px] md:h-[180px]
                  rounded-full
                  bg-gradient-to-b from-[#EF4444] via-[#DC2626] to-[#991B1B]
                  text-white
                  shadow-[0_0_40px_rgba(239,68,68,0.7),inset_0_4px_12px_rgba(255,255,255,0.3)]
                  border-2 border-red-400/50
                  transition-all duration-300
                  hover:scale-105 active:scale-95
                  flex flex-col items-center justify-center select-none p-2
                "
              >
                {appMode === "translate" ? <Languages size={24} className="mb-1 text-red-100 md:w-7 md:h-7 drop-shadow-md" /> : <GraduationCap size={24} className="mb-1 text-red-100 md:w-7 md:h-7 drop-shadow-md" />}
                <span className="text-[12px] md:text-sm font-light uppercase tracking-[0.18em] text-red-100/90 leading-tight">Stop</span>
                <span className="text-sm md:text-base font-extrabold tracking-wide drop-shadow-lg text-white">
                  {appMode === "translate" ? "Translator" : "Learning"}
                </span>
              </button>
            </div>
          ) : (
            <div className="relative flex items-center justify-center">
              <div className="absolute -inset-1.5 rounded-full bg-gradient-to-r from-cyan-500 to-blue-600 blur opacity-40 group-hover:opacity-70 transition duration-1000" />
              <div className="absolute -inset-3 rounded-full border border-blue-500/20 opacity-60" />

              <button 
                disabled={restarting}
                onClick={() => {
                  if (!restarting) {
                    if (appMode === "translate") {
                      startTranslation(sourceLang, targetLang, captureMode);
                    } else {
                      startLearning();
                    }
                  }
                }}
                className="
                  w-[140px] h-[140px] md:w-[180px] md:h-[180px]
                  rounded-full
                  bg-gradient-to-b from-[#2563EB] via-[#1D4ED8] to-[#1E3A8A]
                  text-white
                  border-2 border-blue-400/40
                  shadow-[0_0_35px_rgba(37,99,235,0.6),inset_0_4px_12px_rgba(255,255,255,0.3)]
                  transition-all duration-300
                  hover:scale-105 active:scale-95
                  flex flex-col items-center justify-center select-none p-2
                  animate-breathe
                  disabled:opacity-80 disabled:cursor-not-allowed
                "
              >
                {appMode === "translate" ? (
                  <Languages size={26} className="mb-1 text-cyan-200 md:w-8 md:h-8 drop-shadow-[0_0_8px_rgba(34,211,238,0.8)]" />
                ) : (
                  <GraduationCap size={26} className="mb-1 text-cyan-200 md:w-8 md:h-8 drop-shadow-[0_0_8px_rgba(34,211,238,0.8)]" />
                )}
                
                {restarting ? (
                  <>
                    <span className="text-[11px] text-cyan-100">Applying</span>
                    <span className="text-sm font-bold text-white">New State...</span>
                  </>
                ) : (
                  <>
                    <span className="text-[12px] md:text-sm font-light uppercase tracking-[0.18em] text-cyan-100/90 leading-tight">
                      {appMode === "translate" ? "Live" : "Learn"}
                    </span>
                    <span className="text-sm md:text-base font-extrabold tracking-wide drop-shadow-lg text-white">
                      {appMode === "translate" ? "Translator" : "Language"}
                    </span>
                  </>
                )}
              </button>
            </div>
          )}
        </div>
      </main>

      {/* FLOATING SUBTITLE OVERLAY (បង្ហាញតែក្នុង Translate Mode) */}
      {liveSubtitle && appMode === "translate" && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-2xl bg-black/70 border border-white/10 backdrop-blur-xl text-white text-base font-semibold text-center max-w-[85%] shadow-2xl pointer-events-none animate-fadeIn">
          {liveSubtitle}
        </div>
      )}

      {/* ========================================================================= */}
      {/* ផ្ទាំង PREMIUM POPUP MODAL */}
      {/* ========================================================================= */}
      {showPayModal && (
        <div className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-center justify-center p-4 animate-fadeIn">
          <div className="bg-[#111625] border border-white/10 p-6 rounded-3xl max-w-sm w-full text-center relative shadow-2xl">
            
            {(payStep === 1 || payStep === 4) && (
              <button 
                onClick={() => setShowPayModal(false)} 
                className="absolute top-4 right-4 text-slate-400 hover:text-white transition-colors p-1 text-sm font-bold"
              >
                ✕
              </button>
            )}

            {/* ជំហានទី ១ */}
            {payStep === 1 && (
              <div>
                <div className="w-12 h-12 bg-[#4F7CFF]/15 text-[#4F7CFF] rounded-full flex items-center justify-center mx-auto mb-3 border border-[#4F7CFF]/30">
                  <Languages size={22} />
                </div>
                <h3 className="text-base font-bold text-white mb-1">គណនីប្រើប្រាស់ប្រព័ន្ធ</h3>
                <p className="text-[11px] text-slate-400 mb-4 font-mono">{expiryText}</p>

                <div className="bg-white/[0.03] border border-white/5 p-3 rounded-2xl mb-4 flex justify-between items-center text-left">
                  <div>
                    <span className="text-[9px] uppercase tracking-wider text-slate-500 block">ID ម៉ាស៊ីនរបស់អ្នក</span>
                    <span className="text-xs text-slate-300 font-mono font-bold">{userId}</span>
                  </div>
                  <button 
                    onClick={copyIdToClipboard}
                    className="p-2 bg-white/5 hover:bg-white/10 rounded-xl text-[#4F7CFF] transition-all flex items-center gap-1 text-[11px]"
                  >
                    {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>

                <button 
                  onClick={() => setPayStep(2)} 
                  className="w-full bg-[#4F7CFF] hover:bg-[#3b66e0] py-3 rounded-2xl font-bold text-sm text-white shadow-lg transition-all"
                >
                  បង់ប្រាក់ដើម្បីប្រើប្រាស់
                </button>
              </div>
            )}

            {/* ជំហានទី ២ */}
            {payStep === 2 && (
              <div>
                <h3 className="text-base font-bold text-white mb-1">ជ្រើសរើសរយៈពេលប្រើប្រាស់</h3>
                <p className="text-xs text-slate-400 mb-4">ជ្រើសរើសកញ្ចប់ណាមួយដើម្បីបន្តទៅកាន់ការទូទាត់</p>
                
                <div className="space-y-2 mb-4">
                  <button 
                    onClick={() => { setSelectedPlan({ name: "1 ថ្ងៃ", price: "0.50$", days: 1 }); setPayStep(3); }}
                    className="w-full bg-white/[0.03] hover:bg-white/5 border border-white/5 p-3.5 rounded-2xl flex justify-between items-center text-sm font-semibold text-slate-200 transition-all"
                  >
                    <span>កញ្ចប់សាកល្បង (1 ថ្ងៃ)</span>
                    <span className="text-[#4F7CFF]">0.50$</span>
                  </button>
                  <button 
                    onClick={() => { setSelectedPlan({ name: "1 សប្ដាហ៍", price: "1.00$", days: 7 }); setPayStep(3); }}
                    className="w-full bg-white/[0.03] hover:bg-white/5 border border-white/5 p-3.5 rounded-2xl flex justify-between items-center text-sm font-semibold text-slate-200 transition-all"
                  >
                    <span>កញ្ចប់ប្រចាំសប្ដាហ៍ (1 សប្ដាហ៍)</span>
                    <span className="text-[#4F7CFF]">1.00$</span>
                  </button>
                  <button 
                    onClick={() => { setSelectedPlan({ name: "1 ខែ", price: "3.00$", days: 30 }); setPayStep(3); }}
                    className="w-full bg-white/[0.03] hover:bg-white/5 border border-white/5 p-3.5 rounded-2xl flex justify-between items-center text-sm font-semibold text-slate-200 transition-all"
                  >
                    <span>កញ្ចប់ពេញនិយម (1 ខែ)</span>
                    <span className="text-[#4F7CFF]">3.00$</span>
                  </button>
                </div>

                <button onClick={() => setPayStep(1)} className="text-xs text-slate-400 hover:text-white transition-colors underline">ត្រឡប់ក្រោយ</button>
              </div>
            )}

            {/* ជំហានទី ៣ */}
            {payStep === 3 && selectedPlan && (
              <div>
                <h3 className="text-base font-bold text-white mb-1">ស្កេនទូទាត់ប្រាក់ {selectedPlan.price}</h3>
                <p className="text-[10px] text-emerald-400 font-medium mb-3 bg-emerald-500/10 py-1 px-2 rounded-lg inline-block">
                  {calculateDatesText(selectedPlan.days)}
                </p>

                <div className="grid grid-cols-2 gap-2 mb-3">
                  <button 
                    onClick={() => setActiveBank('aba')}
                    className={`p-2 rounded-xl text-center text-[11px] font-bold transition-all block border ${
                      activeBank === 'aba' 
                        ? 'bg-[#005A9C] text-white border-white/20' 
                        : 'bg-[#005A9C]/10 text-slate-300 border-transparent'
                    }`}
                  >
                    ធនាគារ ABA
                  </button>
                  <button 
                    onClick={() => setActiveBank('acleda')}
                    className={`p-2 rounded-xl text-center text-[11px] font-bold transition-all block border ${
                      activeBank === 'acleda' 
                        ? 'bg-[#D4AF37] text-black border-white/20' 
                        : 'bg-[#D4AF37]/10 text-slate-300 border-transparent'
                    }`}
                  >
                    ធនាគារ Acleda
                  </button>
                </div>

                <div className="bg-white p-2 rounded-2xl max-w-[280px] mx-auto mb-3 shadow-md overflow-hidden flex items-center justify-center">
                  <img 
                    src="https://i.postimg.cc/x1QMRHK3/photo-2026-06-25-17-23-28.jpg" 
                    alt="Payment QR Code" 
                    className="w-full h-auto object-contain rounded-xl mx-auto"
                    style={{ maxHeight: '360px' }}
                  />
                </div>

                <p className="text-[10px] text-slate-400 mb-4 leading-tight">
                  សូមថតQRនេះ ដើម្បីយកទៅស្កេនទូទាត់ប្រាក់នៅក្នុង App ធនាគាររបស់អ្នករួចផ្ញើមកTelegram។
                </p>

                <div className="flex gap-2">
                  <button 
                    onClick={() => setPayStep(2)} 
                    className="w-1/3 bg-white/5 hover:bg-white/10 text-slate-300 py-2.5 rounded-xl font-bold text-xs transition-all"
                  >
                    ប្តូរកញ្ចប់
                  </button>
                  <button 
                    onClick={() => {
                      const message = encodeURIComponent(`
🆔 ID ម៉ាស៊ីន៖ ${userId}
📦 កញ្ចប់ជ្រើសរើស៖ ${selectedPlan.name}
💵 តម្លៃទូទាត់៖ ${selectedPlan.price}
🏦 ធនាគារទូទាត់៖ ${activeBank === "aba" ? "ABA Bank" : "Acleda Bank"}

👉 សូមចុច ផ្ញើ បន្ទាប់មកថតវិក័យប័ត្របង់ប្រាក់ផ្ញើមកម្ដងទៀត។
`);
                      window.open(`https://t.me/hengheng56?text=${message}`, "_blank");
                    }} 
                    className="w-2/3 bg-emerald-500 hover:bg-emerald-600 text-white py-2.5 rounded-xl font-bold text-xs shadow-lg transition-all"
                  >
                    ចុចផ្ញើវិក័យប័ត្របង់ប្រាក់ទៅTelegram
                  </button>
                </div>
              </div>
            )}

            {/* ជំហានទី ៤ */}
            {payStep === 4 && (
              <div>
                <div className="w-12 h-12 bg-[#4F7CFF]/15 text-[#4F7CFF] rounded-full flex items-center justify-center mx-auto mb-3">
                  <Phone size={20} />
                </div>
                <h3 className="text-base font-bold text-white mb-1">ភ្ជាប់លេខទូរស័ព្ទ (ស្រេចចិត្ត)</h3>
                <p className="text-xs text-slate-400 mb-4 leading-relaxed">
                  ងាយស្រួលសម្រាប់ការផ្ទៀងផ្ទាត់ និងជួយសម្រួលពេលមានបញ្ហា។ អ្នកអាចខ្វែងចោល [✕] ក៏បាន។
                </p>

                <input 
                  type="tel" 
                  placeholder="បញ្ចូលលេខទូរស័ព្ទរបស់អ្នក" 
                  className="w-full bg-white/[0.03] border border-white/10 p-3 rounded-2xl mb-4 text-center text-sm font-semibold focus:outline-none focus:border-[#4F7CFF] transition-all text-white placeholder-slate-500"
                  value={inputPhone}
                  onChange={(e) => setInputPhone(e.target.value)}
                />

                <div className="flex gap-2">
                  <button 
                    onClick={() => setShowPayModal(false)} 
                    className="w-1/3 bg-white/5 hover:bg-white/10 text-slate-400 py-2.5 rounded-xl font-bold text-xs transition-all"
                  >
                    មិនដាក់ទេ
                  </button>
                  <button 
                    onClick={handleSavePhone} 
                    className="w-2/3 bg-[#4F7CFF] hover:bg-[#3b66e0] text-white py-2.5 rounded-xl font-bold text-xs shadow-lg transition-all"
                  >
                    រក្សាទុក (Save)
                  </button>
                </div>
              </div>
            )}

          </div>
        </div>
      )}

    </div>
  );
}