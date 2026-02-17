const express = require('express');
const cors = require('cors');
const twilio = require('twilio');
require('dotenv').config();

const supabase = require('./supabase');
const aiEngine = require('./ai-engine');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// ============================================
// WEBHOOK TWILIO - Chiamata in arrivo
// ============================================

/**
 * POST /voice/incoming
 * Twilio chiama questo endpoint quando arriva una telefonata.
 * Risponde con TwiML per salutare e iniziare a raccogliere input vocale.
 */
app.post('/voice/incoming', async (req, res) => {
  const callSid = req.body.CallSid;
  const from = req.body.From;

  console.log(`📞 Chiamata in arrivo da ${from} (SID: ${callSid})`);

  // Registra la chiamata nel database
  await supabase.from('call_logs').insert({
    call_sid: callSid,
    phone_number: from,
    status: 'in_corso'
  });

  // Ottieni il saluto iniziale dall'AI
  const greeting = await aiEngine.getGreeting(callSid);

  const twiml = new twilio.twiml.VoiceResponse();
  const gather = twiml.gather({
    input: 'speech',
    language: 'it-IT',
    speechTimeout: 3,
    action: `${BASE_URL}/voice/process`,
    method: 'POST'
  });
  gather.say({ language: 'it-IT', voice: 'Google.it-IT-Wavenet-A' }, greeting.text);

  // Se nessun input, richiedi di nuovo
  twiml.say({ language: 'it-IT' }, 'Non ho sentito nulla. Riprova.');
  twiml.redirect(`${BASE_URL}/voice/incoming`);

  res.type('text/xml');
  res.send(twiml.toString());
});

/**
 * POST /voice/process
 * Riceve il testo riconosciuto dal parlato e lo processa con l'AI.
 */
app.post('/voice/process', async (req, res) => {
  const callSid = req.body.CallSid;
  const speechResult = req.body.SpeechResult;

  console.log(`🎤 Cliente dice: "${speechResult}" (SID: ${callSid})`);

  // Processa con l'AI
  const aiResponse = await aiEngine.processMessage(callSid, speechResult);

  console.log(`🤖 AI risponde: "${aiResponse.text}"`);

  const twiml = new twilio.twiml.VoiceResponse();

  if (aiResponse.orderComplete && aiResponse.orderData) {
    // Ordine completato - salva nel database
    const { data: order, error } = await supabase.from('orders').insert({
      phone_number: req.body.From,
      customer_name: aiResponse.orderData.customer_name,
      items: aiResponse.orderData.items,
      notes: aiResponse.orderData.notes,
      status: 'nuovo'
    }).select().single();

    if (error) {
      console.error('Errore salvataggio ordine:', error);
    } else {
      console.log(`✅ Ordine salvato: ${order.id}`);

      // Aggiorna il log della chiamata
      await supabase.from('call_logs').update({
        order_id: order.id,
        status: 'completata',
        transcript: aiEngine.getTranscript(callSid)
      }).eq('call_sid', callSid);
    }

    twiml.say(
      { language: 'it-IT', voice: 'Google.it-IT-Wavenet-A' },
      aiResponse.text + ' Grazie per il suo ordine. Arrivederci!'
    );
    twiml.hangup();

    aiEngine.cleanupConversation(callSid);
  } else if (aiResponse.orderComplete && !aiResponse.orderData) {
    // Ordine annullato
    await supabase.from('call_logs').update({
      status: 'annullata',
      transcript: aiEngine.getTranscript(callSid)
    }).eq('call_sid', callSid);

    twiml.say(
      { language: 'it-IT', voice: 'Google.it-IT-Wavenet-A' },
      'Va bene, il suo ordine è stato annullato. Arrivederci!'
    );
    twiml.hangup();

    aiEngine.cleanupConversation(callSid);
  } else {
    // Continua la conversazione
    const gather = twiml.gather({
      input: 'speech',
      language: 'it-IT',
      speechTimeout: 3,
      action: `${BASE_URL}/voice/process`,
      method: 'POST'
    });
    gather.say({ language: 'it-IT', voice: 'Google.it-IT-Wavenet-A' }, aiResponse.text);

    twiml.say({ language: 'it-IT' }, 'Non ho sentito. Può ripetere?');
    twiml.redirect(`${BASE_URL}/voice/process`);
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

/**
 * POST /voice/status
 * Callback per lo stato della chiamata (opzionale).
 */
app.post('/voice/status', async (req, res) => {
  const callSid = req.body.CallSid;
  const callStatus = req.body.CallStatus;
  const duration = req.body.CallDuration;

  if (callStatus === 'completed') {
    await supabase.from('call_logs').update({
      duration_seconds: parseInt(duration) || 0
    }).eq('call_sid', callSid);

    aiEngine.cleanupConversation(callSid);
  }

  res.sendStatus(200);
});

// ============================================
// API REST - Dashboard ordini
// ============================================

/**
 * GET /api/orders
 * Ritorna tutti gli ordini, i più recenti prima.
 */
app.get('/api/orders', async (req, res) => {
  const status = req.query.status;
  let query = supabase
    .from('orders')
    .select('*')
    .order('created_at', { ascending: false });

  if (status) {
    query = query.eq('status', status);
  }

  const { data, error } = await query;

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json(data);
});

/**
 * PATCH /api/orders/:id
 * Aggiorna lo stato di un ordine.
 */
app.patch('/api/orders/:id', async (req, res) => {
  const { id } = req.params;
  const { status, total } = req.body;

  const updates = {};
  if (status) updates.status = status;
  if (total !== undefined) updates.total = total;

  const { data, error } = await supabase
    .from('orders')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json(data);
});

/**
 * DELETE /api/orders/:id
 * Elimina un ordine.
 */
app.delete('/api/orders/:id', async (req, res) => {
  const { id } = req.params;

  const { error } = await supabase
    .from('orders')
    .delete()
    .eq('id', id);

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({ success: true });
});

/**
 * GET /api/stats
 * Statistiche ordini del giorno.
 */
app.get('/api/stats', async (req, res) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .gte('created_at', today.toISOString());

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  const stats = {
    total_orders: data.length,
    new_orders: data.filter(o => o.status === 'nuovo').length,
    in_progress: data.filter(o => o.status === 'in_preparazione').length,
    completed: data.filter(o => o.status === 'completato').length,
    cancelled: data.filter(o => o.status === 'annullato').length
  };

  res.json(stats);
});

// ============================================
// Avvio server
// ============================================

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║       🤖 CENTRALINO AI ATTIVO 🤖        ║
╠══════════════════════════════════════════╣
║  Server:    http://localhost:${PORT}        ║
║  Dashboard: http://localhost:${PORT}        ║
║  Webhook:   ${BASE_URL}/voice/incoming
╚══════════════════════════════════════════╝
  `);
  console.log('In attesa di chiamate...');
});
