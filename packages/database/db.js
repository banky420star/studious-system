const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL || 'postgres://crmuser:crmpass@localhost:5432/wa_crm';

const pool = new Pool({
  connectionString,
  // ssl: process.env.DATABASE_URL?.includes('sslmode=require') ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected error on idle client', err);
});

async function query(text, params) {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    if (duration > 1000) console.log(`[DB] Slow query ${duration}ms: ${text}`);
    return res;
  } catch (e) {
    console.error('[DB] Query error:', e.message, 'SQL:', text);
    throw e;
  }
}

async function getOrCreateCustomer(waId, phone = null, name = null) {
  if (!waId) throw new Error('waId required');
  const res = await query(
    `INSERT INTO customers (wa_id, phone, name, last_contact_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (wa_id) DO UPDATE
       SET last_contact_at = NOW(),
           phone = COALESCE($2, customers.phone),
           name = COALESCE($3, customers.name)
     RETURNING *`,
    [waId, phone, name]
  );
  return res.rows[0];
}

async function saveMessage(customerId, direction, content, waMsgId = null, meta = {}) {
  const res = await query(
    `INSERT INTO messages (customer_id, direction, content, wa_msg_id, meta)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [customerId, direction, content, waMsgId, meta]
  );
  // touch customer last_contact
  await query(
    `UPDATE customers SET last_contact_at = NOW() WHERE id = $1`,
    [customerId]
  );
  return res.rows[0];
}

async function getRecentMessages(customerId, limit = 6) {
  const res = await query(
    `SELECT id, direction, content, timestamp, wa_msg_id
     FROM messages
     WHERE customer_id = $1
     ORDER BY timestamp DESC
     LIMIT $2`,
    [customerId, limit]
  );
  return res.rows.reverse(); // oldest first for context
}

async function getMemory(customerId) {
  const res = await query(
    `SELECT m.*, c.wa_id, c.name, c.phone, c.escalation_flag, c.status
     FROM memories m
     RIGHT JOIN customers c ON c.id = m.customer_id
     WHERE c.id = $1`,
    [customerId]
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  return {
    customer: {
      id: customerId,
      wa_id: row.wa_id,
      name: row.name,
      phone: row.phone,
      escalation_flag: row.escalation_flag,
      status: row.status,
    },
    summary: row.summary || '',
    facts: row.facts || {},
    updated_at: row.updated_at,
  };
}

async function updateMemory(customerId, { summary = null, facts = null } = {}) {
  const existing = await query(
    `SELECT summary, facts FROM memories WHERE customer_id = $1`,
    [customerId]
  );
  let newSummary = summary;
  let newFacts = facts;

  if (existing.rows.length > 0) {
    const prev = existing.rows[0];
    if (!newSummary && prev.summary) newSummary = prev.summary;
    if (!newFacts && prev.facts) newFacts = prev.facts;
  }

  await query(
    `INSERT INTO memories (customer_id, summary, facts, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (customer_id) DO UPDATE
       SET summary = COALESCE($2, memories.summary),
           facts = COALESCE($3, memories.facts),
           updated_at = NOW()`,
    [customerId, newSummary, newFacts ? JSON.stringify(newFacts) : null]
  );
}

async function setEscalation(customerId, flag = true) {
  await query(
    `UPDATE customers SET escalation_flag = $2, status = $3 WHERE id = $1`,
    [customerId, flag, flag ? 'escalated' : 'active']
  );
}

async function getCustomerByWaId(waId) {
  const res = await query(`SELECT * FROM customers WHERE wa_id = $1`, [waId]);
  return res.rows[0] || null;
}

// --- Order helpers (for AI context + business logic) ---
async function getOrCreateOrder(customerId, orderRef, defaults = {}) {
  const res = await query(
    `INSERT INTO orders (customer_id, order_ref, status, items, promised_delivery, notes)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (customer_id, order_ref) DO UPDATE
       SET status = COALESCE($3, orders.status),
           items = COALESCE($4, orders.items),
           promised_delivery = COALESCE($5, orders.promised_delivery),
           notes = COALESCE($6, orders.notes),
           updated_at = NOW()
     RETURNING *`,
    [
      customerId,
      orderRef,
      defaults.status || 'pending',
      defaults.items || null,
      defaults.promised_delivery || null,
      defaults.notes || null,
    ]
  );
  return res.rows[0];
}

async function getOrderByRef(customerId, orderRef) {
  const res = await query(
    `SELECT * FROM orders WHERE customer_id = $1 AND order_ref = $2 LIMIT 1`,
    [customerId, orderRef]
  );
  return res.rows[0] || null;
}

async function getOrdersForCustomer(customerId, limit = 5) {
  const res = await query(
    `SELECT * FROM orders WHERE customer_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [customerId, limit]
  );
  return res.rows;
}

async function updateOrder(customerId, orderRef, updates = {}) {
  const fields = [];
  const values = [customerId, orderRef];
  let i = 3;

  if (updates.status) { fields.push(`status = $${i++}`); values.push(updates.status); }
  if (updates.items) { fields.push(`items = $${i++}`); values.push(updates.items); }
  if (updates.promised_delivery) { fields.push(`promised_delivery = $${i++}`); values.push(updates.promised_delivery); }
  if (updates.notes) { fields.push(`notes = $${i++}`); values.push(updates.notes); }
  if (updates.actual_delivery) { fields.push(`actual_delivery = $${i++}`); values.push(updates.actual_delivery); }
  fields.push(`updated_at = NOW()`);

  if (fields.length === 1) return null; // nothing to update

  const sql = `UPDATE orders SET ${fields.join(', ')} WHERE customer_id = $1 AND order_ref = $2 RETURNING *`;
  const res = await query(sql, values);
  return res.rows[0] || null;
}

async function closePool() {
  await pool.end();
}

module.exports = {
  pool,
  query,
  getOrCreateCustomer,
  saveMessage,
  getRecentMessages,
  getMemory,
  updateMemory,
  setEscalation,
  getCustomerByWaId,
  getOrCreateOrder,
  getOrderByRef,
  getOrdersForCustomer,
  updateOrder,
  closePool,
};
