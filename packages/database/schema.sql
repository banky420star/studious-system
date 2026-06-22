-- WhatsApp AI CRM Schema
-- Run once on fresh DB. Idempotent where possible.

CREATE TABLE IF NOT EXISTS customers (
  id SERIAL PRIMARY KEY,
  wa_id TEXT UNIQUE NOT NULL,              -- e.g. "521234567890@c.us"
  phone TEXT,                              -- human readable e.g. "+52 123 456 7890"
  name TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_contact_at TIMESTAMP WITH TIME ZONE,
  notes TEXT,
  escalation_flag BOOLEAN DEFAULT FALSE,
  status TEXT DEFAULT 'active'             -- active | escalated | closed
);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  wa_msg_id TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  content TEXT NOT NULL,
  timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  meta JSONB DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS memories (
  customer_id INTEGER PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  summary TEXT,                            -- LLM or rule-generated running facts/summary
  facts JSONB DEFAULT '{}'::jsonb,         -- structured: {"last_order_id": "ORD-123", "prefers": "evening", "promises": [...] }
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  order_ref TEXT NOT NULL,                 -- e.g. "ORD-4521" or "4521"
  status TEXT DEFAULT 'pending',           -- pending, processing, shipped, delivered, cancelled, refunded
  items TEXT,
  promised_delivery DATE,
  actual_delivery DATE,
  notes TEXT,
  meta JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE (customer_id, order_ref)
);

CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_ref ON orders(order_ref);

-- Helpful indexes
CREATE INDEX IF NOT EXISTS idx_customers_wa_id ON customers(wa_id);
CREATE INDEX IF NOT EXISTS idx_messages_customer_ts ON messages(customer_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_messages_wa_msg_id ON messages(wa_msg_id);

-- Seed example (optional, safe to re-run)
-- INSERT INTO customers (wa_id, phone, name) VALUES ('test@c.us', '+1 555 0001', 'Test User')
-- ON CONFLICT (wa_id) DO NOTHING;
