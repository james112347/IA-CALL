const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'pNInz6obpgDQGcFmaJgB'; // "Adam" default

const AUDIO_DIR = path.join(__dirname, '..', 'audio-cache');

// Assicurati che la cartella esista
if (!fs.existsSync(AUDIO_DIR)) {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
}

/**
 * Genera audio da testo usando ElevenLabs API.
 * Ritorna il nome del file audio generato.
 */
async function textToSpeech(text) {
  // Hash del testo per caching
  const hash = crypto.createHash('md5').update(text).digest('hex');
  const filename = `${hash}.mp3`;
  const filepath = path.join(AUDIO_DIR, filename);

  // Se esiste già in cache, ritorna subito
  if (fs.existsSync(filepath)) {
    return filename;
  }

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': ELEVENLABS_API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg'
    },
    body: JSON.stringify({
      text: text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
        style: 0.3,
        use_speaker_boost: true
      }
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('ElevenLabs API error:', response.status, errorText);
    return null;
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(filepath, buffer);

  console.log(`🔊 Audio generato: ${filename} (${buffer.length} bytes)`);
  return filename;
}

/**
 * Pulisci file audio più vecchi di maxAge (in millisecondi).
 * Default: 1 ora.
 */
function cleanupOldAudio(maxAge = 3600000) {
  const files = fs.readdirSync(AUDIO_DIR);
  const now = Date.now();

  for (const file of files) {
    if (file === '.gitkeep') continue;
    const filepath = path.join(AUDIO_DIR, file);
    const stat = fs.statSync(filepath);
    if (now - stat.mtimeMs > maxAge) {
      fs.unlinkSync(filepath);
    }
  }
}

// Pulizia automatica ogni 30 minuti
setInterval(cleanupOldAudio, 1800000);

module.exports = { textToSpeech, cleanupOldAudio };
