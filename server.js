// Traduttore simultaneo bidirezionale con voce clonata.
// Pipeline per ogni frase: audio -> trascrizione (ElevenLabs Scribe)
//   -> riconoscimento di chi parla (lingua rilevata) -> traduzione (Claude)
//   -> sintesi vocale con la voce clonata di chi ha parlato (ElevenLabs TTS, streaming).
import express from "express";
import multer from "multer";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ELEVEN_KEY, TTS_MODEL, CLAUDE_MODEL, FALLBACK_VOICE, Anthropic,
  eleven, transcribe, translate, synthesize, isBlank,
} from "./lib.js";
import { attachCalls, callRoutes } from "./call.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(here, "public")));

function audioBlob(file) {
  return new Blob([file.buffer], { type: file.mimetype || "audio/wav" });
}

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
    const r = await synthesize({ text: job.text, voiceId: job.voiceId, lang: job.lang });
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
    const stt = await transcribe(req.file.buffer, {
      mimetype: req.file.mimetype,
      filename: req.file.originalname || "segmento.wav",
      language: forcedSpeaker ? (forcedSpeaker === "a" ? a.lang : b.lang) : undefined,
    });
    const text = stt.text;
    if (isBlank(text)) return res.json({ empty: true });

    // 2) Chi sta parlando? Dalla lingua rilevata (o dal pulsante premuto).
    const detected = stt.language;
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
// Le chiamate telefoniche usano WebSocket: servono un server sempre acceso (non Vercel).
callRoutes(app);
if (!process.env.VERCEL) {
  const server = app.listen(PORT, () => console.log(`Traduttore attivo su http://localhost:${PORT}`));
  attachCalls(server);
}
export default app;
