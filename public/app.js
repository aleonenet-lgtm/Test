// Client: cattura microfono, rilevamento voce (VAD), invio dei segmenti,
// riproduzione ordinata delle traduzioni con la voce clonata.

const LANGS = {
  it: "Italiano", en: "English", es: "Español", fr: "Français", de: "Deutsch", pt: "Português",
  nl: "Nederlands", pl: "Polski", ro: "Română", ru: "Русский", uk: "Українська", ar: "العربية",
  zh: "中文", ja: "日本語", ko: "한국어", hi: "हिन्दी", tr: "Türkçe", el: "Ελληνικά", sv: "Svenska",
  cs: "Čeština", hu: "Magyar", he: "עברית", id: "Bahasa Indonesia", vi: "Tiếng Việt", th: "ไทย",
  fil: "Filipino", sq: "Shqip", bn: "বাংলা",
};

// Testo da leggere per registrare un buon campione vocale (~30 s).
const READ_TEXTS = {
  it: "Leggi ad alta voce: «Buongiorno, sono felice di parlare con te oggi. Mi piace viaggiare, conoscere persone nuove e assaggiare la cucina di posti diversi. Quando ho tempo libero leggo un libro, faccio una passeggiata al parco oppure cucino qualcosa di speciale per la mia famiglia e i miei amici.»",
  en: "Read aloud: “Good morning, I'm happy to talk with you today. I love travelling, meeting new people and tasting food from different places. When I have some free time I read a book, take a walk in the park, or cook something special for my family and friends.”",
  es: "Lee en voz alta: «Buenos días, estoy feliz de hablar contigo hoy. Me encanta viajar, conocer gente nueva y probar la comida de lugares diferentes. Cuando tengo tiempo libre leo un libro, paseo por el parque o cocino algo especial para mi familia y mis amigos.»",
  fr: "Lisez à voix haute : « Bonjour, je suis heureux de parler avec vous aujourd'hui. J'adore voyager, rencontrer de nouvelles personnes et goûter la cuisine d'autres pays. Quand j'ai du temps libre, je lis un livre, je me promène au parc ou je cuisine quelque chose de spécial pour ma famille et mes amis. »",
  de: "Bitte laut vorlesen: „Guten Morgen, ich freue mich, heute mit Ihnen zu sprechen. Ich reise gern, lerne neue Menschen kennen und probiere das Essen aus verschiedenen Ländern. Wenn ich Zeit habe, lese ich ein Buch, gehe im Park spazieren oder koche etwas Besonderes für meine Familie und Freunde.“",
  pt: "Leia em voz alta: «Bom dia, fico feliz em conversar com você hoje. Adoro viajar, conhecer pessoas novas e provar a comida de lugares diferentes. Quando tenho tempo livre, leio um livro, passeio no parque ou cozinho algo especial para a minha família e os meus amigos.»",
};
const readTextFor = (l) => READ_TEXTS[l] || "Parla liberamente nella tua lingua per circa 30 secondi, con tono naturale.";

const TARGET_RATE = 16000;
const $ = (s, el = document) => el.querySelector(s);

// ---------------- Stato ----------------
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const speakers = store.get("speakers", {
  a: { name: "Persona A", lang: "it", voiceId: null },
  b: { name: "Persona B", lang: "en", voiceId: null },
});
// Codice di accesso: inviato con ogni richiesta a pagamento.
const accessInput = $("#accessCode");
accessInput.value = store.get("accessCode", "") || store.get("callCode", "");
accessInput.oninput = () => { store.set("accessCode", accessInput.value.trim()); $("#accessBar").classList.remove("missing"); };
const accessCode = () => accessInput.value.trim();

async function api(url, init = {}) {
  const r = await fetch(url, { ...init, headers: { ...(init.headers || {}), "X-Access-Code": accessCode() } });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && data.code === "access_code") {
    $("#accessBar").hidden = false;
    $("#accessBar").classList.add("missing");
    accessInput.focus();
  }
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

const history = []; // { speaker, original }
let lastSpeaker = null;
const recentOutputs = []; // { text, at } per scartare l'eco degli altoparlanti

// ---------------- Microfono ----------------
let audioCtx, sampleRate, micReady;
const chunkListeners = new Set();

// iPhone/Safari: l'audio si sblocca solo dentro un gesto dell'utente (tocco), e in modo
// sincrono, prima di qualsiasi await. Ogni pulsante chiama primeAudio() per prima cosa.
const player = new Audio();
player.setAttribute("playsinline", "");
player.preload = "auto";
let playerUnlocked = false;
// 0,1 s di silenzio in WAV, per "attivare" il lettore durante il primo tocco.
const SILENT_WAV = "data:audio/wav;base64,UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YSADAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==";

function primeAudio() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctx();
  }
  if (audioCtx.state !== "running") audioCtx.resume().catch(() => {});
  if (!playerUnlocked && !playing) {
    playerUnlocked = true;
    player.src = SILENT_WAV;
    player.play().catch(() => { playerUnlocked = false; });
  }
}

async function ensureMic() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error(
      location.protocol === "https:" || location.hostname === "localhost"
        ? "questo browser non supporta l'accesso al microfono"
        : "su iPhone il microfono funziona solo con un indirizzo https://",
    );
  }
  if (micReady) { await micReady; if (audioCtx.state !== "running") await audioCtx.resume(); return; }
  micReady = (async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    if (!audioCtx) primeAudio();
    sampleRate = audioCtx.sampleRate;
    const workletSrc = `
      class Tap extends AudioWorkletProcessor {
        constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; }
        process(inputs) {
          const ch = inputs[0] && inputs[0][0];
          if (ch) for (let i = 0; i < ch.length; i++) {
            this.buf[this.n++] = ch[i];
            if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice()); this.n = 0; }
          }
          return true;
        }
      }
      registerProcessor("tap", Tap);`;
    const url = URL.createObjectURL(new Blob([workletSrc], { type: "application/javascript" }));
    await audioCtx.audioWorklet.addModule(url);
    const src = audioCtx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(audioCtx, "tap");
    node.port.onmessage = (e) => chunkListeners.forEach((fn) => fn(e.data));
    src.connect(node);
    // Il nodo deve essere collegato per essere eseguito: uscita a volume zero.
    const mute = audioCtx.createGain();
    mute.gain.value = 0;
    node.connect(mute).connect(audioCtx.destination);
  })();
  try { await micReady; } catch (e) { micReady = null; throw e; }
  if (audioCtx.state !== "running") await audioCtx.resume();
}

// Quando si torna all'app (es. dopo una notifica o una chiamata) iOS sospende l'audio.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && audioCtx && audioCtx.state !== "running") {
    audioCtx.resume().catch(() => setStatus("Tocca lo schermo per riattivare l'audio.", true));
  }
  if (document.visibilityState === "visible" && (vad.on || call.active)) keepAwake();
});
document.addEventListener("touchend", () => audioCtx && audioCtx.state !== "running" && audioCtx.resume(), { passive: true });

// Tiene lo schermo acceso in modalità mani libere: se il telefono si blocca, il microfono si ferma.
let wakeLock = null;
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
}
function releaseAwake() { wakeLock?.release().catch(() => {}); wakeLock = null; }

const rms = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s / a.length); };

function toWav(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const ratio = sampleRate / TARGET_RATE;
  const outLen = Math.floor(total / ratio);
  const flat = new Float32Array(total);
  let off = 0;
  for (const c of chunks) { flat.set(c, off); off += c.length; }
  const pcm = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio), end = Math.min(total, Math.floor((i + 1) * ratio));
    let s = 0;
    for (let j = start; j < end; j++) s += flat[j];
    const v = Math.max(-1, Math.min(1, s / Math.max(1, end - start)));
    pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  const buf = new ArrayBuffer(44 + pcm.byteLength);
  const dv = new DataView(buf);
  const w = (o, s) => [...s].forEach((ch, i) => dv.setUint8(o + i, ch.charCodeAt(0)));
  w(0, "RIFF"); dv.setUint32(4, 36 + pcm.byteLength, true); w(8, "WAVE"); w(12, "fmt ");
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, TARGET_RATE, true); dv.setUint32(28, TARGET_RATE * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, "data"); dv.setUint32(40, pcm.byteLength, true);
  new Int16Array(buf, 44).set(pcm);
  return new Blob([buf], { type: "audio/wav" });
}

// ---------------- Interfaccia oratori ----------------
for (const card of document.querySelectorAll(".speaker")) {
  const id = card.dataset.id;
  const sp = speakers[id];
  const sel = $(".lang", card);
  for (const [code, label] of Object.entries(LANGS)) sel.add(new Option(label, code));
  sel.value = sp.lang;
  $(".name", card).value = sp.name;
  $(".read-text", card).textContent = readTextFor(sp.lang);
  sel.onchange = () => { sp.lang = sel.value; $(".read-text", card).textContent = readTextFor(sp.lang); save(); };
  $(".name", card).oninput = (e) => { sp.name = e.target.value || id.toUpperCase(); save(); };
  $(".rec-sample", card).onclick = () => recordSample(id, card);
  $(".sample-file", card).onchange = (e) => uploadSample(id, card, [...e.target.files]);
  renderVoice(id);

  const ptt = $(".ptt", card);
  ptt.addEventListener("pointerdown", (e) => { e.preventDefault(); ptt.setPointerCapture(e.pointerId); startPTT(id, ptt); });
  ptt.addEventListener("pointerup", () => stopPTT(id, ptt));
  ptt.addEventListener("pointercancel", () => stopPTT(id, ptt));
}

function save() { store.set("speakers", speakers); }

function renderVoice(id) {
  const card = document.querySelector(`.speaker[data-id="${id}"]`);
  const st = $(".voice-status", card);
  st.innerHTML = "";
  if (speakers[id].voiceId) {
    st.append("Voce: ✅ clonata ");
    const del = document.createElement("button");
    del.textContent = "Elimina voce";
    del.onclick = () => deleteVoice(id);
    st.append(del);
  } else {
    st.textContent = "Voce: predefinita (non ancora clonata)";
  }
}

function checkConsent(card) {
  if ($(".consent-box", card).checked) return true;
  setStatus("Spunta la casella di consenso prima di clonare la voce.", true);
  return false;
}

async function recordSample(id, card) {
  const btn = $(".rec-sample", card);
  if (btn._stop) return btn._stop();
  if (!checkConsent(card)) return;
  if (call.active) return setStatus("Non puoi registrare il campione durante una chiamata.", true);
  primeAudio();
  stopHandsFree(); // altrimenti il testo letto verrebbe anche tradotto
  try { await ensureMic(); } catch (e) { return setStatus("Microfono non disponibile: " + e.message, true); }
  const chunks = [];
  const fn = (c) => chunks.push(c);
  chunkListeners.add(fn);
  const started = Date.now();
  btn.classList.add("recording");
  const timer = setInterval(() => {
    const s = Math.round((Date.now() - started) / 1000);
    btn.textContent = `⏹ Stop (${s}s / 30s)`;
    if (s >= 30) btn._stop();
  }, 250);
  btn._stop = async () => {
    clearInterval(timer);
    chunkListeners.delete(fn);
    btn._stop = null;
    btn.classList.remove("recording");
    btn.textContent = "🎙️ Registra voce (30 s)";
    const secs = (Date.now() - started) / 1000;
    if (secs < 10) return setStatus("Campione troppo breve: servono almeno 10 secondi.", true);
    await sendVoice(id, [new File([toWav(chunks)], "campione.wav", { type: "audio/wav" })]);
  };
}

async function uploadSample(id, card, files) {
  if (!files.length || !checkConsent(card)) return;
  await sendVoice(id, files);
}

async function sendVoice(id, files) {
  setStatus(`Clonazione della voce di ${speakers[id].name}…`);
  const fd = new FormData();
  fd.append("name", speakers[id].name);
  fd.append("consent", "true");
  files.forEach((f) => fd.append("samples", f));
  try {
    const data = await api("/api/voices", { method: "POST", body: fd });
    if (speakers[id].voiceId) deleteVoice(id, true);
    speakers[id].voiceId = data.voiceId;
    save();
    renderVoice(id);
    setStatus(`Voce di ${speakers[id].name} clonata. Ora le traduzioni useranno la sua voce.`);
  } catch (e) {
    setStatus("Clonazione non riuscita: " + e.message, true);
  }
}

async function deleteVoice(id, silent) {
  const v = speakers[id].voiceId;
  if (!v) return;
  speakers[id].voiceId = null;
  save();
  renderVoice(id);
  try { await api(`/api/voices/${encodeURIComponent(v)}`, { method: "DELETE", keepalive: true }); } catch {}
  if (!silent) setStatus(`Voce di ${speakers[id].name} eliminata.`);
}

// ---------------- Pipeline dei turni ----------------
let seq = 0;
let playChain = Promise.resolve();
let playing = false;
let suppressUntil = 0;
const headphones = () => $("#headphones")?.checked;

function sendSegment(chunks, forcedSpeaker) {
  const wav = toWav(chunks);
  const n = ++seq;
  const bubble = addBubble(forcedSpeaker || lastSpeaker || "a", "…", "Traduzione in corso…", true);
  const fd = new FormData();
  fd.append("audio", wav, `seg-${n}.wav`);
  fd.append("config", JSON.stringify({ a: speakers.a, b: speakers.b, history: history.slice(-8), forcedSpeaker, lastSpeaker }));
  const result = api("/api/turn", { method: "POST", body: fd });

  // La riproduzione rispetta l'ordine di arrivo dei segmenti.
  playChain = playChain.then(async () => {
    let data;
    try { data = await result; } catch (e) { bubble.remove(); return setStatus("Errore: " + e.message, true); }
    if (data.empty || isEcho(data.original)) { bubble.remove(); return; }
    lastSpeaker = data.speaker;
    history.push({ speaker: speakers[data.speaker].name, original: data.original });
    fillBubble(bubble, data);
    recentOutputs.push({ text: data.translation, at: Date.now() });
    while (recentOutputs.length > 20) recentOutputs.shift();
    await play(data.audioUrl);
  });
}

// Un unico elemento audio, già sbloccato dal primo tocco: su iPhone un nuovo
// elemento creato fuori da un gesto dell'utente non potrebbe suonare.
function play(url) {
  return new Promise((resolve) => {
    playing = true;
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      player.onended = player.onerror = null;
      playing = false;
      suppressUntil = Date.now() + 400;
      resolve();
    };
    player.onended = done;
    player.onerror = () => { setStatus("Riproduzione audio non riuscita.", true); done(); };
    player.src = url;
    player.play().catch((e) => {
      setStatus(e.name === "NotAllowedError" ? "Tocca lo schermo per abilitare l'audio, poi premi Riascolta." : "Riproduzione audio non riuscita.", true);
      done();
    });
  });
}

// Scarta i segmenti che sono in realtà l'eco di una traduzione appena riprodotta.
function isEcho(text) {
  const words = (t) => new Set(t.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}\s]/gu, "").split(/\s+/).filter(Boolean));
  const w = words(text);
  if (!w.size) return true;
  const now = Date.now();
  return recentOutputs.some((o) => {
    if (now - o.at > 30_000) return false;
    const ow = words(o.text);
    let common = 0;
    w.forEach((x) => ow.has(x) && common++);
    return common / w.size > 0.6;
  });
}

// ---------------- Push-to-talk ----------------
const ptt = { chunks: null, fn: null, pressed: null };
async function startPTT(id, btn) {
  if (call.active) return setStatus("Durante la chiamata parla normalmente: la traduzione è automatica.", true);
  ptt.pressed = id;
  primeAudio();
  try { await ensureMic(); } catch (e) { ptt.pressed = null; return setStatus("Microfono non disponibile: " + e.message, true); }
  // Rilasciato mentre il microfono si attivava (es. durante la richiesta di permesso): niente da registrare.
  if (ptt.pressed !== id) return;
  ptt.chunks = [];
  ptt.fn = (c) => ptt.chunks.push(c);
  chunkListeners.add(ptt.fn);
  btn.classList.add("active");
  btn.textContent = "Sto ascoltando… rilascia per tradurre";
}
function stopPTT(id, btn) {
  if (ptt.pressed === id) ptt.pressed = null;
  if (!ptt.fn) return;
  chunkListeners.delete(ptt.fn);
  btn.classList.remove("active");
  btn.textContent = "Tieni premuto per parlare";
  const chunks = ptt.chunks;
  ptt.fn = ptt.chunks = null;
  const secs = chunks.reduce((n, c) => n + c.length, 0) / sampleRate;
  if (secs > 0.4) sendSegment(chunks, id);
}

// ---------------- Rilevamento della voce (VAD) ----------------
// Restituisce un ascoltatore di blocchi audio che chiama onSegment(blocchi)
// ogni volta che una frase finisce (pausa di 0,7 s).
function createVad(onSegment) {
  const chunkMs = (2048 / sampleRate) * 1000;
  const PRE_ROLL = Math.ceil(300 / chunkMs);
  const END_SILENCE_MS = 700, MIN_SPEECH_MS = 300, MAX_SEGMENT_MS = 12000;
  let floor = 0.005, inSpeech = false, seg = [], pre = [], speechMs = 0, silenceMs = 0;
  return (c) => {
    const level = rms(c);
    $("#level").style.width = Math.min(100, level * 900) + "%";
    const muted = !headphones() && (playing || Date.now() < suppressUntil);
    if (muted) { inSpeech = false; seg = []; pre = []; return; }
    const thr = Math.max(0.012, floor * 3.5);
    if (!inSpeech) {
      floor = floor * 0.97 + Math.min(level, 0.05) * 0.03;
      pre.push(c);
      if (pre.length > PRE_ROLL) pre.shift();
      if (level > thr) { inSpeech = true; seg = [...pre]; pre = []; speechMs = 0; silenceMs = 0; }
      return;
    }
    seg.push(c);
    if (level > thr) { speechMs += chunkMs; silenceMs = 0; } else silenceMs += chunkMs;
    if (silenceMs >= END_SILENCE_MS || seg.length * chunkMs >= MAX_SEGMENT_MS) {
      if (speechMs >= MIN_SPEECH_MS) onSegment(seg);
      inSpeech = false; seg = [];
    }
  };
}

// ---------------- Mani libere ----------------
const vad = { on: false, fn: null };
function stopHandsFree() {
  if (!vad.on) return;
  chunkListeners.delete(vad.fn);
  vad.on = false;
  const btn = $("#auto");
  btn.classList.remove("on");
  btn.textContent = "▶︎ Avvia modalità mani libere";
  $("#level").style.width = "0";
  releaseAwake();
}
$("#auto").onclick = async () => {
  if (vad.on) { stopHandsFree(); return setStatus("Ascolto interrotto."); }
  primeAudio();
  try { await ensureMic(); } catch (e) { return setStatus("Microfono non disponibile: " + e.message, true); }
  if (call.active) return setStatus("Termina prima la chiamata in corso.", true);
  vad.on = true;
  keepAwake();
  const btn = $("#auto");
  btn.classList.add("on");
  btn.textContent = "■ Ferma ascolto";
  setStatus(`In ascolto: parlate a turno in ${LANGS[speakers.a.lang]} o ${LANGS[speakers.b.lang]}.`);
  const listen = createVad((seg) => sendSegment(seg, null));
  vad.fn = (c) => { if (!ptt.fn) listen(c); };
  chunkListeners.add(vad.fn);
};

// ---------------- Chiamata telefonica tradotta ----------------
const call = { active: false, ws: null, fn: null, timer: null, startedAt: 0, answered: false, attempt: 0 };
const calleeSel = $("#calleeLang");
for (const [code, label] of Object.entries(LANGS)) calleeSel.add(new Option(label, code));
calleeSel.value = store.get("calleeLang", "en");
calleeSel.onchange = () => store.set("calleeLang", calleeSel.value);
$("#callTo").value = store.get("callTo", "");

fetch("/api/call/config").then((r) => r.json()).then((c) => {
  if (!c.enabled) {
    $("#callPanel").classList.add("disabled");
    setCallStatus("Chiamate non attive: il server deve essere configurato con Twilio (vedi README).", true);
  }
}).catch(() => {});

function setCallStatus(text, isError) {
  const s = $("#callStatus");
  s.textContent = text;
  s.classList.toggle("error", Boolean(isError));
}

function normalizeNumber(v) {
  let n = v.replace(/[\s().\-\/]/g, "");
  if (n.startsWith("00")) n = "+" + n.slice(2);
  return n;
}

$("#callBtn").onclick = async () => {
  if (call.active) return hangUp();
  primeAudio();
  const to = normalizeNumber($("#callTo").value);
  if (!/^\+[1-9]\d{6,14}$/.test(to)) return setCallStatus("Scrivi il numero con il prefisso internazionale, es. +44 20 7946 0958.", true);
  const code = accessCode();
  if (!code) {
    $("#accessBar").hidden = false;
    $("#accessBar").classList.add("missing");
    return setCallStatus("Inserisci il codice di accesso in alto.", true);
  }
  store.set("callTo", $("#callTo").value);

  // Stato attivo subito: un secondo tocco ora riaggancia invece di avviare un'altra chiamata.
  const attempt = ++call.attempt;
  call.active = true;
  call.answered = false;
  $("#callBtn").classList.add("live");
  $("#callBtn").textContent = "Riaggancia";
  setCallStatus("Avvio della chiamata…");
  try {
    await ensureMic();
  } catch (e) {
    if (call.attempt === attempt) { endCallUi(); setCallStatus("Microfono non disponibile: " + e.message, true); }
    return;
  }
  if (call.attempt !== attempt || !call.active) return; // annullata mentre il microfono si attivava
  stopHandsFree();
  keepAwake();

  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/call`);
  ws.binaryType = "arraybuffer";
  call.ws = ws;
  ws.onopen = () => {
    if (call.ws !== ws) return ws.close(); // riagganciato mentre si connetteva
    ws.send(JSON.stringify({ type: "start", to, code, calleeLang: calleeSel.value, me: speakers.a }));
  };
  ws.onmessage = (e) => {
    if (call.ws !== ws) return;
    if (typeof e.data !== "string") {
      // Traduzione di ciò che ha detto l'altra persona: la riproduciamo in ordine.
      const url = URL.createObjectURL(new Blob([e.data], { type: "audio/mpeg" }));
      playChain = playChain.then(() => play(url)).finally(() => URL.revokeObjectURL(url));
      return;
    }
    const msg = JSON.parse(e.data);
    if (msg.type === "status") onCallStatus(msg.status);
    else if (msg.type === "line") addCallLine(msg);
    else if (msg.type === "error") {
      // Gli errori di una singola frase restano visibili nel registro; quelli gravi nello stato.
      if (msg.fatal || !call.answered) setCallStatus(msg.message, true);
      else addCallLine({ who: "system", original: "⚠️ " + msg.message, translation: "" });
    }
  };
  ws.onclose = () => { if (call.ws === ws) endCallUi(); };
  ws.onerror = () => { if (call.ws === ws) setCallStatus("Connessione al server interrotta.", true); };
};

function onCallStatus(status) {
  const labels = {
    initiated: "Chiamata in corso…", queued: "Chiamata in corso…", ringing: "Sta squillando…",
    busy: "Il numero è occupato.", "no-answer": "Nessuna risposta.", failed: "Chiamata non riuscita.",
    canceled: "Chiamata annullata.", ended: "Chiamata terminata.", completed: "Chiamata terminata.",
  };
  if (status === "in-progress" || status === "answered") {
    if (call.answered) return;
    call.answered = true;
    call.startedAt = Date.now();
    // Da qui in poi ogni tua frase viene inviata e tradotta.
    call.fn = createVad((seg) => call.ws?.readyState === 1 && call.ws.send(toWav(seg)));
    chunkListeners.add(call.fn);
    const tick = () => {
      const s = Math.floor((Date.now() - call.startedAt) / 1000);
      setCallStatus(`In chiamata · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} · parla normalmente, facendo brevi pause`);
    };
    tick();
    call.timer = setInterval(tick, 1000);
    return;
  }
  if (labels[status]) setCallStatus(labels[status], ["busy", "no-answer", "failed"].includes(status));
}

function hangUp() {
  const ws = call.ws;
  if (ws?.readyState === WebSocket.OPEN) return ws.send(JSON.stringify({ type: "hangup" }));
  // Ancora in connessione: si chiude subito, così la chiamata non parte.
  endCallUi();
  try { ws?.close(); } catch {}
  setCallStatus("Chiamata annullata.");
}

function endCallUi() {
  if (!call.active) return;
  call.active = false;
  if (call.fn) chunkListeners.delete(call.fn);
  call.fn = null;
  clearInterval(call.timer);
  call.ws = null;
  releaseAwake();
  $("#level").style.width = "0";
  $("#callBtn").classList.remove("live");
  $("#callBtn").textContent = "📞 Chiama";
  if (call.answered && !$("#callStatus").classList.contains("error")) setCallStatus("Chiamata terminata.");
}

function addCallLine({ who, original, translation }) {
  const el = document.createElement("div");
  el.className = `msg ${who === "me" ? "a" : who === "them" ? "b" : "system"}`;
  el.innerHTML = `<div class="who"></div><div class="orig"></div><div class="tr"></div>`;
  $(".who", el).textContent =
    who === "me" ? `${speakers.a.name} (tu)` : who === "them" ? "Interlocutore" : translation ? "Avviso automatico a chi risponde" : "Avviso";
  $(".orig", el).textContent = original;
  $(".tr", el).textContent = translation;
  $("#callLog").prepend(el);
}

// ---------------- Registro conversazione ----------------
function addBubble(speaker, orig, tr, pending) {
  const el = document.createElement("div");
  el.className = `msg ${speaker}` + (pending ? " pending" : "");
  el.innerHTML = `<div class="who"></div><div class="orig"></div><div class="tr"></div>`;
  $(".who", el).textContent = speakers[speaker].name;
  $(".orig", el).textContent = orig;
  $(".tr", el).textContent = tr;
  $("#log").prepend(el);
  return el;
}
function fillBubble(el, d) {
  el.className = `msg ${d.speaker}`;
  $(".who", el).textContent = `${speakers[d.speaker].name} · ${LANGS[d.from] || d.from} → ${LANGS[d.to] || d.to}`;
  $(".orig", el).textContent = d.original;
  $(".tr", el).textContent = d.translation;
  const again = document.createElement("button");
  again.textContent = "🔊 Riascolta";
  again.onclick = () => { primeAudio(); playChain = playChain.then(() => play(d.audioUrl)); };
  el.append(again);
}

function setStatus(text, isError) {
  const s = $("#status");
  s.textContent = text;
  s.classList.toggle("error", Boolean(isError));
}

$("#showOriginal").onchange = (e) => document.body.classList.toggle("hide-orig", !e.target.checked);

// Le voci clonate restano sul tuo account ElevenLabs finché non le elimini con "Elimina voce".

fetch("/api/health").then((r) => r.json()).then((h) => {
  if (h.codeRequired) $("#accessBar").hidden = false;
  if (!h.elevenlabs) setStatus("Configura ELEVENLABS_API_KEY sul server per abilitare voce e trascrizione.", true);
}).catch(() => {});
