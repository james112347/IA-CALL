const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { tenants, orders, callLogs, usage } = require('./database');
const aiEngine = require('./ai-engine');
const tts = require('./tts-elevenlabs');
const { registerAuthRoutes, authMiddleware, adminOnly } = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Serve file audio generati da ElevenLabs
app.use('/audio', express.static(path.join(__dirname, '..', 'audio-cache')));

// ============================================
// AUTENTICAZIONE
// ============================================
registerAuthRoutes(app);

// ============================================
// API VOCALE - Per la pagina ordina
// ============================================

/**
 * GET /api/tenant/:slug/info - Info pubblica del tenant
 */
app.get('/api/tenant/:slug/info', (req, res) => {
  const tenant = tenants.getBySlug(req.params.slug);
  if (!tenant) return res.status(404).json({ error: 'Attivita non trovata' });

  res.json({
    name: tenant.name,
    business_type: tenant.business_type,
    slug: tenant.slug
  });
});

/**
 * POST /api/voice/start - Inizia una conversazione vocale
 * Body: { slug }
 * Returns: { sessionId, text, audioUrl }
 */
app.post('/api/voice/start', async (req, res) => {
  const { slug } = req.body;

  const tenant = tenants.getBySlug(slug);
  if (!tenant) return res.status(404).json({ error: 'Attivita non trovata' });

  const sessionId = 'sess_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 6);

  // Registra la sessione
  callLogs.create({ tenant_id: tenant.id, session_id: sessionId });
  usage.track(tenant.id, 'call', 1, { sessionId });

  // Genera saluto dall'AI
  const greeting = await aiEngine.getGreeting(sessionId, tenant);

  // Genera audio con ElevenLabs
  let audioUrl = null;
  try {
    const voiceId = tenant.voice_id || undefined;
    const audioFile = await tts.textToSpeech(greeting.text, voiceId);
    if (audioFile) {
      audioUrl = `/audio/${audioFile}`;
      usage.track(tenant.id, 'tts_chars', greeting.text.length, { chars: greeting.text.length });
    }
  } catch (err) {
    console.error('Errore TTS:', err.message);
  }

  if (greeting.tokensUsed) {
    usage.track(tenant.id, 'ai_tokens', greeting.tokensUsed, { sessionId });
  }

  res.json({
    sessionId,
    text: greeting.text,
    audioUrl
  });
});

/**
 * POST /api/voice/message - Invia messaggio e ricevi risposta
 * Body: { sessionId, text, slug }
 * Returns: { text, audioUrl, orderComplete, orderData }
 */
app.post('/api/voice/message', async (req, res) => {
  const { sessionId, text, slug } = req.body;

  if (!sessionId || !text) {
    return res.status(400).json({ error: 'sessionId e text sono obbligatori' });
  }

  const tenant = tenants.getBySlug(slug);

  // Processa con l'AI
  const aiResponse = await aiEngine.processMessage(sessionId, text, tenant);

  // Traccia uso AI
  if (tenant && aiResponse.tokensUsed) {
    usage.track(tenant.id, 'ai_tokens', aiResponse.tokensUsed, { sessionId });
  }

  console.log(`[${sessionId}] Cliente: "${text}"`);
  console.log(`[${sessionId}] AI: "${aiResponse.text}"`);

  // Genera audio
  let audioUrl = null;
  try {
    const voiceId = (tenant && tenant.voice_id) || undefined;
    const audioFile = await tts.textToSpeech(aiResponse.text, voiceId);
    if (audioFile) {
      audioUrl = `/audio/${audioFile}`;
      if (tenant) {
        usage.track(tenant.id, 'tts_chars', aiResponse.text.length, { chars: aiResponse.text.length });
      }
    }
  } catch (err) {
    console.error('Errore TTS:', err.message);
  }

  // Se ordine completato, salva nel database
  if (aiResponse.orderComplete && aiResponse.orderData && tenant) {
    const order = orders.create({
      tenant_id: tenant.id,
      session_id: sessionId,
      customer_name: aiResponse.orderData.customer_name,
      items: aiResponse.orderData.items,
      notes: aiResponse.orderData.notes
    });

    console.log(`Ordine salvato: ${order.id} per tenant: ${tenant.name}`);

    callLogs.updateBySession(sessionId, {
      order_id: order.id,
      status: 'completata',
      transcript: aiEngine.getTranscript(sessionId)
    });

    usage.track(tenant.id, 'order', 1, { orderId: order.id });
    aiEngine.cleanupConversation(sessionId);

  } else if (aiResponse.orderComplete && !aiResponse.orderData) {
    callLogs.updateBySession(sessionId, {
      status: 'annullata',
      transcript: aiEngine.getTranscript(sessionId)
    });
    aiEngine.cleanupConversation(sessionId);
  }

  res.json({
    text: aiResponse.text,
    audioUrl,
    orderComplete: aiResponse.orderComplete,
    orderData: aiResponse.orderData
  });
});

// ============================================
// API REST - Dashboard ordini (autenticata)
// ============================================

app.get('/api/orders', authMiddleware, (req, res) => {
  const status = req.query.status || null;
  const data = orders.getByTenant(req.user.tenantId, status);
  res.json(data);
});

app.patch('/api/orders/:id', authMiddleware, (req, res) => {
  const { status, total } = req.body;
  const updates = {};
  if (status) updates.status = status;
  if (total !== undefined) updates.total = total;

  const data = orders.update(req.params.id, req.user.tenantId, updates);
  if (!data) return res.status(404).json({ error: 'Ordine non trovato' });
  res.json(data);
});

app.delete('/api/orders/:id', authMiddleware, (req, res) => {
  orders.delete(req.params.id, req.user.tenantId);
  res.json({ success: true });
});

app.get('/api/stats', authMiddleware, (req, res) => {
  const data = orders.getTodayByTenant(req.user.tenantId);
  res.json({
    total_orders: data.length,
    new_orders: data.filter(o => o.status === 'nuovo').length,
    in_progress: data.filter(o => o.status === 'in_preparazione').length,
    completed: data.filter(o => o.status === 'completato').length,
    cancelled: data.filter(o => o.status === 'annullato').length
  });
});

// ============================================
// API IMPOSTAZIONI TENANT
// ============================================

app.get('/api/settings', authMiddleware, (req, res) => {
  const data = tenants.getById(req.user.tenantId);
  if (!data) return res.status(404).json({ error: 'Tenant non trovato' });
  res.json(data);
});

app.put('/api/settings', authMiddleware, (req, res) => {
  const { name, business_type, ai_prompt, menu, voice_id } = req.body;
  const updates = {};
  if (name !== undefined) updates.name = name;
  if (business_type !== undefined) updates.business_type = business_type;
  if (ai_prompt !== undefined) updates.ai_prompt = ai_prompt;
  if (menu !== undefined) updates.menu = menu;
  if (voice_id !== undefined) updates.voice_id = voice_id;

  const data = tenants.update(req.user.tenantId, updates);
  res.json(data);
});

app.get('/api/usage', authMiddleware, (req, res) => {
  res.json(usage.getMonthly(req.user.tenantId));
});

// ============================================
// API ADMIN
// ============================================

app.get('/api/admin/tenants', authMiddleware, adminOnly, (req, res) => {
  const allTenants = tenants.getAll();
  // Aggiungi utenti per ogni tenant
  const { users: usersDb } = require('./database');
  const result = allTenants.map(t => ({
    ...t,
    users: usersDb.getByTenantId(t.id).map(u => ({ id: u.id, email: u.email, name: u.name, role: u.role }))
  }));
  res.json(result);
});

app.patch('/api/admin/tenants/:id', authMiddleware, adminOnly, (req, res) => {
  const { status, plan } = req.body;
  const updates = {};
  if (status) updates.status = status;
  if (plan) updates.plan = plan;

  const data = tenants.update(req.params.id, updates);
  if (!data) return res.status(404).json({ error: 'Tenant non trovato' });
  res.json(data);
});

app.get('/api/admin/stats', authMiddleware, adminOnly, (req, res) => {
  const allTenants = tenants.getAll();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Ordini di oggi (globali)
  const { db } = require('./database');
  const ordersToday = db.prepare('SELECT COUNT(*) as count FROM orders WHERE created_at >= ?').get(today.toISOString());
  const global = usage.getGlobalMonthly();

  res.json({
    total_tenants: allTenants.length,
    active_tenants: allTenants.filter(t => t.status === 'active').length,
    orders_today: ordersToday.count,
    monthly_calls: global.totalCalls,
    monthly_orders: global.totalOrders,
    plans: {
      free: allTenants.filter(t => t.plan === 'free').length,
      starter: allTenants.filter(t => t.plan === 'starter').length,
      pro: allTenants.filter(t => t.plan === 'pro').length
    }
  });
});

// ============================================
// PAGINA ORDINA - Servita per slug
// ============================================
app.get('/ordina/:slug', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'ordina.html'));
});

// ============================================
// CATCH-ALL: redirect 404 alla landing
// ============================================
app.use((req, res) => {
  // Se e una richiesta API, rispondi con JSON
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Endpoint non trovato' });
  }
  // Altrimenti redirect alla landing page
  res.redirect('/');
});

// ============================================
// Avvio server
// ============================================
app.listen(PORT, () => {
  console.log(`
==================================================
    IA-CALL v3 - Web Voice Ordering
==================================================
  Server:     http://localhost:${PORT}
  Landing:    http://localhost:${PORT}
  Dashboard:  http://localhost:${PORT}/dashboard.html
  Admin:      http://localhost:${PORT}/admin.html
  Ordina:     http://localhost:${PORT}/ordina/{slug}
==================================================
  API esterne: Groq (AI) + ElevenLabs (voce)
  Database:    SQLite locale
==================================================
  `);
});
