/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { useEffect, useRef, useState } from 'react';
// បន្ថែម Premium Icons សម្រាប់មុខងារ Settings និង Key Visibility
import { Mic, Monitor, Languages, ArrowLeftRight, Activity, Settings, Eye, EyeOff, Trash2, CheckCircle, XCircle } from 'lucide-react';

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
  const [sourceLang, setSourceLang] = useState('km');
  const [targetLang, setTargetLang] = useState('en');
  const [captureMode, setCaptureMode] = useState<'mic' | 'screen'>('mic');
  const [dubbingMode, setDubbingMode] = useState<'ducking' | 'replacement'>('ducking');

  // --- API KEY & SETTINGS STATE ---
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('gemini_live_api_key') || '');
  const [showKey, setShowKey] = useState(false);
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'failed'>('idle');

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

  // មុខងាររក្សាទុក API Key ចូលក្នុង LocalStorage
  const handleSaveKey = () => {
    if (apiKey.trim()) {
      localStorage.setItem('gemini_live_api_key', apiKey.trim());
      alert("API Key ត្រូវបានរក្សាទុកដោយជោគជ័យ!");
    }
  };

  // មុខងារលុប API Key ចេញពី LocalStorage
  const handleRemoveKey = () => {
    localStorage.removeItem('gemini_live_api_key');
    setApiKey('');
    setTestStatus('idle');
    alert("API Key ត្រូវបានលុបចេញពីឧបករណ៍នេះ!");
  };

  // មុខងារសាកល្បងភ្ជាប់ API Key (Test Connection)
  const handleTestConnection = async () => {
    if (!apiKey.trim()) return;
    setTestStatus('testing');
    try {
      // បង្កើតការភ្ជាប់បណ្តោះអាសន្នទៅកាន់ Server ដើម្បីតេស្ត Key
      const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const testWs = new WebSocket(`${wsProtocol}//${location.host}/live?source=km&target=en&apiKey=${encodeURIComponent(apiKey.trim())}`);
      
      testWs.onopen = () => {
        setTestStatus('success');
        setTimeout(() => testWs.close(), 1000);
      };

      testWs.onerror = () => {
        setTestStatus('failed');
      };
    } catch (err) {
      setTestStatus('failed');
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
    // ពិនិត្យមើលតម្លៃ apiKey ក្នុង State ជំនួសវិញដើម្បីភាពរហ័ស
    if (!apiKey.trim()) {
      setIsSettingsOpen(true);
      alert("សូមកំណត់ និងរក្សាទុក Gemini API Key របស់អ្នកជាមុនសិន!");
      return;
    }

    try {
      let stream: MediaStream;
      let audioStream: MediaStream;

      if (mode === 'screen') {
        // បន្ថែមការការពារ៖ ពិនិត្យមើលថាតើអ្នកប្រើកំពុងបើកលើទូរស័ព្ទដៃ (Mobile) ឬអត់
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
      
      // បញ្ជូន API Key ចេញពី State ដោយផ្ទាល់ ជាមួយការការពារសុវត្ថិភាព String
      const ws = new WebSocket(
        `${wsProtocol}//${location.host}/live?source=${activeSource}&target=${activeTarget}&apiKey=${encodeURIComponent(apiKey.trim() || "")}`
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

      ws.onopen = () => setConnected(true);
      ws.onclose = () => setConnected(false);
    } catch (err) {
      console.error("Error starting translation", err);
      setConnected(false);
    }
  };

  const changeLanguages = (newSource: string, newTarget: string) => {
    setSourceLang(newSource);
    setTargetLang(newTarget);
    if (connected) {
      stopTranslation();
      setTimeout(() => {
        startTranslation(newSource, newTarget, captureMode);
      }, 300);
    }
  };

  const handleCaptureModeChange = (mode: 'mic' | 'screen') => {
    // ពិនិត្យឧបករណ៍ជាមុនសិន មុននឹងប្តូរ State ទៅជា Screen លើ Mobile
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

  return (
    <div className="w-full h-screen bg-[#0F1115] text-[#FFFFFF] font-['Inter','Noto_Sans_Khmer',sans-serif] flex flex-col overflow-hidden relative antialiased">
      
      {/* INJECT CUSTOM CSS ANIMATIONS FOR THE PREMIUM AI ORB */}
      <style>{`
        @keyframes orb-breathe {
          0%, 100% { transform: scale(1); box-shadow: 0 0 25px rgba(79, 124, 255, 0.4); }
          50% { transform: scale(1.03); box-shadow: 0 0 45px rgba(79, 124, 255, 0.7); }
        }
        @keyframes orb-float {
          0%, 100% { transform: translateY(0px); }
          50% { transform: translateY(-6px); }
        }
        @keyframes robot-blink {
          0%, 90%, 100% { transform: scaleY(1); }
          95% { transform: scaleY(0.1); }
        }
        @keyframes sound-wave-bar {
          0%, 100% { height: 6px; }
          50% { height: 20px; }
        }
        .animate-orb-breathe { animation: orb-breathe 4s ease-in-out infinite; }
        .animate-orb-float { animation: orb-float 3s ease-in-out infinite; }
        .animate-robot-blink { animation: robot-blink 1.5s ease-in-out infinite; }
        .animate-wave-1 { animation: sound-wave-bar 0.6s ease-in-out infinite alternate; }
        .animate-wave-2 { animation: sound-wave-bar 0.4s ease-in-out infinite alternate 0.1s; }
        .animate-wave-3 { animation: sound-wave-bar 0.7s ease-in-out infinite alternate 0.2s; }
        .animate-wave-4 { animation: sound-wave-bar 0.5s ease-in-out infinite alternate 0.15s; }
        .animate-wave-5 { animation: sound-wave-bar 0.6s ease-in-out infinite alternate 0.3s; }
      `}</style>

      {/* HEADER */}
      <header className="h-14 border-b border-white/5 px-6 flex items-center justify-between bg-[#171A21]/40 backdrop-blur-xl z-10">
        <div className="flex items-center space-x-3">
          <div className="w-8 h-8 bg-[#4F7CFF] rounded-lg flex items-center justify-center border border-white/10 shadow-sm">
            <span className="text-white font-bold text-sm">ខ</span>
          </div>
          <div>
            <h1 className="text-sm font-semibold tracking-tight text-white">Live-Translate</h1>
            <p className="text-[8px] uppercase tracking-[0.2em] text-[#A1A1AA]">2-Way Interpreter</p>
          </div>
        </div>

        {/* Mode Controls & Settings Button */}
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

          {/* ⚙️ ប៊ូតុង Settings សម្រាប់បើកប្រអប់ API Key */}
          <button
            onClick={() => setIsSettingsOpen(true)}
            className="p-2 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-white transition-all"
            title="API Settings"
          >
            <Settings size={14} />
          </button>
        </div>
      </header>

      {/* MAIN LAYOUT */}
      <main className="flex-1 max-w-md w-full mx-auto flex flex-col p-5 overflow-hidden relative">
        
        {/* LANGUAGE SELECTOR */}
        <div className="w-full flex items-center justify-center space-x-2 bg-white/5 border border-white/10 backdrop-blur-xl rounded-full p-1 shadow-sm">
          <div className="flex-1 relative flex justify-center">
            <span className="text-xs font-semibold px-4 py-1.5 text-white capitalize">
              {sourceLang === 'km' ? 'Khmer' : sourceLang === 'en' ? 'English' : sourceLang === 'zh' ? 'Chinese' : sourceLang === 'vi' ? 'Vietnamese' : sourceLang === 'ja' ? 'Japanese' : sourceLang === 'ko' ? 'Korean' : sourceLang === 'th' ? 'Thai' : sourceLang}
            </span>
            <select
              className="absolute inset-0 opacity-0 w-full cursor-pointer bg-[#171A21] text-white"
              value={sourceLang}
              onChange={(e) => changeLanguages(e.target.value, targetLang)}
            >
              <option value="km" className="bg-[#171A21] text-white">Khmer</option>
              <option value="en" className="bg-[#171A21] text-white">English</option>
              <option value="zh" className="bg-[#171A21] text-white">Chinese</option>
              <option value="vi" className="bg-[#171A21] text-white">Vietnamese</option>
              <option value="ja" className="bg-[#171A21] text-white">Japanese</option>
              <option value="ko" className="bg-[#171A21] text-white">Korean</option>
              <option value="th" className="bg-[#171A21] text-white">Thai</option>
            </select>
          </div>
          
          <div className="text-[#A1A1AA] p-1 bg-[#171A21] rounded-full border border-white/5">
            <ArrowLeftRight size={12} />
          </div>

          <div className="flex-1 relative flex justify-center">
            <span className="text-xs font-semibold px-4 py-1.5 text-white capitalize">
              {targetLang === 'en' ? 'English' : targetLang === 'km' ? 'Khmer' : targetLang === 'zh' ? 'Chinese' : targetLang === 'vi' ? 'Vietnamese' : targetLang === 'ja' ? 'Japanese' : targetLang === 'ko' ? 'Korean' : targetLang === 'th' ? 'Thai' : targetLang}
            </span>
            <select
              className="absolute inset-0 opacity-0 w-full cursor-pointer bg-[#171A21] text-white"
              value={targetLang}
              onChange={(e) => changeLanguages(sourceLang, e.target.value)}
            >
              <option value="km" className="bg-[#171A21] text-white">Khmer</option>
              <option value="en" className="bg-[#171A21] text-white">English</option>
              <option value="zh" className="bg-[#171A21] text-white">Chinese</option>
              <option value="vi" className="bg-[#171A21] text-white">Vietnamese</option>
              <option value="ja" className="bg-[#171A21] text-white">Japanese</option>
              <option value="ko" className="bg-[#171A21] text-white">Korean</option>
              <option value="th" className="bg-[#171A21] text-white">Thai</option>
            </select>
          </div>
        </div>

        {/* LIVE STATUS INDICATOR */}
        <div className="my-2 flex justify-center">
          <div className="inline-flex items-center space-x-1.5 bg-[#171A21] border border-white/5 px-3 py-1 rounded-full">
            <Activity size={10} className={connected ? "text-emerald-400 animate-pulse" : "text-[#A1A1AA]"} />
            <span className="text-[10px] font-medium tracking-wide text-[#A1A1AA]">
              {connected ? "System Active" : "System Paused"}
            </span>
          </div>
        </div>

        {/* CONVERSATION BUBBLES CONTAINER */}
        <div className="flex-1 w-full my-4 overflow-y-auto pb-8 space-y-4 pr-1 scrollbar-none flex flex-col justify-end">
          {transcript.length === 0 ? (
            <div className="h-full flex items-center justify-center text-center p-6">
              <p className="text-xs text-[#A1A1AA] max-w-[240px] leading-relaxed">
                រាល់ឃ្លាដែលបាននិយាយ និងបកប្រែរួច នឹងបង្ហាញជាទម្រង់ប្រអប់សារសន្ទនានៅទីនេះ។
              </p>
            </div>
          ) : (
            transcript.map((item, i) => (
              <div key={i} className="space-y-2 animate-fadeIn max-w-[85%] last:mb-2">
                <div className="bg-[#171A21] border border-white/10 rounded-2xl p-3.5 shadow-sm space-y-1">
                  <span className="text-[9px] uppercase tracking-wider text-[#A1A1AA] font-bold block">
                    {sourceLang === 'km' ? 'Original' : 'Source'}
                  </span>
                  <p className="text-xs text-[#A1A1AA] italic">{item.original || "..."}</p>
                  <div className="border-t border-white/5 my-1.5"></div>
                  <span className="text-[9px] uppercase tracking-wider text-[#4F7CFF] font-bold block">
                    Translated
                  </span>
                  <p className="text-sm text-white font-medium leading-relaxed">{item.translated}</p>
                </div>
              </div>
            ))
          )}
        </div>

        {/* REDESIGNED PREMIUM AI ORB CONTROL BUTTONS */}
        <div className="w-full flex justify-center z-10 pt-2 pb-10 items-center min-h-[220px]">
          {connected ? (
            <div className="relative flex items-center justify-center animate-orb-float">
              {/* Continuous Outer Pulse Ring */}
              <div className="absolute inset-0 rounded-full bg-red-500/20 animate-ping" style={{ animationDuration: '2s' }} />
              
              {/* Sound Wave Animation Elements */}
              <div className="absolute -left-12 flex items-center gap-1 h-8">
                <div className="w-1 bg-red-400 rounded-full animate-wave-1" />
                <div className="w-1 bg-red-500 rounded-full animate-wave-2" />
                <div className="w-1 bg-red-400 rounded-full animate-wave-3" />
              </div>
              <div className="absolute -right-12 flex items-center gap-1 h-8">
                <div className="w-1 bg-red-400 rounded-full animate-wave-3" />
                <div className="w-1 bg-red-500 rounded-full animate-wave-4" />
                <div className="w-1 bg-red-400 rounded-full animate-wave-5" />
              </div>

              {/* Stop State Premium AI Orb */}
              <button 
                onClick={stopTranslation}
                className="
                  w-[140px] h-[140px] md:w-[180px] md:h-[180px]
                  rounded-full
                  bg-gradient-to-br from-red-500 via-red-600 to-rose-800
                  text-white
                  shadow-[0_0_35px_rgba(239,68,68,0.6)]
                  border-2 border-red-400/30
                  transition-all duration-300
                  hover:scale-105 active:scale-95
                  flex flex-col items-center justify-center p-4 select-none
                "
              >
                {/* Robot Eyes with Blinking System */}
                <div className="flex gap-4 mb-2 justify-center items-center h-4">
                  <div className="w-3 h-3 md:w-4 md:h-4 bg-white rounded-full shadow-[0_0_10px_#fff] animate-robot-blink" />
                  <div className="w-3 h-3 md:w-4 md:h-4 bg-white rounded-full shadow-[0_0_10px_#fff] animate-robot-blink" />
                </div>

                <span className="text-[11px] md:text-xs uppercase tracking-[0.2em] font-light text-red-100 opacity-90">Stop</span>
                <span className="text-sm md:text-base font-extrabold tracking-wide drop-shadow-md">Translator</span>
              </button>
            </div>
          ) : (
            /* Idle State Premium AI Orb */
            <button 
              onClick={() => startTranslation(sourceLang, targetLang, captureMode)}
              className="
                w-[140px] h-[140px] md:w-[180px] md:h-[180px]
                rounded-full
                bg-gradient-to-br from-[#4F7CFF] via-[#2E5BFF] to-[#1A3BB5]
                text-white
                border-2 border-blue-400/20
                transition-all duration-300
                hover:scale-105 active:scale-95
                flex flex-col items-center justify-center p-4 select-none
                animate-orb-breathe
              "
            >
              <Languages size={26} className="mb-2 text-blue-100 drop-shadow-[0_0_6px_rgba(255,255,255,0.6)] md:w-8 md:h-8" />
              
              {/* Normal Standing Robot Eyes */}
              <div className="flex gap-3 mb-2 justify-center items-center">
                <div className="w-2.5 h-2.5 bg-cyan-300 rounded-full shadow-[0_0_8px_#22d3ee]" />
                <div className="w-2.5 h-2.5 bg-cyan-300 rounded-full shadow-[0_0_8px_#22d3ee]" />
              </div>

              <span className="text-[11px] md:text-xs uppercase tracking-[0.2em] font-light text-blue-100 opacity-90">Live</span>
              <span className="text-sm md:text-base font-extrabold tracking-wide drop-shadow-md">Translator</span>
            </button>
          )}
        </div>
      </main>

      {/* FLOATING SUBTITLE OVERLAY */}
      {liveSubtitle && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-2xl bg-black/70 border border-white/10 backdrop-blur-xl text-white text-base font-semibold text-center max-w-[85%] shadow-2xl pointer-events-none animate-fadeIn">
          {liveSubtitle}
        </div>
      )}

      {/* PREMIUM SETTINGS MODAL (API KEY MANAGEMENT) */}
      {isSettingsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-md animate-fadeIn p-4">
          <div className="bg-[#171A21] w-full max-w-sm rounded-3xl border border-white/10 shadow-2xl overflow-hidden flex flex-col">
            
            {/* Modal Header */}
            <div className="p-5 border-b border-white/5 flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <Settings size={16} className="text-[#4F7CFF]" />
                <h2 className="text-sm font-semibold text-white">Configuration</h2>
              </div>
              <button 
                onClick={() => { setIsSettingsOpen(false); setTestStatus('idle'); }}
                className="text-[#A1A1AA] hover:text-white text-xs bg-white/5 px-2.5 py-1 rounded-md border border-white/5"
              >
                Close
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-5 space-y-4">
              <div className="space-y-1.5">
                <label className="text-[10px] uppercase tracking-wider text-[#A1A1AA] font-bold">Gemini API Key</label>
                
                {/* Input Wrapper */}
                <div className="relative flex items-center">
                  <input
                    type={showKey ? "text" : "password"}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="AIzaSy..."
                    className="w-full bg-black/30 border border-white/10 rounded-xl h-11 pl-3 pr-10 text-xs text-white placeholder-white/20 focus:outline-none focus:border-[#4F7CFF] transition-all font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey(!showKey)}
                    className="absolute right-3 text-[#A1A1AA] hover:text-white transition-colors"
                  >
                    {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </div>

              {/* Status Test Connection */}
              {testStatus !== 'idle' && (
                <div className={`p-3 rounded-xl border text-xs flex items-center space-x-2 ${
                  testStatus === 'testing' ? 'bg-yellow-500/5 border-yellow-500/20 text-yellow-400' :
                  testStatus === 'success' ? 'bg-emerald-500/5 border-emerald-500/20 text-emerald-400' :
                  'bg-red-500/5 border-red-500/20 text-red-400'
                }`}>
                  {testStatus === 'testing' && <div className="w-3 h-3 border-2 border-t-transparent border-yellow-400 rounded-full animate-spin"></div>}
                  {testStatus === 'success' && <CheckCircle size={14} />}
                  {testStatus === 'failed' && <XCircle size={14} />}
                  <span>
                    {testStatus === 'testing' && 'កំពុងសាកល្បងភ្ជាប់ទៅកាន់ Gemini...'}
                    {testStatus === 'success' && 'ការភ្ជាប់ជោគជ័យ! API Key ត្រឹមត្រូវ។'}
                    {testStatus === 'failed' && 'ការភ្ជាប់បរាជ័យ! សូមពិនិត្យ Key ម្តងទៀត។'}
                  </span>
                </div>
              )}

              {/* Action Buttons */}
              <div className="grid grid-cols-2 gap-2 pt-2">
                <button
                  onClick={handleSaveKey}
                  disabled={!apiKey.trim()}
                  className="h-10 rounded-xl bg-[#4F7CFF] hover:bg-[#3B66F0] text-white font-semibold text-xs transition-all disabled:opacity-40"
                >
                  Save Key
                </button>
                <button
                  onClick={handleTestConnection}
                  disabled={!apiKey.trim() || testStatus === 'testing'}
                  className="h-10 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-white font-semibold text-xs transition-all disabled:opacity-40"
                >
                  Test Connection
                </button>
              </div>

              {localStorage.getItem('gemini_live_api_key') && (
                <button
                  onClick={handleRemoveKey}
                  className="w-full h-10 rounded-xl bg-red-600/10 hover:bg-red-600/20 border border-red-500/20 text-red-400 font-semibold text-xs transition-all flex items-center justify-center space-x-1.5"
                >
                  <Trash2 size={12} />
                  <span>Remove Key from Browser</span>
                </button>
              )}
            </div>

          </div>
        </div>
      )}

    </div>
  );
}