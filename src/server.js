const express = require('express');
const cors = require('cors');
const twilio = require('twilio');
require('dotenv').config();

const path = require('path');
const supabase = require('./supabase');
const aiEngine = require('./ai-engine');
const tts = require('./tts-elevenlabs');
const { registerAuthRoutes, authMiddleware, adminOnly } = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Twilio client (account master della piattaforma)
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Serve file audio generati da ElevenLabs
app.use('/audio', express.static(path.join(__dirname, '..', 'audio-cache')));

// ============================================
// AUTENTICAZIONE
// ============================================
registerAuthRoutes(app);

// ============================================
// HELPER
// ============================================

/**
 * Trova il tenant dal numero di telefono Twilio (To)
 */
async function getTenantByPhone(phoneNumber) {
  const { data } = await supabase
    .from('tenants')
    .select('*')
    .eq('phone_number', phoneNumber)
    .eq('status', 'active')
    .single();
  return data;
}

/**
 * Traccia utilizzo per un tenant
 */
async function trackUsage(tenantId, eventType, amount, metadata) {
  if (!tenantId) return;
  await supabase.from('usage_logs').insert({
    tenant_id: tenantId,
    event_type: eventType,
    amount: amount || 1,
    metadata: metadata || {}
  });
}

/**
 * Helper: genera audio con ElevenLabs e aggiunge <Play> al TwiML,
 * con fallback su <Say> se ElevenLabs non e' disponibile.
 */
async function addVoiceToTwiml(twimlNode, text, tenant) {
  try {
    const voiceId = (tenant && tenant.voice_id) || undefined;
    const audioFile = await tts.textToSpeech(text, voiceId);
    if (audioFile) {
      twimlNode.play(`${BASE_URL}/audio/${audioFile}`);
      // Traccia uso TTS
      if (tenant) {
        await trackUsage(tenant.id, 'tts_chars', text.length, { chars: text.length });
      }
      return;
    }
  } catch (err) {
    console.error('ElevenLabs fallback a Say:', err.message);
  }
  twimlNode.say({ language: 'it-IT', voice: 'Google.it-IT-Wavenet-A' }, text);
}

// ============================================
// WEBHOOK TWILIO - Chiamata in arrivo
// ============================================

/**
 * POST /voice/incoming
 * Twilio chiama questo endpoint quando arriva una telefonata.
 * Identifica il tenant dal numero chiamato (To).
 */
app.post('/voice/incoming', async (req, res) => {
  const callSid = req.body.CallSid;
  const from = req.body.From;
  const to = req.body.To;

  console.log(`Chiamata in arrivo da ${from} al numero ${to} (SID: ${callSid})`);

  // Trova il tenant proprietario del numero chiamato
  const tenant = await getTenantByPhone(to);

  if (!tenant) {
    console.error(`Nessun tenant trovato per il numero ${to}`);
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say({ language: 'it-IT', voice: 'Google.it-IT-Wavenet-A' },
      'Ci scusiamo, questo numero non e\' al momento attivo. Riprovi piu\' tardi.');
    twiml.hangup();
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  // Registra la chiamata nel database
  await supabase.from('call_logs').insert({
    tenant_id: tenant.id,
    call_sid: callSid,
    phone_number: from,
    status: 'in_corso'
  });

  // Traccia la chiamata
  await trackUsage(tenant.id, 'call', 1, { from, callSid });

  // Ottieni il saluto iniziale dall'AI (con contesto tenant)
  const greeting = await aiEngine.getGreeting(callSid, tenant);

  const twiml = new twilio.twiml.VoiceResponse();
  const gather = twiml.gather({
    input: 'speech',
    language: 'it-IT',
    speechTimeout: 3,
    action: `${BASE_URL}/voice/process`,
    method: 'POST'
  });
  await addVoiceToTwiml(gather, greeting.text, tenant);

  await addVoiceToTwiml(twiml, 'Non ho sentito nulla. Riprova.', tenant);
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
  const to = req.body.To;

  console.log(`Cliente dice: "${speechResult}" (SID: ${callSid})`);

  // Recupera il tenant dal numero o dalla conversazione
  const tenantId = aiEngine.getConversationTenantId(callSid);
  let tenant = null;
  if (tenantId) {
    const { data } = await supabase.from('tenants').select('*').eq('id', tenantId).single();
    tenant = data;
  } else if (to) {
    tenant = await getTenantByPhone(to);
  }

  // Processa con l'AI
  const aiResponse = await aiEngine.processMessage(callSid, speechResult, tenant);

  // Traccia uso AI
  if (tenant && aiResponse.tokensUsed) {
    await trackUsage(tenant.id, 'ai_tokens', aiResponse.tokensUsed, { callSid });
  }

  console.log(`AI risponde: "${aiResponse.text}"`);

  const twiml = new twilio.twiml.VoiceResponse();

  if (aiResponse.orderComplete && aiResponse.orderData) {
    // Ordine completato - salva nel database
    const { data: order, error } = await supabase.from('orders').insert({
      tenant_id: tenant ? tenant.id : null,
      phone_number: req.body.From,
      customer_name: aiResponse.orderData.customer_name,
      items: aiResponse.orderData.items,
      notes: aiResponse.orderData.notes,
      status: 'nuovo'
    }).select().single();

    if (error) {
      console.error('Errore salvataggio ordine:', error);
    } else {
      console.log(`Ordine salvato: ${order.id} per tenant: ${tenant ? tenant.name : 'unknown'}`);

      await supabase.from('call_logs').update({
        order_id: order.id,
        status: 'completata',
        transcript: aiEngine.getTranscript(callSid)
      }).eq('call_sid', callSid);

      // Traccia ordine
      if (tenant) {
        await trackUsage(tenant.id, 'order', 1, { orderId: order.id });
      }
    }

    await addVoiceToTwiml(twiml, aiResponse.text + ' Grazie per il suo ordine. Arrivederci!', tenant);
    twiml.hangup();
    aiEngine.cleanupConversation(callSid);

  } else if (aiResponse.orderComplete && !aiResponse.orderData) {
    await supabase.from('call_logs').update({
      status: 'annullata',
      transcript: aiEngine.getTranscript(callSid)
    }).eq('call_sid', callSid);

    await addVoiceToTwiml(twiml, 'Va bene, il suo ordine e\' stato annullato. Arrivederci!', tenant);
    twiml.hangup();
    aiEngine.cleanupConversation(callSid);

  } else {
    const gather = twiml.gather({
      input: 'speech',
      language: 'it-IT',
      speechTimeout: 3,
      action: `${BASE_URL}/voice/process`,
      method: 'POST'
    });
    await addVoiceToTwiml(gather, aiResponse.text, tenant);

    await addVoiceToTwiml(twiml, 'Non ho sentito. Puo ripetere?', tenant);
    twiml.redirect(`${BASE_URL}/voice/process`);
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

/**
 * POST /voice/status
 * Callback per lo stato della chiamata.
 */
app.post('/voice/status', async (req, res) => {
  const callSid = req.body.CallSid;
  const callStatus = req.body.CallStatus;
  const duration = req.body.CallDuration;

  if (callStatus === 'completed') {
    await supabase.from('call_logs').update({
      duration_seconds: parseInt(duration) || 0
    }).eq('call_sid', callSid);

    // Traccia durata
    const tenantId = aiEngine.getConversationTenantId(callSid);
    if (tenantId) {
      await trackUsage(tenantId, 'call_duration', parseInt(duration) || 0, { callSid });
    }

    aiEngine.cleanupConversation(callSid);
  }

  res.sendStatus(200);
});

// ============================================
// API REST - Dashboard ordini (autenticata)
// ============================================

/**
 * GET /api/orders - Ordini del tenant
 */
app.get('/api/orders', authMiddleware, async (req, res) => {
  const status = req.query.status;
  let query = supabase
    .from('orders')
    .select('*')
    .eq('tenant_id', req.user.tenantId)
    .order('created_at', { ascending: false });

  if (status) {
    query = query.eq('status', status);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

/**
 * PATCH /api/orders/:id - Aggiorna ordine (tenant-scoped)
 */
app.patch('/api/orders/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { status, total } = req.body;

  const updates = {};
  if (status) updates.status = status;
  if (total !== undefined) updates.total = total;

  const { data, error } = await supabase
    .from('orders')
    .update(updates)
    .eq('id', id)
    .eq('tenant_id', req.user.tenantId)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

/**
 * DELETE /api/orders/:id - Elimina ordine (tenant-scoped)
 */
app.delete('/api/orders/:id', authMiddleware, async (req, res) => {
  const { error } = await supabase
    .from('orders')
    .delete()
    .eq('id', req.params.id)
    .eq('tenant_id', req.user.tenantId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

/**
 * GET /api/stats - Statistiche del giorno (tenant-scoped)
 */
app.get('/api/stats', authMiddleware, async (req, res) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('tenant_id', req.user.tenantId)
    .gte('created_at', today.toISOString());

  if (error) return res.status(500).json({ error: error.message });

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
// API IMPOSTAZIONI TENANT
// ============================================

/**
 * GET /api/settings - Impostazioni tenant
 */
app.get('/api/settings', authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('tenants')
    .select('*')
    .eq('id', req.user.tenantId)
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

/**
 * PUT /api/settings - Aggiorna impostazioni tenant
 */
app.put('/api/settings', authMiddleware, async (req, res) => {
  const { name, business_type, ai_prompt, menu, voice_id } = req.body;

  const updates = {};
  if (name !== undefined) updates.name = name;
  if (business_type !== undefined) updates.business_type = business_type;
  if (ai_prompt !== undefined) updates.ai_prompt = ai_prompt;
  if (menu !== undefined) updates.menu = menu;
  if (voice_id !== undefined) updates.voice_id = voice_id;

  const { data, error } = await supabase
    .from('tenants')
    .update(updates)
    .eq('id', req.user.tenantId)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

/**
 * GET /api/usage - Statistiche utilizzo tenant
 */
app.get('/api/usage', authMiddleware, async (req, res) => {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const { data, error } = await supabase
    .from('usage_logs')
    .select('event_type, amount')
    .eq('tenant_id', req.user.tenantId)
    .gte('created_at', startOfMonth);

  if (error) return res.status(500).json({ error: error.message });

  const usage = {
    calls: 0,
    tts_chars: 0,
    ai_tokens: 0,
    orders: 0
  };

  for (const log of data) {
    switch (log.event_type) {
      case 'call': usage.calls += log.amount; break;
      case 'tts_chars': usage.tts_chars += log.amount; break;
      case 'ai_tokens': usage.ai_tokens += log.amount; break;
      case 'order': usage.orders += log.amount; break;
    }
  }

  res.json(usage);
});

// ============================================
// API ADMIN (solo per admin)
// ============================================

/**
 * GET /api/admin/tenants - Lista tutti i tenant
 */
app.get('/api/admin/tenants', authMiddleware, adminOnly, async (req, res) => {
  const { data, error } = await supabase
    .from('tenants')
    .select('*, users(id, email, name, role)')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

/**
 * PATCH /api/admin/tenants/:id - Aggiorna tenant (admin)
 */
app.patch('/api/admin/tenants/:id', authMiddleware, adminOnly, async (req, res) => {
  const { id } = req.params;
  const { status, plan, phone_number, twilio_phone_sid } = req.body;

  const updates = {};
  if (status) updates.status = status;
  if (plan) updates.plan = plan;
  if (phone_number !== undefined) updates.phone_number = phone_number;
  if (twilio_phone_sid !== undefined) updates.twilio_phone_sid = twilio_phone_sid;

  const { data, error } = await supabase
    .from('tenants')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

/**
 * POST /api/admin/tenants/:id/assign-phone - Assegna un numero Twilio
 */
app.post('/api/admin/tenants/:id/assign-phone', authMiddleware, adminOnly, async (req, res) => {
  const { id } = req.params;
  const { country, areaCode } = req.body;

  try {
    // Cerca numeri disponibili
    const numbers = await twilioClient.availablePhoneNumbers(country || 'IT')
      .local
      .list({ areaCode: areaCode || undefined, limit: 1 });

    if (numbers.length === 0) {
      return res.status(404).json({ error: 'Nessun numero disponibile per questa area' });
    }

    // Acquista il numero
    const purchased = await twilioClient.incomingPhoneNumbers.create({
      phoneNumber: numbers[0].phoneNumber,
      voiceUrl: `${BASE_URL}/voice/incoming`,
      voiceMethod: 'POST',
      statusCallback: `${BASE_URL}/voice/status`,
      statusCallbackMethod: 'POST'
    });

    // Aggiorna il tenant
    const { data, error } = await supabase
      .from('tenants')
      .update({
        phone_number: purchased.phoneNumber,
        twilio_phone_sid: purchased.sid
      })
      .eq('id', id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    res.json({
      tenant: data,
      phone: {
        number: purchased.phoneNumber,
        sid: purchased.sid
      }
    });
  } catch (err) {
    console.error('Errore provisioning Twilio:', err);
    res.status(500).json({ error: 'Errore nell\'acquisto del numero: ' + err.message });
  }
});

/**
 * POST /api/admin/tenants/:id/set-phone - Assegna manualmente un numero gia esistente
 */
app.post('/api/admin/tenants/:id/set-phone', authMiddleware, adminOnly, async (req, res) => {
  const { id } = req.params;
  const { phoneNumber } = req.body;

  if (!phoneNumber) {
    return res.status(400).json({ error: 'phoneNumber e\' obbligatorio' });
  }

  // Configura il webhook sul numero Twilio
  try {
    const incomingNumbers = await twilioClient.incomingPhoneNumbers.list({
      phoneNumber: phoneNumber,
      limit: 1
    });

    if (incomingNumbers.length > 0) {
      await twilioClient.incomingPhoneNumbers(incomingNumbers[0].sid).update({
        voiceUrl: `${BASE_URL}/voice/incoming`,
        voiceMethod: 'POST',
        statusCallback: `${BASE_URL}/voice/status`,
        statusCallbackMethod: 'POST'
      });
    }

    const { data, error } = await supabase
      .from('tenants')
      .update({
        phone_number: phoneNumber,
        twilio_phone_sid: incomingNumbers[0]?.sid || null
      })
      .eq('id', id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    console.error('Errore configurazione numero:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/admin/stats - Statistiche globali admin
 */
app.get('/api/admin/stats', authMiddleware, adminOnly, async (req, res) => {
  const { data: tenants } = await supabase.from('tenants').select('id, status, plan');
  const { data: orders } = await supabase.from('orders').select('id').gte('created_at', new Date(Date.now() - 86400000).toISOString());

  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const { data: usage } = await supabase.from('usage_logs').select('event_type, amount').gte('created_at', startOfMonth);

  let totalCalls = 0;
  let totalOrders = 0;
  if (usage) {
    for (const u of usage) {
      if (u.event_type === 'call') totalCalls += u.amount;
      if (u.event_type === 'order') totalOrders += u.amount;
    }
  }

  res.json({
    total_tenants: tenants ? tenants.length : 0,
    active_tenants: tenants ? tenants.filter(t => t.status === 'active').length : 0,
    orders_today: orders ? orders.length : 0,
    monthly_calls: totalCalls,
    monthly_orders: totalOrders,
    plans: {
      free: tenants ? tenants.filter(t => t.plan === 'free').length : 0,
      starter: tenants ? tenants.filter(t => t.plan === 'starter').length : 0,
      pro: tenants ? tenants.filter(t => t.plan === 'pro').length : 0
    }
  });
});

// ============================================
// Avvio server
// ============================================

app.listen(PORT, () => {
  console.log(`
==================================================
    IA-CALL SaaS Platform
==================================================
  Server:    http://localhost:${PORT}
  Landing:   http://localhost:${PORT}
  Dashboard: http://localhost:${PORT}/dashboard.html
  Admin:     http://localhost:${PORT}/admin.html
  Webhook:   ${BASE_URL}/voice/incoming
==================================================
  `);
  console.log('Piattaforma pronta. In attesa di chiamate...');
});
