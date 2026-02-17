-- ============================================
-- Schema Supabase per il Centralino AI
-- Esegui questo SQL nella Supabase SQL Editor
-- ============================================

-- Tabella ordini
CREATE TABLE orders (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  phone_number TEXT NOT NULL,
  customer_name TEXT,
  items JSONB NOT NULL DEFAULT '[]',
  notes TEXT,
  total DECIMAL(10,2),
  status TEXT NOT NULL DEFAULT 'nuovo' CHECK (status IN ('nuovo', 'in_preparazione', 'completato', 'annullato')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tabella conversazioni (log delle chiamate)
CREATE TABLE call_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  call_sid TEXT UNIQUE NOT NULL,
  phone_number TEXT NOT NULL,
  transcript JSONB DEFAULT '[]',
  order_id UUID REFERENCES orders(id),
  duration_seconds INTEGER,
  status TEXT DEFAULT 'in_corso',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indici per performance
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_created_at ON orders(created_at DESC);
CREATE INDEX idx_call_logs_call_sid ON call_logs(call_sid);

-- Trigger per aggiornare updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER orders_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- Abilita Realtime per la tabella orders
ALTER PUBLICATION supabase_realtime ADD TABLE orders;

-- Row Level Security (opzionale, disabilita per semplicità)
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_logs ENABLE ROW LEVEL SECURITY;

-- Policy per accesso completo (da restringere in produzione)
CREATE POLICY "Allow all on orders" ON orders FOR ALL USING (true);
CREATE POLICY "Allow all on call_logs" ON call_logs FOR ALL USING (true);
