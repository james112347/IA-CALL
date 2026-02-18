const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, '..', 'data', 'ia-call.db');

// Crea la cartella data se non esiste
const fs = require('fs');
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(DB_PATH);

// Abilita WAL mode per performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ============================================
// SCHEMA
// ============================================
db.exec(`
  CREATE TABLE IF NOT EXISTS tenants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    business_type TEXT DEFAULT 'ristorante',
    ai_prompt TEXT,
    menu TEXT DEFAULT '[]',
    voice_id TEXT,
    plan TEXT DEFAULT 'free',
    status TEXT DEFAULT 'active',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT DEFAULT 'owner',
    last_login TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
    session_id TEXT,
    customer_name TEXT,
    items TEXT DEFAULT '[]',
    notes TEXT,
    total REAL,
    status TEXT DEFAULT 'nuovo',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS call_logs (
    id TEXT PRIMARY KEY,
    tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
    session_id TEXT,
    transcript TEXT DEFAULT '[]',
    order_id TEXT REFERENCES orders(id),
    duration_seconds INTEGER DEFAULT 0,
    status TEXT DEFAULT 'in_corso',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS usage_logs (
    id TEXT PRIMARY KEY,
    tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    amount INTEGER DEFAULT 1,
    metadata TEXT DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
  CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_orders_tenant ON orders(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
  CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
  CREATE INDEX IF NOT EXISTS idx_tenants_slug ON tenants(slug);
  CREATE INDEX IF NOT EXISTS idx_usage_tenant ON usage_logs(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_logs(created_at);
`);

// ============================================
// HELPERS
// ============================================
function generateId() {
  return crypto.randomUUID();
}

function parseJson(str, fallback) {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

function tenantFromRow(row) {
  if (!row) return null;
  return { ...row, menu: parseJson(row.menu, []) };
}

function orderFromRow(row) {
  if (!row) return null;
  return { ...row, items: parseJson(row.items, []) };
}

// ============================================
// TENANTS
// ============================================
const tenants = {
  create(data) {
    const id = generateId();
    db.prepare(`INSERT INTO tenants (id, name, slug, business_type) VALUES (?, ?, ?, ?)`)
      .run(id, data.name, data.slug, data.business_type || 'ristorante');
    return tenantFromRow(db.prepare('SELECT * FROM tenants WHERE id = ?').get(id));
  },

  getById(id) {
    return tenantFromRow(db.prepare('SELECT * FROM tenants WHERE id = ?').get(id));
  },

  getBySlug(slug) {
    return tenantFromRow(db.prepare('SELECT * FROM tenants WHERE slug = ? AND status = ?').get(slug, 'active'));
  },

  update(id, data) {
    const fields = [];
    const values = [];
    for (const [key, val] of Object.entries(data)) {
      if (val !== undefined) {
        fields.push(`${key} = ?`);
        values.push(key === 'menu' ? JSON.stringify(val) : val);
      }
    }
    if (fields.length === 0) return this.getById(id);
    fields.push("updated_at = datetime('now')");
    values.push(id);
    db.prepare(`UPDATE tenants SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.getById(id);
  },

  getAll() {
    return db.prepare('SELECT * FROM tenants ORDER BY created_at DESC').all().map(tenantFromRow);
  }
};

// ============================================
// USERS
// ============================================
const users = {
  create(data) {
    const id = generateId();
    db.prepare(`INSERT INTO users (id, tenant_id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, data.tenant_id, data.email, data.password_hash, data.name, data.role || 'owner');
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  },

  getByEmail(email) {
    return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  },

  getById(id) {
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  },

  getByTenantId(tenantId) {
    return db.prepare('SELECT * FROM users WHERE tenant_id = ?').all(tenantId);
  },

  updateLastLogin(id) {
    db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(id);
  },

  delete(id) {
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
  }
};

// ============================================
// ORDERS
// ============================================
const orders = {
  create(data) {
    const id = generateId();
    db.prepare(`INSERT INTO orders (id, tenant_id, session_id, customer_name, items, notes, status) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, data.tenant_id, data.session_id || null, data.customer_name || null, JSON.stringify(data.items || []), data.notes || null, 'nuovo');
    return orderFromRow(db.prepare('SELECT * FROM orders WHERE id = ?').get(id));
  },

  getByTenant(tenantId, status) {
    if (status) {
      return db.prepare('SELECT * FROM orders WHERE tenant_id = ? AND status = ? ORDER BY created_at DESC')
        .all(tenantId, status).map(orderFromRow);
    }
    return db.prepare('SELECT * FROM orders WHERE tenant_id = ? ORDER BY created_at DESC')
      .all(tenantId).map(orderFromRow);
  },

  getTodayByTenant(tenantId) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return db.prepare('SELECT * FROM orders WHERE tenant_id = ? AND created_at >= ? ORDER BY created_at DESC')
      .all(tenantId, today.toISOString()).map(orderFromRow);
  },

  update(id, tenantId, data) {
    const fields = [];
    const values = [];
    for (const [key, val] of Object.entries(data)) {
      if (val !== undefined) {
        fields.push(`${key} = ?`);
        values.push(key === 'items' ? JSON.stringify(val) : val);
      }
    }
    if (fields.length === 0) return null;
    fields.push("updated_at = datetime('now')");
    values.push(id, tenantId);
    db.prepare(`UPDATE orders SET ${fields.join(', ')} WHERE id = ? AND tenant_id = ?`).run(...values);
    return orderFromRow(db.prepare('SELECT * FROM orders WHERE id = ? AND tenant_id = ?').get(id, tenantId));
  },

  delete(id, tenantId) {
    db.prepare('DELETE FROM orders WHERE id = ? AND tenant_id = ?').run(id, tenantId);
  }
};

// ============================================
// CALL LOGS
// ============================================
const callLogs = {
  create(data) {
    const id = generateId();
    db.prepare(`INSERT INTO call_logs (id, tenant_id, session_id, status) VALUES (?, ?, ?, ?)`)
      .run(id, data.tenant_id, data.session_id, 'in_corso');
    return db.prepare('SELECT * FROM call_logs WHERE id = ?').get(id);
  },

  updateBySession(sessionId, data) {
    const fields = [];
    const values = [];
    for (const [key, val] of Object.entries(data)) {
      if (val !== undefined) {
        fields.push(`${key} = ?`);
        values.push(key === 'transcript' ? JSON.stringify(val) : val);
      }
    }
    if (fields.length === 0) return;
    values.push(sessionId);
    db.prepare(`UPDATE call_logs SET ${fields.join(', ')} WHERE session_id = ?`).run(...values);
  }
};

// ============================================
// USAGE LOGS
// ============================================
const usage = {
  track(tenantId, eventType, amount, metadata) {
    if (!tenantId) return;
    const id = generateId();
    db.prepare(`INSERT INTO usage_logs (id, tenant_id, event_type, amount, metadata) VALUES (?, ?, ?, ?, ?)`)
      .run(id, tenantId, eventType, amount || 1, JSON.stringify(metadata || {}));
  },

  getMonthly(tenantId) {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const rows = db.prepare('SELECT event_type, amount FROM usage_logs WHERE tenant_id = ? AND created_at >= ?')
      .all(tenantId, startOfMonth);

    const result = { calls: 0, tts_chars: 0, ai_tokens: 0, orders: 0 };
    for (const row of rows) {
      switch (row.event_type) {
        case 'call': result.calls += row.amount; break;
        case 'tts_chars': result.tts_chars += row.amount; break;
        case 'ai_tokens': result.ai_tokens += row.amount; break;
        case 'order': result.orders += row.amount; break;
      }
    }
    return result;
  },

  getGlobalMonthly() {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const rows = db.prepare('SELECT event_type, amount FROM usage_logs WHERE created_at >= ?')
      .all(startOfMonth);

    let totalCalls = 0, totalOrders = 0;
    for (const row of rows) {
      if (row.event_type === 'call') totalCalls += row.amount;
      if (row.event_type === 'order') totalOrders += row.amount;
    }
    return { totalCalls, totalOrders };
  }
};

module.exports = { db, tenants, users, orders, callLogs, usage, generateId };
