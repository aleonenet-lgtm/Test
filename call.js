// Chiamate telefoniche tradotte verso numeri normali, tramite Twilio.
//
//   iPhone (app web) ⇄ WebSocket /ws/call ⇄ questo server ⇄ Twilio Media Streams ⇄ rete telefonica
//
// - Tu parli: l'app invia ogni frase (WAV). Il server trascrive, traduce e la invia sulla
//   linea con la TUA voce clonata, nella lingua di chi risponde.
// - L'altra persona parla: il server riceve l'audio della linea (μ-law 8 kHz), riconosce
//   le frasi, le traduce nella tua lingua e te le manda come audio da ascoltare.
import crypto from "node:crypto";
import express from "express";
import { WebSocketServer } from "ws";
import { transcribe, translate, synthesize, isBlank, ACCESS_CODE, checkAccessCode } from "./lib.js";

const TW_SID = process.env.TWILIO_ACCOUNT_SID;
const TW_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TW_FROM = process.env.TWILIO_PHONE_NUMBER;
const TW_API = process.env.TWILIO_API_BASE || "https://api.twilio.com";
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const MAX_MINUTES = Number(process.env.CALL_MAX_MINUTES || 30);

const SUPPORTED = new Set(["it", "en", "es", "fr", "de", "pt", "nl", "pl", "ro", "ru", "uk", "ar", "zh", "ja", "ko",
  "hi", "tr", "el", "sv", "cs", "hu", "he", "id", "vi", "th", "fil", "sq", "bn"]);

// Le chiamate costano: senza codice di accesso configurato restano disattivate.
export const callsEnabled = () =>
  Boolean(TW_SID && TW_TOKEN && TW_FROM && PUBLIC_URL && ACCESS_CODE && !process.env.VERCEL);

const sessions = new Map(); // callId -> CallSession

// ---------- API Twilio (REST) ----------

async function twilio(pathname, params) {
  const res = await fetch(`${TW_API}/2010-04-01/Accounts/${TW_SID}${pathname}`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${TW_SID}:${TW_TOKEN}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${data.message || "errore"}`);
  return data;
}

// Verifica che una richiesta HTTP arrivi davvero da Twilio (firma X-Twilio-Signature).
function fromTwilio(req) {
  const sig = req.get("X-Twilio-Signature") || "";
  const data = Object.keys(req.body || {}).sort().reduce((s, k) => s + k + req.body[k], PUBLIC_URL + req.originalUrl);
  const expected = crypto.createHmac("sha1", TW_TOKEN).update(Buffer.from(data, "utf8")).digest("base64");
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

// Confronto a tempo costante dei codici segreti.
const sameSecret = (a, b) => {
  const x = crypto.createHash("sha256").update(String(a)).digest();
  const y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};

// ---------- Audio telefonico ----------

function ulawToPcm(u8) {
  const out = new Int16Array(u8.length);
  for (let i = 0; i < u8.length; i++) {
    const u = ~u8[i] & 0xff;
    let t = ((u & 0x0f) << 3) + 0x84;
    t <<= (u & 0x70) >> 4;
    out[i] = u & 0x80 ? 0x84 - t : t - 0x84;
  }
  return out;
}

function pcmToWav(pcm, rate) {
  const buf = Buffer.alloc(44 + pcm.length * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + pcm.length * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(pcm.length * 2, 40);
  Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).copy(buf, 44);
  return buf;
}

/** Rilevamento delle frasi sulla linea telefonica (blocchi da 20 ms a 8 kHz). */
function lineVad(onSegment) {
  const FRAME_MS = 20, PRE_ROLL = 15, END_SILENCE_MS = 700, MIN_SPEECH_MS = 300, MAX_MS = 12000;
  let floor = 0.004, inSpeech = false, seg = [], pre = [], speechMs = 0, silenceMs = 0, pending = new Int16Array(0);
  const frame = (f) => {
    let s = 0;
    for (let i = 0; i < f.length; i++) s += (f[i] / 32768) ** 2;
    const level = Math.sqrt(s / f.length);
    const thr = Math.max(0.015, floor * 3);
    if (!inSpeech) {
      floor = floor * 0.98 + Math.min(level, 0.05) * 0.02;
      pre.push(f);
      if (pre.length > PRE_ROLL) pre.shift();
      if (level > thr) { inSpeech = true; seg = [...pre]; pre = []; speechMs = 0; silenceMs = 0; }
      return;
    }
    seg.push(f);
    if (level > thr) { speechMs += FRAME_MS; silenceMs = 0; } else silenceMs += FRAME_MS;
    if (silenceMs >= END_SILENCE_MS || seg.length * FRAME_MS >= MAX_MS) {
      if (speechMs >= MIN_SPEECH_MS) {
        const out = new Int16Array(seg.reduce((n, x) => n + x.length, 0));
        let o = 0;
        for (const x of seg) { out.set(x, o); o += x.length; }
        onSegment(out);
      }
      inSpeech = false; seg = [];
    }
  };
  return (samples) => {
    const all = new Int16Array(pending.length + samples.length);
    all.set(pending); all.set(samples, pending.length);
    let i = 0;
    for (; i + 160 <= all.length; i += 160) frame(all.subarray(i, i + 160));
    pending = all.slice(i);
  };
}

/** Coda che elabora in parallelo ma consegna i risultati nell'ordine di arrivo. */
function orderedQueue(onError) {
  let chain = Promise.resolve();
  return (work, deliver) => {
    work.catch(() => {}); // l'errore viene gestito sotto, in ordine
    chain = chain.then(async () => {
      try {
        const result = await work;
        if (result) await deliver(result);
      } catch (e) {
        onError(e);
      }
    });
  };
}

// ---------- Sessione di chiamata ----------

class CallSession {
  constructor(client, { to, calleeLang, me }) {
    this.id = crypto.randomUUID();
    this.token = crypto.randomBytes(24).toString("hex");
    this.client = client;
    this.to = to;
    this.calleeLang = calleeLang;
    this.me = me; // { name, lang, voiceId }
    this.history = [];
    this.line = null; // WebSocket di Twilio
    this.streamSid = null;
    this.callSid = null;
    this.ended = false;
    this.isAnswered = false;
    // Si risolve quando l'altra persona risponde, oppure quando la chiamata finisce senza risposta
    // (così le frasi in coda non restano in attesa per sempre).
    this.answered = new Promise((resolve) => (this.onAnswered = resolve));
    const onError = (e) => { console.error(e); this.send({ type: "error", message: e.message }); };
    this.toLine = orderedQueue(onError); // le tue frasi, verso l'altra persona
    this.toMe = orderedQueue(onError); // le frasi dell'altra persona, verso di te
    sessions.set(this.id, this);
  }

  send(msg) {
    if (this.client.readyState === 1) this.client.send(JSON.stringify(msg));
  }

  async dial() {
    // Avviso iniziale: chi risponde deve sapere che sente una voce sintetica tradotta.
    this.say(this.announcementText(), "system");
    const wsUrl = PUBLIC_URL.replace(/^http/, "ws") + "/twilio/media";
    const twiml =
      `<Response><Connect><Stream url="${wsUrl}">` +
      `<Parameter name="callId" value="${this.id}"/><Parameter name="token" value="${this.token}"/>` +
      `</Stream></Connect></Response>`;
    const params = new URLSearchParams({
      To: this.to,
      From: TW_FROM,
      Twiml: twiml,
      TimeLimit: String(MAX_MINUTES * 60),
      StatusCallback: `${PUBLIC_URL}/twilio/status?callId=${this.id}`,
      StatusCallbackMethod: "POST",
    });
    for (const ev of ["initiated", "ringing", "answered", "completed"]) params.append("StatusCallbackEvent", ev);
    const call = await twilio("/Calls.json", params);
    this.callSid = call.sid;
    this.send({ type: "status", status: "initiated" });
  }

  announcementText() {
    const voice = this.me.voiceId
      ? `sentirà una voce sintetica che riproduce quella di ${this.me.name}`
      : `sentirà una voce sintetica che traduce ${this.me.name}`;
    return (
      `Buongiorno. Questa chiamata è tradotta in tempo reale da un sistema di intelligenza artificiale: ${voice}. ` +
      `Parli pure normalmente nella sua lingua, facendo brevi pause tra una frase e l'altra.`
    );
  }

  /** Testo italiano dell'app (avviso) -> lingua di chi risponde, poi sulla linea. */
  say(textIt, who) {
    const work = (async () => ({
      original: textIt,
      translation: this.calleeLang === "it" ? textIt : await translate({ text: textIt, from: "it", to: this.calleeLang }),
    }))();
    this.toLine(work, async (r) => {
      await this.answered;
      if (this.ended) return;
      this.send({ type: "line", who, ...r });
      await this.speakOnLine(r.translation);
    });
  }

  /** Una tua frase (WAV dal telefono). */
  fromMe(wav) {
    if (this.ended) return;
    const work = (async () => {
      const { text } = await transcribe(wav, { language: this.me.lang });
      if (isBlank(text)) return null;
      const translation = await translate({ text, from: this.me.lang, to: this.calleeLang, history: this.history });
      return translation ? { original: text, translation } : null;
    })();
    this.toLine(work, async (r) => {
      await this.answered;
      if (this.ended) return;
      this.history.push({ speaker: this.me.name, original: r.original });
      this.send({ type: "line", who: "me", ...r });
      await this.speakOnLine(r.translation);
    });
  }

  /** Una frase dell'altra persona (PCM 8 kHz dalla linea). */
  fromLine(pcm) {
    if (this.ended) return;
    const work = (async () => {
      const { text } = await transcribe(pcmToWav(pcm, 8000), { language: this.calleeLang });
      if (isBlank(text)) return null;
      const translation = await translate({ text, from: this.calleeLang, to: this.me.lang, history: this.history });
      if (!translation) return null;
      const audio = Buffer.from(await (await synthesize({ text: translation, lang: this.me.lang })).arrayBuffer());
      return { original: text, translation, audio };
    })();
    this.toMe(work, async (r) => {
      if (this.ended) return;
      this.history.push({ speaker: "Interlocutore", original: r.original });
      this.send({ type: "line", who: "them", original: r.original, translation: r.translation });
      if (this.client.readyState === 1) this.client.send(r.audio); // audio MP3 da riprodurre
    });
  }

  /** Legge un testo sulla linea con la tua voce clonata, in streaming (μ-law 8 kHz). */
  async speakOnLine(text) {
    if (this.ended || !this.line) return;
    const res = await synthesize({ text, voiceId: this.me.voiceId, lang: this.calleeLang, format: "ulaw_8000" });
    const reader = res.body.getReader();
    let rest = Buffer.alloc(0);
    const push = (bytes) => {
      if (!bytes.length || this.line?.readyState !== 1) return;
      this.line.send(JSON.stringify({ event: "media", streamSid: this.streamSid, media: { payload: bytes.toString("base64") } }));
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest = Buffer.concat([rest, Buffer.from(value)]);
      const usable = rest.length - (rest.length % 160); // blocchi interi da 20 ms
      push(rest.subarray(0, usable));
      rest = rest.subarray(usable);
    }
    push(rest);
  }

  attachLine(ws, streamSid) {
    this.line = ws;
    this.streamSid = streamSid;
    this.isAnswered = true;
    this.send({ type: "status", status: "in-progress" });
    this.onAnswered();
    const vad = lineVad((pcm) => this.fromLine(pcm));
    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.event === "media" && msg.media?.track !== "outbound") {
        vad(ulawToPcm(Buffer.from(msg.media.payload, "base64")));
      } else if (msg.event === "stop") {
        this.end("completed");
      }
    });
    ws.on("close", () => this.end("completed"));
  }

  onStatus(status) {
    this.send({ type: "status", status });
    if (["completed", "busy", "no-answer", "failed", "canceled"].includes(status)) this.end(status);
  }

  async end(reason = "completed") {
    if (this.ended) return;
    this.ended = true;
    sessions.delete(this.id);
    this.onAnswered(); // sblocca le frasi in coda, che verranno scartate
    if (this.callSid && reason !== "busy" && reason !== "no-answer" && reason !== "failed") {
      // Twilio: "canceled" interrompe una chiamata che squilla, "completed" chiude quella in corso.
      const Status = this.isAnswered ? "completed" : "canceled";
      twilio(`/Calls/${this.callSid}.json`, new URLSearchParams({ Status })).catch(() => {});
    }
    try { this.line?.close(); } catch {}
    this.send({ type: "status", status: reason === "completed" ? "ended" : reason });
    setTimeout(() => { try { this.client.close(); } catch {} }, 500);
  }
}

// ---------- Collegamento al server ----------

export function callRoutes(app) {
  app.get("/api/call/config", (_req, res) => res.json({ enabled: callsEnabled() }));

  app.post("/twilio/status", express.urlencoded({ extended: false }), (req, res) => {
    if (!TW_TOKEN || !fromTwilio(req)) return res.sendStatus(403);
    sessions.get(String(req.query.callId))?.onStatus(req.body.CallStatus);
    res.sendStatus(204);
  });
}

export function attachCalls(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url, "http://localhost");
    if (pathname !== "/ws/call" && pathname !== "/twilio/media") return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => (pathname === "/ws/call" ? onClient(ws) : onTwilio(ws)));
  });
}

// L'app sul telefono.
function onClient(ws) {
  let session = null;
  ws.on("message", async (raw, isBinary) => {
    if (isBinary) return session?.fromMe(Buffer.from(raw));
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === "hangup") return session?.end("completed");
    if (msg.type !== "start" || session) return;

    const fail = (message) => { ws.send(JSON.stringify({ type: "error", message, fatal: true })); ws.close(); };
    if (!callsEnabled()) return fail("Le chiamate non sono configurate su questo server.");
    if (!msg.code || !checkAccessCode(msg.code)) return fail("Codice di accesso errato.");
    if (!/^\+[1-9]\d{6,14}$/.test(msg.to || "")) return fail("Numero non valido: usa il prefisso internazionale, es. +44…");
    const me = msg.me || {};
    if (!SUPPORTED.has(msg.calleeLang) || !SUPPORTED.has(me.lang)) return fail("Lingua non supportata.");

    session = new CallSession(ws, {
      to: msg.to,
      calleeLang: msg.calleeLang,
      me: { name: String(me.name || "chi chiama").slice(0, 40), lang: me.lang, voiceId: me.voiceId || null },
    });
    try {
      await session.dial();
    } catch (e) {
      console.error(e);
      session.end("failed");
      fail("Chiamata non riuscita: " + e.message);
    }
  });
  ws.on("close", () => session?.end("completed"));
}

// Il flusso audio della linea telefonica, aperto da Twilio quando l'altra persona risponde.
function onTwilio(ws) {
  ws.once("message", function first(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return ws.close(); }
    if (msg.event === "connected") return ws.once("message", first);
    if (msg.event !== "start") return ws.close();
    const { callId, token } = msg.start?.customParameters || {};
    const session = sessions.get(callId);
    if (!session || !token || !sameSecret(token, session.token)) return ws.close();
    session.attachLine(ws, msg.start.streamSid);
  });
}
