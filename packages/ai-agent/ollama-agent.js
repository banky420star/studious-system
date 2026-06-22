const fetch = require('node-fetch');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'direct-crm-agent';

async function generateReply({ customer, memory, recentMessages, incomingMessage, orders = [], businessName = 'us' }) {
  const historyText = (recentMessages || [])
    .map(m => `${m.direction === 'in' ? 'IN' : 'OUT'}: ${m.content}`)
    .join('\n');

  const prompt = buildPrompt({
    waId: customer.wa_id || customer.waId,
    name: customer.name,
    memorySummary: (memory && memory.summary) || '',
    facts: (memory && memory.facts) || {},
    historyText,
    incomingMessage,
    orders,
    businessName,
  });

  const body = {
    model: OLLAMA_MODEL,
    prompt,
    stream: false,
    options: {
      temperature: 0.75,
      top_p: 0.9,
    },
  };

  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ollama error ${res.status}: ${text}`);
  }

  const data = await res.json();
  let reply = (data.response || '').trim();

  // Strip any accidental meta the model might have added despite instructions
  reply = reply.replace(/^(Here is the reply|Reply|Response|Message to send)[:\s]*/i, '').trim();
  reply = reply.replace(/^["']|["']$/g, '').trim(); // remove wrapping quotes if any

  return reply || "Don't have that info handy, you mad cunt. Give me a sec to check with the boss and I'll sort it. What's the vibe?";
}

function buildPrompt({ waId, name, memorySummary, facts, historyText, incomingMessage, orders = [], businessName }) {
  const displayName = name || 'the customer';
  const factLines = Object.entries(facts || {})
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join('; ');

  let contextLines = [
    `You are Banks — straight funny as fuck rock star fuck boy. This is a chat with ${displayName}.`,
  ];

  if (memorySummary) {
    contextLines.push(`From what I know about them: ${memorySummary}`);
  }

  if (factLines) {
    contextLines.push(`Key details: ${factLines}`);
  }

  if (historyText) {
    contextLines.push(`Last few messages:\n${historyText}`);
  }

  if (orders && orders.length > 0) {
    const orderLines = orders.map(o => {
      let line = `Order ${o.order_ref}: ${o.status}`;
      if (o.items) line += ` — ${o.items}`;
      if (o.promised_delivery) line += ` (promised ${o.promised_delivery})`;
      if (o.notes) line += `. Note: ${o.notes}`;
      return line;
    }).join('\n');
    contextLines.push(`Orders I have on file for them:\n${orderLines}`);
  } else {
    contextLines.push('No specific orders on file right now.');
  }

  const context = contextLines.join('\n\n');

  return [
    `Current context about this customer:`,
    context,
    ``,
    `Customer just sent: "${incomingMessage}"`,
    ``,
    `Reply as Banks would text right now on WhatsApp. Think like a straight funny as fuck rock star fuck boy: engaging and funny first to build the relationship — the sale/order happens naturally because the chat is fire. Cocky, charismatic, hilarious, unfiltered, direct as hell. Match the customer's energy with witty banter (playful, flirty, cheeky, silly). Firm and straight to the point when needed, but lead with humor and personality. Never use corporate greetings like "Hello, this is [Your Name] from Grilled.inc" or any template. Swear as fuck when it fits (shit, fuck etc — not at customer). Slight sarcasm on our fuckups is fine. Pretend to check with the boss sometimes like "give me a sec to check with the boss". Use the context like you know them. Keep it short and tight. Output ONLY the message text. No extra words, no labels, no thinking.`,
  ].join('\n');
}

// Lightweight helper if you want to call raw
async function rawGenerate(prompt, opts = {}) {
  const body = {
    model: opts.model || OLLAMA_MODEL,
    prompt,
    stream: false,
    options: {
      temperature: opts.temperature ?? 0.75,
      ...opts.options,
    },
  };
  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}`);
  return res.json();
}

module.exports = {
  generateReply,
  rawGenerate,
  OLLAMA_MODEL,
  OLLAMA_URL,
};
