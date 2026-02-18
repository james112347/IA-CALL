# IA-CALL - Ordinazioni Vocali AI via Web

Piattaforma SaaS per ordinazioni vocali con intelligenza artificiale. I clienti aprono un link, parlano con l'AI dal browser e gli ordini arrivano nella dashboard del ristorante.

## Architettura

```
Browser cliente --> Web Speech API (STT) --> Server Express --> Groq AI (LLM)
                                                            --> SQLite (Database)
                                                            --> ElevenLabs (TTS)
                                                            --> Dashboard Web
```

## Stack Tecnologico

| Componente | Tecnologia | Costo |
|-----------|------------|-------|
| AI / LLM | Groq API (Llama 3.3 70B) | Gratis |
| Speech-to-Text | Web Speech API (browser) | Gratis |
| Text-to-Speech | ElevenLabs (multilingual v2) | API key |
| Database | SQLite (better-sqlite3) | Gratis |
| Backend | Node.js + Express | Gratis |
| Frontend | HTML/CSS/JS (vanilla) | Gratis |

## Setup

### 1. Prerequisiti

- Node.js 18+
- Account [Groq](https://console.groq.com) con API key (gratuito)
- Account [ElevenLabs](https://elevenlabs.io) con API key (10K char/mese gratis)

### 2. Configurazione

```bash
cp .env.example .env
```

Compila il file `.env` con le tue credenziali:

- **GROQ_API_KEY**: dalla console Groq
- **ELEVENLABS_API_KEY**: dalla console ElevenLabs > Profile > API Keys
- **ELEVENLABS_VOICE_ID**: (opzionale) ID della voce da usare
- **JWT_SECRET**: una stringa random per la sicurezza

### 3. Installazione

```bash
npm install
npm start
```

Il database SQLite viene creato automaticamente in `data/ia-call.db`.

### 4. Utilizzo

1. Apri `http://localhost:3000` e registra la tua attivita
2. Configura il menu e il prompt AI dalla dashboard
3. Condividi il link `/ordina/{slug}` con i tuoi clienti
4. I clienti parlano con l'AI e gli ordini appaiono nella dashboard

## Pagine

| URL | Descrizione |
|-----|-------------|
| `/` | Landing page + registrazione/login |
| `/dashboard.html` | Dashboard ordini per il ristoratore |
| `/admin.html` | Pannello admin della piattaforma |
| `/ordina/{slug}` | Pagina ordinazione vocale per i clienti |

## Struttura Progetto

```
IA-CALL/
├── public/
│   ├── index.html          # Landing page
│   ├── dashboard.html      # Dashboard ristoratore
│   ├── admin.html          # Pannello admin
│   └── ordina.html         # Pagina ordinazione vocale
├── data/                   # Database SQLite (auto-generato)
├── audio-cache/            # Cache audio ElevenLabs (auto-generato)
├── src/
│   ├── server.js           # Server Express + API REST + voice API
│   ├── ai-engine.js        # Motore AI con Groq
│   ├── tts-elevenlabs.js   # Text-to-Speech con ElevenLabs
│   ├── database.js         # SQLite schema + query layer
│   └── auth.js             # Autenticazione JWT
├── .env.example            # Template variabili d'ambiente
└── package.json
```

## Come Funziona

1. **Il cliente apre il link**: Visita `/ordina/{slug}` dal browser
2. **Riconoscimento vocale**: Web Speech API cattura la voce nel browser (gratis)
3. **AI processa**: Il testo viene inviato a Groq (Llama 3.3) che gestisce la conversazione
4. **Voce naturale**: ElevenLabs genera audio realistico dalla risposta AI
5. **Salvataggio**: Quando l'ordine e confermato, viene salvato in SQLite
6. **Dashboard**: Il ristoratore vede gli ordini in tempo reale

## API Endpoints

### Pubbliche
- `GET /api/tenant/:slug/info` - Info pubblica del tenant
- `POST /api/voice/start` - Inizia conversazione vocale
- `POST /api/voice/message` - Invia messaggio, ricevi risposta + audio

### Autenticate (JWT)
- `POST /api/auth/register` - Registrazione
- `POST /api/auth/login` - Login
- `GET /api/orders` - Lista ordini
- `PATCH /api/orders/:id` - Aggiorna stato ordine
- `GET /api/settings` - Impostazioni tenant
- `PUT /api/settings` - Aggiorna impostazioni
- `GET /api/usage` - Statistiche utilizzo
