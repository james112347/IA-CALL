# IA-CALL - Centralino AI per Ordini Telefonici

Sistema di ordinazione telefonica con intelligenza artificiale. Quando un cliente chiama il tuo numero, un assistente AI risponde, prende l'ordine e lo salva nel database. Gli ordini vengono visualizzati in tempo reale su una dashboard web.

## Architettura

```
Telefono --> Twilio --> Server Express --> Groq AI (LLM)
                                      --> Supabase (Database)
                                      --> Dashboard Web
```

## Stack Tecnologico

| Componente | Tecnologia |
|-----------|------------|
| Telefonia | Twilio Voice |
| AI / LLM | Groq API (Llama 3.3 70B) |
| Database | Supabase (PostgreSQL) |
| Backend | Node.js + Express |
| Frontend | HTML/CSS/JS (vanilla) |

## Setup

### 1. Prerequisiti

- Node.js 18+
- Account [Twilio](https://www.twilio.com) con un numero di telefono
- Account [Groq](https://console.groq.com) con API key
- Account [Supabase](https://supabase.com) con un progetto

### 2. Database

Vai nella **SQL Editor** di Supabase e esegui il contenuto di `supabase-schema.sql`.

### 3. Configurazione

```bash
cp .env.example .env
```

Compila il file `.env` con le tue credenziali:

- **TWILIO_ACCOUNT_SID** e **TWILIO_AUTH_TOKEN**: dalla console Twilio
- **TWILIO_PHONE_NUMBER**: il tuo numero Twilio (formato +39...)
- **GROQ_API_KEY**: dalla console Groq
- **SUPABASE_URL** e **SUPABASE_ANON_KEY**: da Supabase > Settings > API
- **BASE_URL**: l'URL pubblico del tuo server (vedi punto 5)

### 4. Installazione

```bash
npm install
npm start
```

### 5. Esporre il server pubblicamente

Twilio deve raggiungere il tuo server. Usa [ngrok](https://ngrok.com):

```bash
ngrok http 3000
```

Copia l'URL HTTPS (es. `https://abc123.ngrok.io`) e mettilo in `BASE_URL` nel `.env`.

### 6. Configurare Twilio

1. Vai su [Twilio Console](https://console.twilio.com) > Phone Numbers
2. Seleziona il tuo numero
3. In **Voice Configuration**:
   - **A call comes in**: Webhook
   - **URL**: `https://tuo-url.ngrok.io/voice/incoming`
   - **Method**: POST
4. Salva

### 7. Testare

Chiama il tuo numero Twilio. L'AI risponderà e prenderà il tuo ordine!

## Dashboard

Apri `http://localhost:3000` nel browser per vedere la dashboard ordini.

Funzionalità:
- Visualizzazione ordini in tempo reale
- Filtri per stato (nuovo, in preparazione, completato, annullato)
- Aggiornamento stato ordini
- Statistiche giornaliere
- Notifiche per nuovi ordini

## Struttura Progetto

```
IA-CALL/
├── public/
│   └── index.html          # Dashboard web
├── src/
│   ├── server.js           # Server Express + webhook Twilio + API
│   ├── ai-engine.js        # Motore AI con Groq
│   └── supabase.js         # Client Supabase
├── supabase-schema.sql     # Schema database
├── .env.example            # Template variabili d'ambiente
└── package.json
```

## Come Funziona

1. **Chiamata in arrivo**: Twilio riceve la chiamata e invia un webhook al server
2. **Riconoscimento vocale**: Twilio converte il parlato in testo (Speech-to-Text)
3. **AI processa**: Il testo viene inviato a Groq (Llama 3.3) che gestisce la conversazione
4. **Risposta vocale**: La risposta AI viene letta al telefono (Text-to-Speech)
5. **Salvataggio**: Quando l'ordine è confermato, viene salvato su Supabase
6. **Dashboard**: La pagina web mostra gli ordini in tempo reale
