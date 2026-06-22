require('dotenv').config({ path: '../../.env' });

const db = require('../../packages/database/db');
const { generateReply } = require('../../packages/ai-agent/ollama-agent');

const BUSINESS_NAME = process.env.BUSINESS_NAME || 'ACME Store';
const WORKER_SEND_URL = process.env.WORKER_SEND_URL || 'http://localhost:3001/send';
const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET || 'dev-secret-change-me';

const fetch = require('node-fetch');

// --- Safety / Validator ---
const FORBIDDEN_PATTERNS = [
  /will (arrive|deliver|ship|get there|be ready) (by|on|tomorrow|today|in \d)/i,
  /guarantee(d)?\b.*?(delivery|refund|return|fix|it|today|now)/i,
  /you will (receive|get|have) (your|the) (refund|order|package|money)/i,
  /definitely|100%|for sure|absolutely (will|going to)/i,
  /i (can|will|am going to)?\b.*?(refund|compensate|send (you|a )?(refund|money|it))/i,
  /no (problem|issue|worries) (at all)?,?\s*(it will|we will)/i,
  /refund.*?(today|now|immediately|guaranteed)/i,
];

function validateReply(text, customer) {
  const issues = [];
  let sanitized = text;

  for (const rx of FORBIDDEN_PATTERNS) {
    if (rx.test(text)) {
      issues.push('overpromise');
      // Neutralize the bad claim
      sanitized = sanitized.replace(rx, '[exact timing / guarantee removed per policy]');
    }
  }

  // Hard blocks - only for serious cases where the AI reply itself is bad.
  // Normal handoff language is handled by the model outputting the specific escalation phrase.
  const mustEscalatePhrases = [
    /lawyer|attorney|sue|legal action|chargeback|consumer protection|ftc|better business/i,
    /this is (unacceptable|ridiculous|fraud|scam)/i,
  ];

  let escalate = false;
  for (const rx of mustEscalatePhrases) {
    if (rx.test(text) || rx.test(customer?.notes || '')) {
      escalate = true;
      break;
    }
  }

  // Also check incoming context if needed, but here we validate the proposed reply
  return {
    ok: issues.length === 0 && !escalate,
    issues,
    sanitized,
    escalate,
  };
}

// Running memory updater: captures orders, topics, and simple commitments from the conversation
async function maybeUpdateMemory(customerId, incoming, proposedReply, memory, ordersSeen = []) {
  const summary = memory?.summary || '';
  const lowerIn = incoming.toLowerCase();
  const lowerReply = (proposedReply || '').toLowerCase();

  let newFacts = { ...(memory?.facts || {}) };
  let newSummary = summary;

  // Order refs
  const orderMatch = incoming.match(/\b(ORD[- ]?\d{2,}|#\d{3,}|\b\d{4,}\b)/i);
  if (orderMatch) {
    newFacts.last_order_ref = orderMatch[0].replace(/[#\s-]/g, '').toUpperCase();
  }
  if (ordersSeen && ordersSeen.length > 0) {
    newFacts.known_orders = ordersSeen.map(o => o.order_ref).slice(0, 5);
  }

  // Topics from incoming
  if (/refund|money back|return/i.test(lowerIn)) {
    newFacts.last_topic = 'refund_request';
  }
  if (/tracking|where is|status|shipped|delivered|when will/i.test(lowerIn)) {
    newFacts.last_topic = 'order_status';
  }
  if (/complaint|angry|not happy|disappointed|terrible|messed up/i.test(lowerIn)) {
    newFacts.last_topic = 'complaint';
  }
  if (/price|cost|how much|discount|cheaper/i.test(lowerIn)) {
    newFacts.last_topic = 'pricing';
  }

  // Capture simple promises/commitments from the *reply* (the bot's own words)
  const promiseMatch = proposedReply && proposedReply.match(/(will|can|going to|promise|refund|deliver|ship|credit|discount|free)\s+([^.]{5,60})/i);
  if (promiseMatch) {
    const promises = Array.isArray(newFacts.promises) ? newFacts.promises : [];
    promises.push({ text: promiseMatch[0].trim(), at: new Date().toISOString().slice(0,10) });
    newFacts.promises = promises.slice(-5); // keep last 5
  }

  // Keep summary short
  if (incoming.length > 20 && !summary.includes(incoming.slice(0, 40))) {
    newSummary = (summary ? summary + ' | ' : '') + incoming.slice(0, 120);
    if (newSummary.length > 800) newSummary = newSummary.slice(0, 780) + '...';
  }

  if (Object.keys(newFacts).length > 0 || newSummary !== summary) {
    await db.updateMemory(customerId, { summary: newSummary, facts: newFacts });
  }
}

async function handleIncomingMessage({ waId, phone, name, message, waMsgId, timestamp, skipSend = false }) {
  // 1. Get or create customer
  const customer = await db.getOrCreateCustomer(waId, phone, name);
  const customerId = customer.id;

  // 2. Save the incoming message
  await db.saveMessage(customerId, 'in', message, waMsgId, { timestamp });

  // 3. Load memory + recent history
  const memory = await db.getMemory(customerId);
  const recent = await db.getRecentMessages(customerId, 6);

  // 3b. Smart order lookup from incoming message (makes the bot "know" orders)
  const orderRefs = [];
  const orderRefRegex = /\b(ORD[- ]?\d{2,}|#\d{3,}|\b\d{4,}\b)/gi;
  let m;
  while ((m = orderRefRegex.exec(message)) !== null) {
    let ref = m[1] || m[0];
    ref = ref.replace(/[#\s-]/g, '').toUpperCase();
    if (ref.length >= 3 && !orderRefs.includes(ref)) orderRefs.push(ref);
  }

  let customerOrders = [];
  for (const ref of orderRefs) {
    try {
      const ord = await db.getOrCreateOrder(customerId, ref);
      if (ord) customerOrders.push(ord);
    } catch (e) { /* ignore lookup errors */ }
  }
  // Also load recent orders if no specific ref mentioned
  if (customerOrders.length === 0) {
    try {
      customerOrders = await db.getOrdersForCustomer(customerId, 3);
    } catch (e) {}
  }

  // 4. If already escalated, short-circuit: do not generate AI reply (and do not auto-send)
  if (customer.escalation_flag || customer.status === 'escalated') {
    console.log(`[ORCH] Customer ${waId} is escalated. No AI reply.`);
    return {
      customerId,
      escalated: true,
      reply: null,
      action: 'escalated_no_reply',
    };
  }

  // 5. Generate candidate reply from Ollama
  let candidateReply;
  try {
    candidateReply = await generateReply({
      customer,
      memory,
      recentMessages: recent,
      incomingMessage: message,
      orders: customerOrders,
      businessName: BUSINESS_NAME,
    });
  } catch (aiErr) {
    console.error('[ORCH] AI generation failed:', aiErr.message);
    // Fallback safe reply - keep it human, straight funny as fuck rock star fuck boy (Banks persona)
    candidateReply = "Don't have that info handy, you mad cunt. Give me a sec to check with the boss and I'll sort it. What's the vibe?";
  }

  console.log(`[ORCH] AI candidate for ${waId}: ${candidateReply.substring(0, 120)}...`);

  // 6. Safety validation + escalation decision
  const validation = validateReply(candidateReply, customer);

  // Also honor if the model itself decided to escalate (it is instructed to output a specific phrase ONLY on real triggers)
  const modelWantsEscalation = /Understood\.?\s*Escalating to a human right now\./i.test(candidateReply);

  let finalReply = candidateReply;
  let escalated = false;
  let action = 'reply_prepared';

  if (validation.escalate || customer.escalation_flag || modelWantsEscalation) {
    escalated = true;
    await db.setEscalation(customerId, true);
    // Prefer the model's own escalation text if it provided one, otherwise use standard
    if (modelWantsEscalation && candidateReply.length > 10) {
      finalReply = candidateReply;
    } else {
      finalReply = "Understood. Escalating to a human right now.";
    }
    action = 'escalated';
    // Still persist the (safe escalation) message as outgoing intent
  } else if (!validation.ok && validation.sanitized !== candidateReply) {
    finalReply = validation.sanitized;
    console.log('[ORCH] Reply sanitized due to:', validation.issues);
  }

  // 7. Persist the outgoing message (as "prepared")
  await db.saveMessage(customerId, 'out', finalReply, null, {
    source: 'ai',
    validated: validation.ok,
    issues: validation.issues,
    escalated,
  });

  // 8. Update memory with this interaction
  await maybeUpdateMemory(customerId, message, finalReply, memory, customerOrders);

  // 9. Send the (possibly escalation) message via worker, unless this is a test/skip
  let sendResult = null;
  if (!skipSend) {
    try {
      const sendRes = await fetch(WORKER_SEND_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-secret': INTERNAL_SECRET,
        },
        body: JSON.stringify({ to: waId, text: finalReply }),
      });
      if (sendRes.ok) {
        sendResult = await sendRes.json();
        action = escalated ? 'escalated_sent' : 'reply_sent';
        console.log(`[ORCH] Sent via worker: ${finalReply.substring(0, 50)}...`);
      } else {
        console.warn('[ORCH] Worker send returned non-ok:', await sendRes.text());
        action = escalated ? 'escalated_send_failed' : 'reply_send_failed';
      }
    } catch (sendErr) {
      console.error('[ORCH] Failed to call worker /send:', sendErr.message);
      action = escalated ? 'escalated_send_failed' : 'reply_send_failed';
    }
  } else {
    action = 'reply_prepared_no_send';
  }

  return {
    customerId,
    waId,
    escalated,
    reply: finalReply,
    action,
    sendResult,
    validationIssues: validation.issues,
  };
}

module.exports = {
  handleIncomingMessage,
  validateReply,
};
