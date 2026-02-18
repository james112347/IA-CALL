const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const DEFAULT_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'pNInz6obpgDQGcFmaJgB';

const AUDIO_DIR = path.join(__dirname, '..', 'audio-cache');

if (!fs.existsSync(AUDIO_DIR)) {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
}

/**
 * Genera audio da testo usando ElevenLabs API.
 * Supporta voiceId per-tenant.
 */
async function textToSpeech(text, voiceId) {
  const vid = voiceId || DEFAULT_VOICE_ID;
  const hash = crypto.createHash('md5').update(text + vid).digest('hex');
  const filename = `${hash}.mp3`;
  const filepath = path.join(AUDIO_DIR, filename);

  if (fs.existsSync(filepath)) {
    return filename;
  }

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${vid}`;

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

  console.log(`Audio generato: ${filename} (${buffer.length} bytes)`);
  return filename;
}

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

setInterval(cleanupOldAudio, 1800000);

module.exports = { textToSpeech, cleanupOldAudio };
