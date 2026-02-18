const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { tenants, users } = require('./database');

const JWT_SECRET = process.env.JWT_SECRET || 'ia-call-secret-change-me';
const JWT_EXPIRES = '7d';

function generateToken(user) {
  return jwt.sign(
    { userId: user.id, tenantId: user.tenant_id, role: user.role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token mancante' });
  }
  try {
    const token = header.split(' ')[1];
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Token non valido' });
  }
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Accesso negato' });
  }
  next();
}

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

    const existing = users.getByEmail(email.toLowerCase());
    if (existing) {
      return res.status(409).json({ error: 'Email gia registrata' });
    }

    try {
      const slug = slugify(businessName) + '-' + Date.now().toString(36);
      const tenant = tenants.create({
        name: businessName,
        slug,
        business_type: businessType || 'ristorante'
      });

      const passwordHash = await bcrypt.hash(password, 12);
      const user = users.create({
        tenant_id: tenant.id,
        email: email.toLowerCase(),
        password_hash: passwordHash,
        name,
        role: 'owner'
      });

      const token = generateToken(user);

      res.status(201).json({
        token,
        user: { id: user.id, email: user.email, name: user.name, role: user.role },
        tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug, plan: tenant.plan }
      });
    } catch (err) {
      console.error('Errore registrazione:', err);
      res.status(500).json({ error: 'Errore nella registrazione' });
    }
  });

  // ========================
  // POST /api/auth/login
  // ========================
  app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email e password sono obbligatori' });
    }

    const user = users.getByEmail(email.toLowerCase());
    if (!user) {
      return res.status(401).json({ error: 'Credenziali non valide' });
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Credenziali non valide' });
    }

    users.updateLastLogin(user.id);
    const token = generateToken(user);
    const tenant = tenants.getById(user.tenant_id);

    res.json({
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      tenant: tenant ? {
        id: tenant.id, name: tenant.name, slug: tenant.slug,
        plan: tenant.plan, status: tenant.status
      } : null
    });
  });

  // ========================
  // GET /api/auth/me
  // ========================
  app.get('/api/auth/me', authMiddleware, (req, res) => {
    const user = users.getById(req.user.userId);
    if (!user) return res.status(404).json({ error: 'Utente non trovato' });

    const tenant = tenants.getById(user.tenant_id);
    res.json({
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      tenant: tenant || null
    });
  });
}

module.exports = { registerAuthRoutes, authMiddleware, adminOnly, generateToken };
