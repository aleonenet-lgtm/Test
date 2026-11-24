// Funzioni condivise: trascrizione, traduzione e sintesi vocale.
import "dotenv/config";
import crypto from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";

export const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVEN_BASE = process.env.ELEVENLABS_BASE_URL || "https://api.elevenlabs.io";
export const STT_MODEL = process.env.ELEVENLABS_STT_MODEL || "scribe_v1";
export const TTS_MODEL = process.env.ELEVENLABS_TTS_MODEL || "eleven_flash_v2_5";
export const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
// Voce di riserva usata finché un interlocutore non ha clonato la propria voce.
export const FALLBACK_VOICE = process.env.ELEVENLABS_FALLBACK_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb";

if (!ELEVEN_KEY) console.warn("⚠️  ELEVENLABS_API_KEY mancante: trascrizione e voce non funzioneranno.");

export const anthropic = new Anthropic();
export { Anthropic };

// ---------- ElevenLabs ----------

export async function eleven(pathname, init = {}) {
  const res = await fetch(ELEVEN_BASE + pathname, {
    ...init,
    headers: { "xi-api-key": ELEVEN_KEY, ...(init.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`ElevenLabs ${res.status}: ${body.slice(0, 500)}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

// ISO 639-3 (restituito da Scribe) -> ISO 639-1 usato dall'interfaccia.
const ISO3_TO_1 = {
  ita: "it", eng: "en", spa: "es", fra: "fr", deu: "de", por: "pt", nld: "nl", pol: "pl",
  ron: "ro", rus: "ru", ukr: "uk", ara: "ar", cmn: "zh", zho: "zh", yue: "zh", jpn: "ja",
  kor: "ko", hin: "hi", tur: "tr", ell: "el", swe: "sv", dan: "da", nor: "no", nob: "no",
  fin: "fi", ces: "cs", hun: "hu", bul: "bg", hrv: "hr", srp: "sr", slk: "sk", slv: "sl",
  heb: "he", ind: "id", msa: "ms", vie: "vi", tha: "th", fil: "fil", tgl: "fil", alb: "sq",
  sqi: "sq", ben: "bn", urd: "ur", fas: "fa", tam: "ta",
};
export const normLang = (code) => {
  if (!code) return null;
  const c = code.toLowerCase().split(/[-_]/)[0];
  return ISO3_TO_1[c] || c;
};

// Se ElevenLabs rifiuta il codice lingua (lingua non supportata da quel modello),
// si riprova senza: il modello la riconosce da solo.
const isLanguageRejected = (e) => e.status === 400 || e.status === 422;

/** Trascrive un file audio. Restituisce { text, language }. */
export async function transcribe(buffer, { mimetype = "audio/wav", filename = "audio.wav", language } = {}) {
  const run = async (lang) => {
    const form = new FormData();
    form.append("model_id", STT_MODEL);
    form.append("file", new Blob([buffer], { type: mimetype }), filename);
    form.append("tag_audio_events", "false");
    if (lang) form.append("language_code", lang);
    return (await eleven("/v1/speech-to-text", { method: "POST", body: form })).json();
  };
  let stt;
  try {
    stt = await run(language);
  } catch (e) {
    if (!language || !isLanguageRejected(e)) throw e;
    stt = await run(undefined);
  }
  return { text: (stt.text || "").trim(), language: normLang(stt.language_code) };
}

/** Testo vuoto o solo punteggiatura/rumore. */
export const isBlank = (text) => !text || text.replace(/[\p{P}\s]/gu, "").length < 2;

/**
 * Sintesi vocale in streaming. format: "mp3_44100_128" per il browser,
 * "ulaw_8000" per la linea telefonica. Restituisce la Response (body in streaming).
 */
export async function synthesize({ text, voiceId, lang, format = "mp3_44100_128" }) {
  const run = (withLang) => {
    const body = {
      text,
      model_id: TTS_MODEL,
      voice_settings: { stability: 0.5, similarity_boost: 0.9, style: 0, use_speaker_boost: true },
    };
    if (withLang) body.language_code = lang;
    return eleven(
      `/v1/text-to-speech/${encodeURIComponent(voiceId || FALLBACK_VOICE)}/stream?output_format=${format}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    );
  };
  // I modelli v2.5/v3 accettano il codice lingua per forzare la pronuncia corretta.
  const withLang = Boolean(lang) && /v2_5|v3/.test(TTS_MODEL);
  try {
    return await run(withLang);
  } catch (e) {
    if (!withLang || !isLanguageRejected(e)) throw e;
    return run(false);
  }
}

// ---------- Codice di accesso ----------
// Protegge tutte le funzioni a pagamento (trascrizione, traduzione, voce, chiamate).
export const ACCESS_CODE = process.env.APP_ACCESS_CODE || process.env.CALL_ACCESS_CODE || "";
export function checkAccessCode(given) {
  if (!ACCESS_CODE) return true; // nessun codice configurato: uso locale
  const a = crypto.createHash("sha256").update(String(given ?? "")).digest();
  const b = crypto.createHash("sha256").update(ACCESS_CODE).digest();
  return crypto.timingSafeEqual(a, b);
}
if (!ACCESS_CODE) {
  console.warn("⚠️  APP_ACCESS_CODE non impostato: chiunque raggiunga il server può usarlo. Impostalo prima di pubblicarlo online.");
}

// Prefisso dei nomi delle voci create dall'app: solo queste possono essere eliminate dall'app.
export const VOICE_PREFIX = "traduttore-";

// ---------- Traduzione (Claude) ----------

const LANG_NAMES = {
  it: "Italian", en: "English", es: "Spanish", fr: "French", de: "German", pt: "Portuguese",
  nl: "Dutch", pl: "Polish", ro: "Romanian", ru: "Russian", uk: "Ukrainian", ar: "Arabic",
  zh: "Chinese (Mandarin)", ja: "Japanese", ko: "Korean", hi: "Hindi", tr: "Turkish",
  el: "Greek", sv: "Swedish", cs: "Czech", hu: "Hungarian", he: "Hebrew", id: "Indonesian",
  vi: "Vietnamese", th: "Thai", fil: "Filipino", sq: "Albanian", bn: "Bengali",
};
export const langName = (c) => LANG_NAMES[c] || c;

const SYSTEM_PROMPT = `You are a professional simultaneous interpreter working live between two people who speak different languages, in person or on a phone call.
You receive one spoken utterance at a time, transcribed by speech recognition, plus the recent conversation for context.
Translate the utterance into the requested target language so it can be read aloud by a text-to-speech voice.

- Output only the translation: no quotes, notes, labels or explanations.
- Keep the speaker's register, tone and intent; render it as natural spoken language, in the first person, as the speaker would say it.
- Fix obvious speech-recognition errors using the context, but never add content the speaker did not say.
- Keep names, numbers and units accurate; write numbers the way a native speaker would read them.
- If the utterance is only a filler or noise (e.g. "uhm", a cough), output nothing.`;

export async function translate({ text, from, to, history }) {
  const context = (history || [])
    .slice(-8)
    .map((h) => `${h.speaker}: ${h.original}`)
    .join("\n");
  const user = [
    context ? `<recent_conversation>\n${context}\n</recent_conversation>\n` : "",
    `Translate from ${langName(from)} to ${langName(to)}:\n<utterance>\n${text}\n</utterance>`,
  ].join("");

  const response = await anthropic.beta.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 4000,
    // Bassa latenza: la traduzione di una frase non richiede ragionamento profondo.
    output_config: { effort: "low" },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: user }],
  });
  if (response.stop_reason === "refusal") {
    throw new Error("La traduzione è stata rifiutata dal modello.");
  }
  return response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}
