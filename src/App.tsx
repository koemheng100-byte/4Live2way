/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { useEffect, useRef, useState } from 'react';
// បន្ថែម Premium Icons សម្រាប់មុខងារ Settings និង Key Visibility
import { Mic, Monitor, Languages, ArrowLeftRight, Settings, Eye, EyeOff, Trash2, CheckCircle, XCircle } from 'lucide-react';

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

  // --- បន្ថែម State សម្រាប់ចំណាំពេលអ្នកប្រើកំពុងចុច Focus លើ Select ភាសា ---
  const [focusedSelect, setFocusedSelect] = useState<'source' | 'target' | null>(null);

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
    if (!apiKey.trim()) {
      setIsSettingsOpen(true);
      alert("សូមកំណត់ និងរក្សាទុក Gemini API Key របស់អ្នកជាមុនសិន!");
      return;
    }

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
      ko: 'កូរ៉េ (Korean)',
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
      
      {/* CSS For Premium Animations and Neon Effects */}
      <style>{`
        @keyframes breathe {
          0%, 100% { transform: scale(1); box-shadow: 0 0 25px rgba(30, 80, 255, 0.4), inset 0 0 15px rgba(255,255,255,0.1); }
          50% { transform: scale(1.03); box-shadow: 0 0 45px rgba(30, 80, 255, 0.8), inset 0 0 25px rgba(30, 80, 255, 0.3); }
        }
        @keyframes blink {
          0%, 90%, 100% { transform: scaleY(1); }
          95% { transform: scaleY(0.1); }
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
      <main className="flex-1 max-w-md w-full mx-auto flex flex-col p-5 overflow-hidden relative justify-start">
        
        {/* LANGUAGE SELECTOR */}
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
                e.target.blur(); // ដក focus ចេញក្រោយពេលជ្រើសរើសរួច
              }}
            >
              <option value="km" className="bg-[#171A21] text-white">ខ្មែរ (Khmer)</option>
              <option value="en" className="bg-[#171A21] text-white">អង់គ្លេស (English)</option>
              <option value="zh" className="bg-[#171A21] text-white">ចិន (Chinese)</option>
              <option value="zh-HK" className="bg-[#171A21] text-white">ចិនកាតាំង (Cantonese)</option>
              <option value="vi" className="bg-[#171A21] text-white">វៀតណាម (Vietnamese)</option>
              <option value="ja" className="bg-[#171A21] text-white">ជប៉ុន (Japanese)</option>
              <option value="ko" className="bg-[#171A21] text-white">កូរ៉េ (Korean)</option>
              <option value="th" className="bg-[#171A21] text-white">ថៃ (Thai)</option>
              <option value="id" className="bg-[#171A21] text-white">ឥណ្ឌូនេស៊ី (Indonesian)</option>
              <option value="ms" className="bg-[#171A21] text-white">ម៉ាឡេស៊ី (Malay)</option>
              <option value="lo" className="bg-[#171A21] text-white">ឡាវ (Lao)</option>
              <option value="fr" className="bg-[#171A21] text-white">បារាំង (French)</option>
              <option value="de" className="bg-[#171A21] text-white">អាល្លឺម៉ង់ (German)</option>
              <option value="no" className="bg-[#171A21] text-white">ន័រវែស (Norwegian)</option>
              <option value="hi" className="bg-[#171A21] text-white">ឥណ្ឌា (Hindi)</option>
              <option value="fil" className="bg-[#171A21] text-white">ហ្វីលីពិន (Filipino)</option>
              <option value="mn" className="bg-[#171A21] text-white">ម៉ុងហ្គោលី (Mongolian)</option>
              <option value="it" className="bg-[#171A21] text-white">អ៊ីតាលី (Italian)</option>
              <option value="he" className="bg-[#171A21] text-white">អ៊ីស្រាអែល (Hebrew)</option>
              <option value="ru" className="bg-[#171A21] text-white">រុស្ស៊ី (Russian)</option>
              <option value="my" className="bg-[#171A21] text-white">ភូមា (Burmese)</option>
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
                e.target.blur(); // ដក focus ចេញក្រោយពេលជ្រើសរើសរួច
              }}
            >
              <option value="km" className="bg-[#171A21] text-white">ខ្មែរ (Khmer)</option>
              <option value="en" className="bg-[#171A21] text-white">អង់គ្លេស (English)</option>
              <option value="zh" className="bg-[#171A21] text-white">ចិន (Chinese)</option>
              <option value="zh-HK" className="bg-[#171A21] text-white">ចិនកាតាំង (Cantonese)</option>
              <option value="vi" className="bg-[#171A21] text-white">វៀតណាម (Vietnamese)</option>
              <option value="ja" className="bg-[#171A21] text-white">ជប៉ុន (Japanese)</option>
              <option value="ko" className="bg-[#171A21] text-white">កូរ៉េ (Korean)</option>
              <option value="th" className="bg-[#171A21] text-white">ថៃ (Thai)</option>
              <option value="id" className="bg-[#171A21] text-white">ឥណ្ឌូនេស៊ី (Indonesian)</option>
              <option value="ms" className="bg-[#171A21] text-white">ម៉ាឡេស៊ី (Malay)</option>
              <option value="lo" className="bg-[#171A21] text-white">ឡាវ (Lao)</option>
              <option value="fr" className="bg-[#171A21] text-white">បារាំង (French)</option>
              <option value="de" className="bg-[#171A21] text-white">អាល្លឺម៉ង់ (German)</option>
              <option value="no" className="bg-[#171A21] text-white">ន័រវែស (Norwegian)</option>
              <option value="hi" className="bg-[#171A21] text-white">ឥណ្ឌា (Hindi)</option>
              <option value="fil" className="bg-[#171A21] text-white">ហ្វីលីពិន (Filipino)</option>
              <option value="mn" className="bg-[#171A21] text-white">ម៉ុងហ្គោលី (Mongolian)</option>
              <option value="it" className="bg-[#171A21] text-white">អ៊ីតាលី (Italian)</option>
              <option value="he" className="bg-[#171A21] text-white">អ៊ីស្រាអែល (Hebrew)</option>
              <option value="ru" className="bg-[#171A21] text-white">រុស្ស៊ី (Russian)</option>
              <option value="my" className="bg-[#171A21] text-white">ភូមា (Burmese)</option>
            </select>
          </div>
        </div>

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

            <p className="text-[11px] text-center text-slate-400 max-w-[260px] leading-relaxed mt-3">
              {restarting
                ? "កំពុងអនុវត្តភាសាថ្មី..."
                : connected 
                ? "ប្រព័ន្ធកំពុងដំណើរការស្តាប់ និងបកប្រែដោយស្វ័យប្រវត្តិ"
                : "សូមចុចប៊ូតុង Live Translator ដើម្បីចាប់ផ្តើមបកប្រែ"
              }
            </p>
          </div>
        </div>

        {/* CONVERSATION BUBBLES CONTAINER */}
        <div className="flex-1 w-full my-1 overflow-y-auto max-h-[100px] space-y-2 pr-1 scrollbar-none flex flex-col justify-end">
          {transcript.slice(-2).map((item, i) => (
            <div key={i} className="space-y-1 animate-fadeIn max-w-[90%] mx-auto w-full">
              <div className="bg-[#111625] border border-white/5 rounded-xl p-2.5 shadow-sm text-center">
                <p className="text-xs text-[#4F7CFF] font-semibold">{item.translated}</p>
              </div>
            </div>
          ))}
        </div>

        {/* LOWER CENTER: LIVE TRANSLATOR PREMIUM CIRCULAR ORB */}
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
                onClick={stopTranslation}
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
                <Languages size={24} className="mb-1 text-red-100 md:w-7 md:h-7 drop-shadow-md" />
                <span className="text-[12px] md:text-sm font-light uppercase tracking-[0.18em] text-red-100/90 leading-tight">Stop</span>
                <span className="text-sm md:text-base font-extrabold tracking-wide drop-shadow-lg text-white">Translator</span>
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
                    startTranslation(sourceLang, targetLang, captureMode);
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
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-2xl bg-black/70 border border-white/10 backdrop-blur-xl text-white text-base font-semibold text-center max-w-[85%] shadow-2xl pointer-events-none animate-fadeIn">
          {liveSubtitle}
        </div>
      )}

      {/* PREMIUM SETTINGS MODAL */}
      {isSettingsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-md animate-fadeIn p-4">
          <div className="bg-[#171A21] w-full max-w-sm rounded-3xl border border-white/10 shadow-2xl overflow-hidden flex flex-col">
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

            <div className="p-5 space-y-4">
              <div className="space-y-1.5">
                <label className="text-[10px] uppercase tracking-wider text-[#A1A1AA] font-bold">Gemini API Key</label>
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