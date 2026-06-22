require('dotenv').config({ path: '../../.env' });

const express = require('express');
const db = require('../../packages/database/db');
const { handleIncomingMessage } = require('./orchestrator');

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = parseInt(process.env.API_PORT || '3000', 10);
const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET || 'dev-secret-change-me';

function authMiddleware(req, res, next) {
  const header = req.get('x-internal-secret') || req.get('X-Internal-Secret');
  if (header !== INTERNAL_SECRET) {
    console.warn('[API] Unauthorized request to', req.path);
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// Health
app.get('/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ ok: true, service: 'api-server', db: 'connected' });
  } catch (e) {
    res.status(500).json({ ok: false, db: 'error', error: e.message });
  }
});

// Main inbound endpoint (called by whatsapp-worker)
app.post('/api/incoming', authMiddleware, async (req, res) => {
  try {
    const { waId, phone, name, message, waMsgId, timestamp } = req.body;

    if (!waId || !message) {
      return res.status(400).json({ error: 'waId and message required' });
    }

    console.log(`[API] Incoming from ${waId}: ${message.substring(0, 80)}${message.length > 80 ? '...' : ''}`);

    const result = await handleIncomingMessage({
      waId,
      phone,
      name,
      message,
      waMsgId,
      timestamp,
    });

    res.json({
      ok: true,
      ...result,
    });
  } catch (err) {
    console.error('[API] /api/incoming error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Manual test endpoint (no WA needed) - useful for dev
app.post('/api/test', authMiddleware, async (req, res) => {
  try {
    const { waId = 'test@c.us', phone = '+15550001', name = 'Test User', message } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });

    // skipSend=true because "test@c.us" is not a real WA JID the linked client can deliver to.
    // Use this endpoint to test AI generation, memory, validation and escalation logic.
    const result = await handleIncomingMessage({ waId, phone, name, message, waMsgId: 'manual-' + Date.now(), timestamp: Math.floor(Date.now()/1000), skipSend: true });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get customer memory + recent + orders (for admin/debug)
app.get('/api/customer/:waId', authMiddleware, async (req, res) => {
  try {
    const customer = await db.getCustomerByWaId(req.params.waId);
    if (!customer) return res.status(404).json({ error: 'not found' });
    const memory = await db.getMemory(customer.id);
    const messages = await db.getRecentMessages(customer.id, 20);
    const orders = await db.getOrdersForCustomer(customer.id, 10);
    res.json({ customer, memory, messages, orders });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Simple list escalated
app.get('/api/escalated', authMiddleware, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT c.*, m.summary FROM customers c LEFT JOIN memories m ON m.customer_id = c.id WHERE c.escalation_flag = true ORDER BY c.last_contact_at DESC LIMIT 50`
    );
    res.json({ escalated: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Mark resolved (clear escalation)
app.post('/api/resolve/:waId', authMiddleware, async (req, res) => {
  try {
    const customer = await db.getCustomerByWaId(req.params.waId);
    if (!customer) return res.status(404).json({ error: 'not found' });
    await db.setEscalation(customer.id, false);
    res.json({ ok: true, waId: req.params.waId, status: 'active' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Demo: create/update an order for a customer (so the bot can "know" it)
app.post('/api/order', authMiddleware, async (req, res) => {
  try {
    const { waId, order_ref, status, items, promised_delivery, notes } = req.body;
    if (!waId || !order_ref) return res.status(400).json({ error: 'waId and order_ref required' });
    const customer = await db.getCustomerByWaId(waId);
    if (!customer) return res.status(404).json({ error: 'customer not found' });
    const ord = await db.getOrCreateOrder(customer.id, order_ref, { status, items, promised_delivery, notes });
    res.json({ ok: true, order: ord });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Quick unflag (resolve escalation) for a customer
app.post('/api/unflag/:waId', authMiddleware, async (req, res) => {
  try {
    const customer = await db.getCustomerByWaId(req.params.waId);
    if (!customer) return res.status(404).json({ error: 'not found' });
    await db.setEscalation(customer.id, false);
    res.json({ ok: true, waId: req.params.waId, status: 'active' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, async () => {
  console.log(`[API] Server listening on port ${PORT}`);
  try {
    await db.query('SELECT 1');
    console.log('[API] Postgres connected.');

    // Demo data for testing the "I know your orders" experience
    const testCustomer = await db.getCustomerByWaId('test@c.us');
    if (testCustomer) {
      await db.getOrCreateOrder(testCustomer.id, '4521', {
        status: 'shipped',
        items: '2x Widget Pro',
        promised_delivery: '2026-06-20',
        notes: 'Free delivery was promised because of previous delay',
      });
      await db.getOrCreateOrder(testCustomer.id, 'ORD-7832', {
        status: 'pending',
        items: '1x Mystery Box',
        promised_delivery: '2026-06-28',
      });
      console.log('[API] Demo orders seeded for test@c.us');
    }
  } catch (e) {
    console.error('[API] Postgres connection failed or demo seed issue:', e.message);
    console.error('Make sure docker compose infra is up and schema applied (npm run db:schema if needed).');
  }
  console.log(`[API] Internal secret: ${INTERNAL_SECRET === 'dev-secret-change-me' ? '(using default - change in prod!)' : '(custom)'}`);
  console.log('[API] Endpoints: POST /api/incoming  |  GET /api/customer/:waId  |  GET /api/escalated  |  POST /api/resolve/:waId | POST /api/order (for demo) | POST /api/unflag/:waId (quick resolve)');
});
