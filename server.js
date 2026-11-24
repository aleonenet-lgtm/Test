// Traduttore simultaneo bidirezionale con voce clonata.
// Pipeline per ogni frase: audio -> trascrizione (ElevenLabs Scribe)
//   -> riconoscimento di chi parla (lingua rilevata) -> traduzione (Claude)
//   -> sintesi vocale con la voce clonata di chi ha parlato (ElevenLabs TTS, streaming).
import "dotenv/config";
import express from "express";
import multer from "multer";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVEN_BASE = process.env.ELEVENLABS_BASE_URL || "https://api.elevenlabs.io";
const STT_MODEL = process.env.ELEVENLABS_STT_MODEL || "scribe_v1";
const TTS_MODEL = process.env.ELEVENLABS_TTS_MODEL || "eleven_flash_v2_5";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
// Voce di riserva usata finché un interlocutore non ha clonato la propria voce.
const FALLBACK_VOICE = process.env.ELEVENLABS_FALLBACK_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb";

if (!ELEVEN_KEY) console.warn("⚠️  ELEVENLABS_API_KEY mancante: trascrizione e voce non funzioneranno.");

const anthropic = new Anthropic();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(here, "public")));

// ---------- Utility ElevenLabs ----------

async function eleven(pathname, init = {}) {
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

function audioBlob(file) {
  return new Blob([file.buffer], { type: file.mimetype || "audio/wav" });
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
const normLang = (code) => {
  if (!code) return null;
  const c = code.toLowerCase().split(/[-_]/)[0];
  return ISO3_TO_1[c] || c;
};

// ---------- Clonazione vocale ----------

app.post("/api/voices", upload.array("samples", 5), async (req, res) => {
  try {
    if (req.body.consent !== "true") {
      return res.status(400).json({ error: "Serve il consenso esplicito della persona per clonarne la voce." });
    }
    if (!req.files?.length) return res.status(400).json({ error: "Nessun campione audio ricevuto." });
    const form = new FormData();
    form.append("name", `traduttore-${(req.body.name || "voce").slice(0, 40)}-${Date.now()}`);
    form.append("description", "Voce temporanea per traduzione simultanea");
    form.append("remove_background_noise", "true");
    req.files.forEach((f, i) => form.append("files", audioBlob(f), f.originalname || `campione-${i}.wav`));
    const r = await eleven("/v1/voices/add", { method: "POST", body: form });
    const data = await r.json();
    res.json({ voiceId: data.voice_id });
  } catch (e) {
    console.error(e);
    res.status(e.status === 401 ? 401 : 502).json({ error: e.message });
  }
});

app.delete("/api/voices/:id", async (req, res) => {
  try {
    await eleven(`/v1/voices/${encodeURIComponent(req.params.id)}`, { method: "DELETE" });
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ---------- Traduzione ----------

const LANG_NAMES = {
  it: "Italian", en: "English", es: "Spanish", fr: "French", de: "German", pt: "Portuguese",
  nl: "Dutch", pl: "Polish", ro: "Romanian", ru: "Russian", uk: "Ukrainian", ar: "Arabic",
  zh: "Chinese (Mandarin)", ja: "Japanese", ko: "Korean", hi: "Hindi", tr: "Turkish",
  el: "Greek", sv: "Swedish", cs: "Czech", hu: "Hungarian", he: "Hebrew", id: "Indonesian",
  vi: "Vietnamese", th: "Thai", fil: "Filipino", sq: "Albanian", bn: "Bengali",
};
const langName = (c) => LANG_NAMES[c] || c;

const SYSTEM_PROMPT = `You are a professional simultaneous interpreter working live between two people who speak different languages.
You receive one spoken utterance at a time, transcribed by speech recognition, plus the recent conversation for context.
Translate the utterance into the requested target language so it can be read aloud by a text-to-speech voice.

- Output only the translation: no quotes, notes, labels or explanations.
- Keep the speaker's register, tone and intent; render it as natural spoken language, in the first person, as the speaker would say it.
- Fix obvious speech-recognition errors using the context, but never add content the speaker did not say.
- Keep names, numbers and units accurate; write numbers the way a native speaker would read them.
- If the utterance is only a filler or noise (e.g. "uhm", a cough), output nothing.`;

async function translate({ text, from, to, history }) {
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

// ---------- Sintesi vocale (cache di breve durata per lo streaming via GET) ----------

// Il link audio contiene un token firmato (testo, voce, lingua, scadenza): nessuno stato
// sul server, quindi funziona anche su hosting serverless con più istanze (es. Vercel).
const TOKEN_KEY = crypto
  .createHmac("sha256", process.env.TTS_SECRET || ELEVEN_KEY || "dev")
  .update("tts-token")
  .digest();
const sign = (data) => crypto.createHmac("sha256", TOKEN_KEY).update(data).digest("base64url");

function makeTtsToken(job) {
  const data = Buffer.from(JSON.stringify(job)).toString("base64url");
  return `${data}.${sign(data)}`;
}
function readTtsToken(token) {
  const [data, mac] = String(token).split(".");
  if (!data || !mac) return null;
  const expected = Buffer.from(sign(data));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  const job = JSON.parse(Buffer.from(data, "base64url").toString());
  return job.expires > Date.now() ? job : null;
}

// Cache locale dell'audio già generato, per "Riascolta" senza una nuova sintesi.
const audioCache = new Map();
function cacheAudio(key, buf) {
  audioCache.set(key, buf);
  if (audioCache.size > 50) audioCache.delete(audioCache.keys().next().value);
}

app.get("/api/tts/:token", async (req, res) => {
  const job = readTtsToken(req.params.token);
  if (!job) return res.status(404).end();
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Cache-Control", "no-store");
  // "Riascolta": l'audio già generato viene servito dalla cache senza una nuova sintesi.
  const cached = audioCache.get(req.params.token);
  if (cached) return res.end(cached);
  try {
    const body = {
      text: job.text,
      model_id: TTS_MODEL,
      voice_settings: { stability: 0.5, similarity_boost: 0.9, style: 0, use_speaker_boost: true },
    };
    // I modelli v2.5 accettano il codice lingua per forzare la pronuncia corretta.
    if (/v2_5|v3/.test(TTS_MODEL) && job.lang) body.language_code = job.lang;
    const r = await eleven(
      `/v1/text-to-speech/${encodeURIComponent(job.voiceId)}/stream?output_format=mp3_44100_128`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    );
    const reader = r.body.getReader();
    const parts = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const buf = Buffer.from(value);
      parts.push(buf);
      res.write(buf);
    }
    cacheAudio(req.params.token, Buffer.concat(parts));
    res.end();
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(502).json({ error: e.message });
    else res.end();
  }
});

// ---------- Turno di conversazione ----------
// Riceve un segmento audio, capisce chi parla, traduce e prepara l'audio.

app.post("/api/turn", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Audio mancante." });
    const cfg = JSON.parse(req.body.config || "{}");
    const { a, b, history = [], forcedSpeaker = null } = cfg; // a/b: { name, lang, voiceId }
    if (!a?.lang || !b?.lang) return res.status(400).json({ error: "Configura le lingue." });

    // 1) Trascrizione
    const form = new FormData();
    form.append("model_id", STT_MODEL);
    form.append("file", audioBlob(req.file), req.file.originalname || "segmento.wav");
    form.append("tag_audio_events", "false");
    if (forcedSpeaker) form.append("language_code", forcedSpeaker === "a" ? a.lang : b.lang);
    const stt = await (await eleven("/v1/speech-to-text", { method: "POST", body: form })).json();
    const text = (stt.text || "").trim();
    if (!text || text.replace(/[\p{P}\s]/gu, "").length < 2) return res.json({ empty: true });

    // 2) Chi sta parlando? Dalla lingua rilevata (o dal pulsante premuto).
    const detected = normLang(stt.language_code);
    let speaker = forcedSpeaker;
    if (!speaker) {
      if (detected === a.lang) speaker = "a";
      else if (detected === b.lang) speaker = "b";
      else speaker = cfg.lastSpeaker === "a" ? "b" : "a"; // lingua incerta: alterna
    }
    const src = speaker === "a" ? a : b;
    const dst = speaker === "a" ? b : a;

    // 3) Traduzione
    const translation = await translate({ text, from: src.lang, to: dst.lang, history });
    if (!translation) return res.json({ empty: true });

    // 4) Audio con la voce di chi ha parlato
    const token = makeTtsToken({
      text: translation,
      voiceId: src.voiceId || FALLBACK_VOICE,
      lang: dst.lang,
      expires: Date.now() + 30 * 60_000,
    });

    res.json({
      speaker,
      detectedLanguage: detected,
      original: text,
      translation,
      from: src.lang,
      to: dst.lang,
      audioUrl: `/api/tts/${token}`,
    });
  } catch (e) {
    console.error(e);
    const status = e instanceof Anthropic.AuthenticationError || e.status === 401 ? 401 : 502;
    res.status(status).json({ error: e.message });
  }
});

app.get("/api/health", (_req, res) =>
  res.json({ ok: true, elevenlabs: Boolean(ELEVEN_KEY), claudeModel: CLAUDE_MODEL, ttsModel: TTS_MODEL }),
);

// Su Vercel l'app viene esportata e avviata dalla piattaforma; in locale ascolta sulla porta.
if (!process.env.VERCEL) {
  app.listen(PORT, () => console.log(`Traduttore attivo su http://localhost:${PORT}`));
}
export default app;
