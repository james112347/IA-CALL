-- ============================================
-- Schema Supabase - IA-CALL SaaS Multi-Tenant
-- Esegui questo SQL nella Supabase SQL Editor
-- ============================================

-- ============================================
-- 1. TABELLA TENANTS (Attivita/Ristoranti)
-- ============================================
CREATE TABLE tenants (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  phone_number TEXT,
  twilio_phone_sid TEXT,
  business_type TEXT DEFAULT 'ristorante',
  ai_prompt TEXT,
  menu JSONB DEFAULT '[]',
  voice_id TEXT DEFAULT 'pNInz6obpgDQGcFmaJgB',
  settings JSONB DEFAULT '{}',
  plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'starter', 'pro')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'cancelled')),
  monthly_calls INTEGER DEFAULT 0,
  monthly_tts_chars INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- 2. TABELLA USERS (Utenti della piattaforma)
-- ============================================
CREATE TABLE users (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'staff', 'admin')),
  last_login TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- 3. TABELLA ORDERS (con tenant_id)
-- ============================================
CREATE TABLE orders (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  phone_number TEXT NOT NULL,
  customer_name TEXT,
  items JSONB NOT NULL DEFAULT '[]',
  notes TEXT,
  total DECIMAL(10,2),
  status TEXT NOT NULL DEFAULT 'nuovo' CHECK (status IN ('nuovo', 'in_preparazione', 'completato', 'annullato')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- 4. TABELLA CALL_LOGS (con tenant_id)
-- ============================================
CREATE TABLE call_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_sid TEXT UNIQUE NOT NULL,
  phone_number TEXT NOT NULL,
  transcript JSONB DEFAULT '[]',
  order_id UUID REFERENCES orders(id),
  duration_seconds INTEGER,
  status TEXT DEFAULT 'in_corso',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- 5. TABELLA USAGE_LOGS (Tracciamento utilizzo)
-- ============================================
CREATE TABLE usage_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  amount INTEGER DEFAULT 1,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- INDICI
-- ============================================
CREATE INDEX idx_tenants_slug ON tenants(slug);
CREATE INDEX idx_tenants_phone ON tenants(phone_number);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_tenant ON users(tenant_id);
CREATE INDEX idx_orders_tenant ON orders(tenant_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_created_at ON orders(created_at DESC);
CREATE INDEX idx_call_logs_call_sid ON call_logs(call_sid);
CREATE INDEX idx_call_logs_tenant ON call_logs(tenant_id);
CREATE INDEX idx_usage_logs_tenant ON usage_logs(tenant_id);
CREATE INDEX idx_usage_logs_created ON usage_logs(created_at DESC);

-- ============================================
-- TRIGGER updated_at
-- ============================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER orders_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER tenants_updated_at
  BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================
-- REALTIME
-- ============================================
ALTER PUBLICATION supabase_realtime ADD TABLE orders;

-- ============================================
-- ROW LEVEL SECURITY
-- ============================================
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all on tenants" ON tenants FOR ALL USING (true);
CREATE POLICY "Allow all on users" ON users FOR ALL USING (true);
CREATE POLICY "Allow all on orders" ON orders FOR ALL USING (true);
CREATE POLICY "Allow all on call_logs" ON call_logs FOR ALL USING (true);
CREATE POLICY "Allow all on usage_logs" ON usage_logs FOR ALL USING (true);
