/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { useEffect, useRef, useState } from 'react';
import { Mic, Monitor, Languages, ArrowLeftRight, Copy, Check } from 'lucide-react';
import Admin from "./Admin"; // បន្ថែមការនាំចូលសមាសភាគ Admin

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
  // បន្ថែមលក្ខខណ្ឌត្រួតពិនិត្យផ្លូវ (Pathname) សម្រាប់ Admin Page
  if (window.location.pathname === "/admin") {
    return <Admin />;
  }

  const [connected, setConnected] = useState(false);
  const [restarting, setRestarting] = useState(false); 
  const [sourceLang, setSourceLang] = useState('km');
  const [targetLang, setTargetLang] = useState('en');
  const [captureMode, setCaptureMode] = useState<'mic' | 'screen'>('mic');
  const [dubbingMode, setDubbingMode] = useState<'ducking' | 'replacement'>('ducking');

  // --- បន្ថែម State សម្រាប់ចំណាំពេលអ្នកប្រើកំពុងចុច Focus លើ Select ភាសា ---
  const [focusedSelect, setFocusedSelect] = useState<'source' | 'target' | null>(null);

  // --- បន្ថែម State សម្រាប់រក្សាទុក User ID (Phase 2) ---
  const [userId] = useState(() => {
    let id = localStorage.getItem("userId");
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem("userId", id);
    }
    return id;
  });

  // --- បន្ថែម State សម្រាប់បង្ហាញស្ថានភាពពេលចុច Copy ID ---
  const [copied, setCopied] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const displayStreamRef = useRef<MediaStream | null>(null);
  const [transcript, setTranscript] = useState<{original: string, translated: string}[]>([]);

  const [liveSubtitle, setLiveSubtitle] = useState("");
  const subtitleTimeoutRef = useRef<number | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);

  const nextPlaybackTimeRef = useRef<number>(0);
  const screenGainNodeRef = useRef<GainNode | null>(null);
  const duckTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (subtitleTimeoutRef.current) clearTimeout(subtitleTimeoutRef.current);
      if (duckTimeoutRef.current) clearTimeout(duckTimeoutRef.current);
    };
  }, []);

  // មុខងារសម្រាប់ Copy ID ទៅកាន់ Clipboard
  const handleCopyId = async () => {
    try {
      await navigator.clipboard.writeText(userId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy ID: ", err);
    }
  };

  const playAudioChunk = (ctx: AudioContext, base64Audio: string) => {
    const binary = atob(base64Audio);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    
    const buffer = ctx.createBuffer(1, bytes.length / 2, 24000);
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

  const stopTranslation = () => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
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

  const startTranslation = async (activeSource = sourceLang, activeTarget = targetLang, mode = captureMode) => {
    try {
      let stream: MediaStream;
      let audioStream: MediaStream;

      if (mode === 'screen') {
        const isMobile = /Android|iPhone|iPad|iPod|webOS/i.test(navigator.userAgent);
        if (isMobile) {
          alert("មុខងារ Share System Audio មិនគាំទ្រនៅលើទូរស័ព្ទដៃឡើយ ដោយសារការរឹតបន្តឹងប្រព័ន្ធសុវត្ថិភាព (OS Restriction)។ សូមប្រើប្រាស់មុខងារ Microphone ជំនួសវិញ ឬបើកកម្មវិធីនេះនៅលើកុំព្យូទ័រ។");
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
      
      // កែសម្រួល URL ដើម្បីផ្ញើ userId ទៅកាន់ Server (លុប token ចេញ)
      const ws = new WebSocket(
        `${wsProtocol}//${location.host}/live?source=${activeSource}&target=${activeTarget}&userId=${encodeURIComponent(userId)}`
      );
      wsRef.current = ws;

      const inputAudioCtx = new AudioContext({ latencyHint: "interactive", sampleRate: 16000 });
      const outputAudioCtx = new AudioContext({ latencyHint: "interactive", sampleRate: 24000 });
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
      const processor = inputAudioCtx.createScriptProcessor(512, 1, 1);
      processorRef.current = processor;
      inputSource.connect(processor);
      processor.connect(inputAudioCtx.destination);

      processor.onaudioprocess = (e) => {
        if (ws.readyState === WebSocket.OPEN) {
          const inputData = e.inputBuffer.getChannelData(0);
          const base64 = pcmToBase64(inputData);
          ws.send(JSON.stringify({ audio: base64 }));
        }
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        
        if (msg.error) {
          alert(`កំហុសប្រព័ន្ធ (Error): ${msg.error}`);
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
        if (msg.outputTranscript) {
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
      
      ws.onclose = () => setConnected(false);
    } catch (err) {
      console.error("Error starting translation", err);
      setConnected(false);
      setRestarting(false);
    }
  };

  const changeLanguages = (newSource: string, newTarget: string) => {
    setSourceLang(newSource);
    setTargetLang(newTarget);
    if (connected) {
      setRestarting(true);
      stopTranslation();
      setTimeout(() => {
        startTranslation(newSource, newTarget, captureMode);
      }, 300);
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
      setTimeout(() => {
        startTranslation(sourceLang, targetLang, mode);
      }, 300);
    }
  };

  const getLanguageLabel = (code: string) => {
    const labels: Record<string, string> = {
      km: 'ខ្មែរ (Khmer)',
      en: 'អង់គ្លេស (English)',
      zh: 'ចិន (Chinese)',
      'zh-HK': 'ចិនកាតាំង (Cantonese)',
      vi: 'វៀតណាម (Vietnamese)',
      ja: 'ជប៉ុន (Japanese)',
      ko: 'កូរែ (Korean)',
      th: 'ថៃ (Thai)',
      id: 'ឥណ្ឌូនេស៊ី (Indonesian)',
      ms: 'ម៉ាឡេស៊ី (Malay)',
      lo: 'ឡាវ (Lao)',
      fr: 'បារាំង (French)',
      de: 'អាល្លឺម៉ង់ (German)',
      no: 'ន័រវែស (Norwegian)',
      hi: 'ហិណ្ឌី (Hindi)',
      fil: 'ហ្វីលីពិន (Filipino)',
      mn: 'ម៉ុងហ្គោលី (Mongolian)',
      it: 'អ៊ីតាលី (Italian)',
      he: 'ហេប្រឺ (Hebrew)',
      ru: 'រុស្ស៊ី (Russian)',
      my: 'ភូមា (Burmese)'
    };
    return labels[code] || code;
  };

  return (
    <div className="w-full h-screen bg-[#060913] text-[#FFFFFF] font-['Inter','Noto_Sans_Khmer',sans-serif] flex flex-col overflow-hidden relative antialiased">
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
          <div className="w-8 h-8 bg-[#4F7CFF] rounded-lg flex items-center justify-center border border-white/10 shadow-sm">
            <span className="text-white font-bold text-sm">ខ</span>
          </div>
          <div>
            <h1 className="text-sm font-semibold tracking-tight text-white">Live-Translate</h1>
            <p className="text-[8px] uppercase tracking-[0.2em] text-[#A1A1AA]">2-Way Interpreter</p>
          </div>
        </div>

        <div className="flex items-center space-x-3">
          {captureMode === 'screen' && (
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
        </div>
      </header>

      {/* MAIN LAYOUT */}
      <main className="flex-1 max-w-md w-full mx-auto flex flex-col p-5 overflow-hidden relative justify-start">
        {/* LANGUAGE SELECTOR */}
        <div className="w-full flex items-center justify-center space-x-2 bg-white/5 border border-white/10 backdrop-blur-xl rounded-full p-1 shadow-sm mb-4">
          <div className={`flex-1 relative flex justify-center rounded-full transition-all duration-200 ${focusedSelect === 'source' ? 'bg-white/10 ring-1 ring-[#4F7CFF]/50' : 'hover:bg-white/5'}`}>
            <span className="text-xs font-semibold px-4 py-1.5 text-white text-center block truncate max-w-[140px]">
              {getLanguageLabel(sourceLang)}
            </span>
            <select
              className="absolute inset-0 opacity-0 w-full cursor-pointer bg-[#171A21] text-white"
              value={sourceLang}
              onFocus={() => setFocusedSelect('source')}
              onBlur={() => setFocusedSelect(null)}
              onChange={(e) => { changeLanguages(e.target.value, targetLang); e.target.blur(); }}
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
              <option value="hi">ហិណ្ឌី (Hindi)</option>
              <option value="fil">ហ្វីលីពិន (Filipino)</option>
              <option value="mn">ម៉ុងហ្គោលី (Mongolian)</option>
              <option value="it">អ៊ីតាលី (Italian)</option>
              <option value="he">ហេប្រឺ (Hebrew)</option>
              <option value="ru">រុស្ស៊ី (Russian)</option>
              <option value="my">ភូមា (Burmese)</option>
            </select>
          </div>

          <button 
            onClick={() => changeLanguages(targetLang, sourceLang)}
            className="w-7 h-7 bg-white/10 rounded-full flex items-center justify-center border border-white/5 active:scale-95 transition-transform text-[#4F7CFF]"
          >
            <ArrowLeftRight size={12} />
          </button>

          <div className={`flex-1 relative flex justify-center rounded-full transition-all duration-200 ${focusedSelect === 'target' ? 'bg-white/10 ring-1 ring-[#4F7CFF]/50' : 'hover:bg-white/5'}`}>
            <span className="text-xs font-semibold px-4 py-1.5 text-white text-center block truncate max-w-[140px]">
              {getLanguageLabel(targetLang)}
            </span>
            <select
              className="absolute inset-0 opacity-0 w-full cursor-pointer bg-[#171A21] text-white"
              value={targetLang}
              onFocus={() => setFocusedSelect('target')}
              onBlur={() => setFocusedSelect(null)}
              onChange={(e) => { changeLanguages(sourceLang, e.target.value); e.target.blur(); }}
            >
              <option value="en">អង់គ្លេស (English)</option>
              <option value="km">ខ្មែរ (Khmer)</option>
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
              <option value="hi">ហិណ្ឌី (Hindi)</option>
              <option value="fil">ហ្វីលីពិន (Filipino)</option>
              <option value="mn">ម៉ុងហ្គោលី (Mongolian)</option>
              <option value="it">អ៊ីតាលី (Italian)</option>
              <option value="he">ហេប្រឺ (Hebrew)</option>
              <option value="ru">រុស្ស៊ី (Russian)</option>
              <option value="my">ភូមា (Burmese)</option>
            </select>
          </div>
        </div>

        {/* USER ID DISPLAY WITH COPY BUTTON */}
        <div className="w-full flex justify-center mb-4">
          <button
            onClick={handleCopyId}
            className="flex items-center space-x-1.5 px-3 py-1 bg-white/[0.03] hover:bg-white/[0.07] border border-white/5 rounded-md transition-all active:scale-95 group"
            title="Click to copy User ID"
          >
            <span className="text-[10px] font-mono tracking-wider text-white/50 group-hover:text-white/70 transition-colors">
              ID: {userId}
            </span>
            {copied ? (
              <Check size={10} className="text-emerald-400 animate-scale-in" />
            ) : (
              <Copy size={10} className="text-white/30 group-hover:text-white/60 transition-colors" />
            )}
          </button>
        </div>

        {/* TRANSCRIPT BOX */}
        <div className="flex-1 bg-[#111625]/40 border border-white/5 backdrop-blur-md rounded-3xl p-4 overflow-y-auto mb-6 flex flex-col space-y-3 scrollbar-none shadow-inner min-h-[150px]">
          {transcript.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center p-6 text-white/20">
              <Languages size={36} className="mb-2 stroke-[1.2]" />
              <p className="text-xs font-light">មិនទាន់មានការសន្ទនាឡើយ</p>
              <p className="text-[10px] opacity-60 max-w-[180px] mt-1">ចុចប៊ូតុងខាងក្រោមដើម្បីចាប់ផ្តើមបកប្រែផ្ទាល់</p>
            </div>
          ) : (
            transcript.map((t, idx) => (
              <div key={idx} className="bg-white/[0.02] border border-white/[0.03] p-3 rounded-2xl flex flex-col space-y-1">
                <span className="text-[10px] text-white/40 uppercase tracking-wider font-medium">{getLanguageLabel(sourceLang).split(' ')[0]}</span>
                <p className="text-sm font-light text-white/90 leading-relaxed">{t.original}</p>
                <div className="h-[1px] bg-white/5 my-1" />
                <span className="text-[10px] text-[#4F7CFF] uppercase tracking-wider font-semibold">{getLanguageLabel(targetLang).split(' ')[0]}</span>
                <p className="text-sm font-semibold text-[#4F7CFF] leading-relaxed drop-shadow-[0_0_10px_rgba(79,124,255,0.1)]">{t.translated}</p>
              </div>
            ))
          )}
        </div>

        {/* CONTROLS AREA */}
        <div className="h-32 flex flex-col items-center justify-center relative z-10 mb-4">
          {connected ? (
            <div className="flex flex-col items-center space-y-4 w-full">
              <div className="flex items-end justify-center space-x-1.5 h-8">
                <div className="w-1 bg-[#4F7CFF] rounded-full animate-wave-bar-1" />
                <div className="w-1 bg-[#4F7CFF]/80 rounded-full animate-wave-bar-2" />
                <div className="w-1 bg-[#4F7CFF] rounded-full animate-wave-bar-3" />
                <div className="w-1 bg-[#4F7CFF]/70 rounded-full animate-wave-bar-4" />
                <div className="w-1 bg-[#4F7CFF] rounded-full animate-wave-bar-5" />
              </div>
              
              <button
                onClick={stopTranslation}
                className="px-8 py-3 bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 text-xs font-bold uppercase tracking-[0.2em] rounded-full transition-all active:scale-95 shadow-[0_0_30px_rgba(239,68,68,0.1)]"
              >
                Stop Session
              </button>
            </div>
          ) : (
            <div className="relative">
              <button
                disabled={restarting}
                onClick={() => startTranslation()}
                className="
                  w-24 h-24 rounded-full bg-gradient-to-tr from-[#1E50FF] to-[#4F7CFF]
                  text-white border border-white/20 shadow-[0_0_40px_rgba(79,124,255,0.5)]
                  transition-all duration-300
                  hover:scale-105 active:scale-95
                  flex flex-col items-center justify-center select-none p-2
                  animate-breathe
                  disabled:opacity-80 disabled:cursor-not-allowed
                "
              >
                <Languages size={26} className="mb-1 text-cyan-200 md:w-8 md:h-8 drop-shadow-[0_0_8px_rgba(34,211,238,0.8)]" />
                {restarting ? (
                  <>
                    <span className="text-[11px] text-cyan-100">Applying</span>
                    <span className="text-sm font-bold text-white">New Language...</span>
                  </>
                ) : (
                  <>
                    <span className="text-[12px] md:text-sm font-light uppercase tracking-[0.18em] text-cyan-100/90 leading-tight">Live</span>
                    <span className="text-sm md:text-base font-extrabold tracking-wide drop-shadow-lg text-white">Translator</span>
                  </>
                )}
              </button>
            </div>
          )}
        </div>
      </main>

      {/* FLOATING SUBTITLE OVERLAY */}
      {liveSubtitle && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-2xl bg-black/70 border border-white/10 backdrop-blur-xl text-white text-base font-semibold text-center max-w-[85%] shadow-2xl animate-fade-in">
          {liveSubtitle}
        </div>
      )}
    </div>
  );
}