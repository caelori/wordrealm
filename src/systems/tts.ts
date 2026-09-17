/** 浏览器原生 TTS —— 免费、离线、免密钥。
 *  ECDICT 的音标字段混用了西里尔 ә(U+04D9) 和旧式 "i:" 写法，不可靠，
 *  所以发音一律走 TTS，不显示音标。 */

let voices: SpeechSynthesisVoice[] = [];

function refreshVoices() {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  voices = window.speechSynthesis.getVoices();
}

if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
  refreshVoices();
  // Chrome 里 voices 是异步加载的，必须监听这个事件
  window.speechSynthesis.addEventListener('voiceschanged', refreshVoices);
}

export const ttsSupported =
  typeof window !== 'undefined' && 'speechSynthesis' in window;

function pickVoice(accent: string): SpeechSynthesisVoice | undefined {
  if (voices.length === 0) refreshVoices();
  const want = accent.startsWith('en-GB') ? 'en-GB' : 'en-US';
  return (
    voices.find(v => v.lang === want) ??
    voices.find(v => v.lang?.startsWith('en')) ??
    undefined
  );
}

export function speak(text: string, opts: { accent?: string; rate?: number } = {}) {
  if (!ttsSupported) return;
  const { accent = 'en-US', rate = 1 } = opts;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = accent;
  u.rate = Math.min(2, Math.max(0.5, rate));
  const v = pickVoice(accent);
  if (v) u.voice = v;
  window.speechSynthesis.speak(u);
}

export function stopSpeaking() {
  if (ttsSupported) window.speechSynthesis.cancel();
}

export function listEnglishVoices(): SpeechSynthesisVoice[] {
  if (voices.length === 0) refreshVoices();
  return voices.filter(v => v.lang?.toLowerCase().startsWith('en'));
}
