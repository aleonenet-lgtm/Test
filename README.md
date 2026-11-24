# Interprete Vocale

Un'app web, utilizzabile anche su iPhone, che traduce in tempo reale con **la voce di chi parla**, clonata da un breve campione. Ha due modalità:

- **📞 Chiamata tradotta**: chiami un numero di telefono normale. Chi risponde sente la tua voce nella sua lingua, e tu senti la sua risposta tradotta nella tua. L'altra persona non deve installare niente.
- **Conversazione dal vivo**: due persone nella stessa stanza, con un solo telefono tra di loro.

## Come funziona

Per ogni frase pronunciata:

1. **Ascolto**: il browser rileva quando qualcuno inizia e smette di parlare (VAD) e invia il segmento audio.
2. **Trascrizione**: ElevenLabs Scribe trascrive la frase e riconosce la lingua.
3. **Chi parla**: dalla lingua rilevata l'app capisce se ha parlato la Persona A o la Persona B, e quindi in che direzione tradurre.
4. **Traduzione**: Claude traduce tenendo conto delle ultime battute della conversazione.
5. **Voce**: ElevenLabs legge la traduzione con la voce clonata di chi ha parlato, in streaming.

Le frasi vengono elaborate in parallelo e riprodotte in ordine, così una frase viene già tradotta mentre si sta ancora pronunciando la successiva.

## Requisiti

- Node.js 20 o superiore
- Una chiave API Anthropic: https://console.anthropic.com
- Una chiave API ElevenLabs con un piano che includa la clonazione vocale (Instant Voice Cloning): https://elevenlabs.io

## Installazione

```bash
npm install
cp .env.example .env    # poi inserisci le due chiavi
npm start
```

Apri http://localhost:3000 in Chrome, Edge o Safari.

## Chiamate tradotte

### Come funziona

```
Tu (iPhone) ⇄ questo server ⇄ Twilio ⇄ rete telefonica ⇄ telefono dell'altra persona
```

1. Nell'app scrivi il numero, con il prefisso internazionale, scegli la lingua di chi risponderà e premi **Chiama**.
2. Quando l'altra persona risponde, sente prima un breve **avviso automatico** nella sua lingua: la chiamata è tradotta da un'IA con una voce sintetica.
3. Tu parli nella tua lingua. Ogni frase viene trascritta, tradotta e pronunciata sulla linea **con la tua voce clonata**.
4. L'altra persona risponde. La sua frase viene tradotta e la senti sull'iPhone nella tua lingua, mentre sullo schermo compaiono il testo originale e la traduzione.

Ogni frase arriva dopo circa 1,5–3 secondi. Funziona meglio parlando con frasi brevi e facendo una piccola pausa alla fine di ciascuna.

### Cosa serve

1. **Un account Twilio** (https://www.twilio.com) con un numero di telefono abilitato alle chiamate internazionali verso i paesi che ti servono.
   - Con l'account di prova puoi chiamare solo numeri verificati, e chi risponde sente un messaggio di Twilio. Per l'uso reale serve un account a pagamento.
   - Se vuoi che chi risponde veda **il tuo numero di cellulare**, verificalo su Twilio ("Verified Caller IDs") e mettilo in `TWILIO_PHONE_NUMBER`.
2. **Un server sempre acceso con HTTPS e WebSocket**, raggiungibile da Twilio, ad esempio Render, Railway o Fly.io. Vercel **non** va bene per le chiamate, perché non supporta WebSocket. Va bene solo per la modalità conversazione.
3. Le variabili d'ambiente in `.env.example`: le chiavi Anthropic ed ElevenLabs, poi `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`, `PUBLIC_URL` (l'indirizzo https del server) e `CALL_ACCESS_CODE`.
4. **La tua voce clonata.** Nella scheda **Persona A** imposta il tuo nome e la tua lingua, poi registra la voce. Se non la cloni, chi risponde sente una voce standard.

### Sicurezza e costi

- Ogni chiamata costa: il minuto Twilio, più trascrizione, traduzione e sintesi vocale. Il **codice di accesso** (`CALL_ACCESS_CODE`) impedisce a chi trova l'indirizzo dell'app di chiamare a tue spese. Scegline uno lungo.
- Le chiamate durano al massimo `CALL_MAX_MINUTES` minuti (predefinito: 30).
- Il server accetta solo notifiche firmate da Twilio e flussi audio con un codice valido per quella chiamata.

### Note legali

In Europa chi riceve la chiamata va informato che la voce è sintetica e generata dall'IA (AI Act, GDPR). Per questo l'avviso iniziale è sempre attivo. Clona solo la tua voce, o quella di chi ti ha dato il consenso.

## Su iPhone

Su iPhone Safari dà accesso al microfono solo se l'app è aperta da un indirizzo **https://**. Hai due strade.

**1. Pubblicarla online (consigliato).** Usa un hosting Node con HTTPS e WebSocket, come Render, Railway o Fly.io: comando di avvio `npm start`, più le variabili d'ambiente di `.env.example`.
Su Vercel funziona solo la modalità conversazione, senza chiamate.

**2. Provarla dal PC con un tunnel HTTPS.** Avvia `npm start`, poi esegui ad esempio
`cloudflared tunnel --url http://localhost:3000` e apri sull'iPhone l'indirizzo `https://…trycloudflare.com` che compare.

Poi, sull'iPhone:

1. Apri l'indirizzo in **Safari** e consenti l'accesso al microfono.
2. *(Facoltativo)* Tocca **Condividi → Aggiungi alla schermata Home**: l'app si apre a schermo intero, con la sua icona.
3. Il primo tocco su un pulsante sblocca l'audio: è una regola di iOS, e l'app lo gestisce da sola.
4. In modalità mani libere lo schermo resta acceso. Se blocchi l'iPhone o passi a un'altra app, iOS spegne il microfono: torna sull'app e premi di nuovo *Avvia*.
5. Con gli **AirPods** o altri auricolari spunta "Usiamo gli auricolari": la traduzione diventa davvero simultanea e la qualità migliora.
6. Per clonare la voce puoi anche caricare un memo vocale (m4a) dall'app File.

## Uso

1. Scegli nome e lingua per la **Persona A** e per la **Persona B**.
2. **Clonazione della voce** (facoltativa ma consigliata): spunta la casella di consenso, premi *Registra voce* e leggi il testo proposto per circa 30 secondi in un ambiente silenzioso. In alternativa puoi caricare un file audio. Finché una voce non è clonata viene usata una voce predefinita.
3. Scegli come conversare:
   - **Mani libere**: premi *Avvia modalità mani libere*, metti il telefono o il PC tra voi due e parlate a turno. L'app capisce da sola chi sta parlando dalla lingua.
   - **Tieni premuto per parlare**: ognuno tiene premuto il proprio pulsante mentre parla. È più affidabile in ambienti rumorosi o con lingue simili tra loro.
4. Con gli **auricolari** spunta l'opzione apposita: l'app continua ad ascoltare anche mentre riproduce la traduzione, e la conversazione risulta davvero simultanea. Senza auricolari il microfono si mette in pausa durante la riproduzione, così l'app non traduce la propria voce.

## Configurazione

| Variabile | Predefinito | Note |
|---|---|---|
| `CLAUDE_MODEL` | `claude-opus-5-5` | Modello usato per la traduzione |
| `ELEVENLABS_TTS_MODEL` | `eleven_flash_v2_5` | `eleven_multilingual_v2` rende la voce più fedele, con un po' più di latenza |
| `ELEVENLABS_STT_MODEL` | `scribe_v1` | Modello di trascrizione |
| `ELEVENLABS_FALLBACK_VOICE_ID` | voce di libreria | Voce usata prima della clonazione |

## Privacy e consenso

- Clona la voce di una persona solo con il suo consenso esplicito: l'app non procede se la casella non è spuntata.
- Le voci clonate restano salvate sul tuo account ElevenLabs. Il pulsante **Elimina voce** le cancella. Puoi anche rimuoverle dalla dashboard di ElevenLabs.
- Audio e testi passano dai servizi di Anthropic ed ElevenLabs. Il server non salva nulla su disco: tiene in memoria solo l'audio delle traduzioni, per 5 minuti, per poterle riascoltare.

## Struttura

```
server.js          API: /api/turn (conversazione), /api/voices (clonazione), /api/tts/:token (audio in streaming)
call.js            Chiamate tradotte: Twilio, flusso audio della linea, traduzione nei due sensi
lib.js             Trascrizione, traduzione (Claude) e sintesi vocale (ElevenLabs) condivise
public/index.html  Interfaccia
public/app.js      Microfono, rilevamento della voce, coda di riproduzione
public/style.css   Stile (chiaro/scuro, adatto al telefono)
public/manifest.webmanifest, icone   Installazione sulla schermata Home
```
