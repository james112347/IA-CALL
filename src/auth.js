const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const supabase = require('./supabase');

const JWT_SECRET = process.env.JWT_SECRET || 'ia-call-secret-change-me';
const JWT_EXPIRES = '7d';

/**
 * Genera un JWT token per un utente
 */
function generateToken(user) {
  return jwt.sign(
    { userId: user.id, tenantId: user.tenant_id, role: user.role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
}

/**
 * Middleware: verifica JWT e aggiunge req.user
 */
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token mancante' });
  }

  try {
    const token = header.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Token non valido' });
  }
}

/**
 * Middleware: solo admin
 */
function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Accesso negato' });
  }
  next();
}

/**
 * Genera uno slug da un nome
 */
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[àáâã]/g, 'a')
    .replace(/[èéêë]/g, 'e')
    .replace(/[ìíîï]/g, 'i')
    .replace(/[òóôõ]/g, 'o')
    .replace(/[ùúûü]/g, 'u')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Registra le route di autenticazione
 */
function registerAuthRoutes(app) {

  // ========================
  // POST /api/auth/register
  // ========================
  app.post('/api/auth/register', async (req, res) => {
    const { email, password, name, businessName, businessType } = req.body;

    if (!email || !password || !name || !businessName) {
      return res.status(400).json({ error: 'Tutti i campi sono obbligatori' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'La password deve avere almeno 6 caratteri' });
    }

    // Controlla se l'email esiste gia
    const { data: existing } = await supabase
      .from('users')
      .select('id')
      .eq('email', email.toLowerCase())
      .single();

    if (existing) {
      return res.status(409).json({ error: 'Email gia registrata' });
    }

    // Crea il tenant
    const slug = slugify(businessName) + '-' + Date.now().toString(36);
    const { data: tenant, error: tenantErr } = await supabase
      .from('tenants')
      .insert({
        name: businessName,
        slug: slug,
        business_type: businessType || 'ristorante'
      })
      .select()
      .single();

    if (tenantErr) {
      console.error('Errore creazione tenant:', tenantErr);
      return res.status(500).json({ error: 'Errore nella registrazione' });
    }

    // Crea l'utente
    const passwordHash = await bcrypt.hash(password, 12);
    const { data: user, error: userErr } = await supabase
      .from('users')
      .insert({
        tenant_id: tenant.id,
        email: email.toLowerCase(),
        password_hash: passwordHash,
        name: name,
        role: 'owner'
      })
      .select()
      .single();

    if (userErr) {
      console.error('Errore creazione utente:', userErr);
      // Rollback tenant
      await supabase.from('tenants').delete().eq('id', tenant.id);
      return res.status(500).json({ error: 'Errore nella registrazione' });
    }

    const token = generateToken(user);

    res.status(201).json({
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug, plan: tenant.plan }
    });
  });

  // ========================
  // POST /api/auth/login
  // ========================
  app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email e password sono obbligatori' });
    }

    const { data: user, error } = await supabase
      .from('users')
      .select('*, tenants(*)')
      .eq('email', email.toLowerCase())
      .single();

    if (error || !user) {
      return res.status(401).json({ error: 'Credenziali non valide' });
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Credenziali non valide' });
    }

    // Aggiorna last_login
    await supabase.from('users').update({ last_login: new Date().toISOString() }).eq('id', user.id);

    const token = generateToken(user);

    res.json({
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      tenant: user.tenants ? {
        id: user.tenants.id,
        name: user.tenants.name,
        slug: user.tenants.slug,
        plan: user.tenants.plan,
        phone_number: user.tenants.phone_number,
        status: user.tenants.status
      } : null
    });
  });

  // ========================
  // GET /api/auth/me
  // ========================
  app.get('/api/auth/me', authMiddleware, async (req, res) => {
    const { data: user } = await supabase
      .from('users')
      .select('*, tenants(*)')
      .eq('id', req.user.userId)
      .single();

    if (!user) {
      return res.status(404).json({ error: 'Utente non trovato' });
    }

    res.json({
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      tenant: user.tenants || null
    });
  });
}

module.exports = { registerAuthRoutes, authMiddleware, adminOnly, generateToken };
