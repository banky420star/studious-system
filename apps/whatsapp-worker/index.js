require('dotenv').config({ path: '../../.env' });

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fetch = require('node-fetch');
const http = require('http');

const API_URL = process.env.API_URL || 'http://localhost:3000';
const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET || 'dev-secret-change-me';
const WORKER_PORT = parseInt(process.env.WORKER_PORT || '3001', 10);
const BUSINESS_NAME = process.env.BUSINESS_NAME || 'ACME Store';

console.log('[WORKER] Starting WhatsApp Linked Device worker...');

// --- WhatsApp Client (Multi-device / Linked Devices mode) ---
const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: './.wwebjs_auth',
  }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
    ],
  },
});

let clientReady = false;

client.on('qr', (qr) => {
  console.log('\n[WORKER] === SCAN THIS QR CODE ===');
  console.log('Open WhatsApp Business on your phone → Settings → Linked Devices → Link a Device');
  qrcode.generate(qr, { small: true });
  console.log('Waiting for scan...\n');
});

client.on('authenticated', () => {
  console.log('[WORKER] Authenticated successfully (session saved).');
});

client.on('ready', () => {
  clientReady = true;
  console.log('[WORKER] ✅ WhatsApp client READY. Linked device is active.');
  console.log(`[WORKER] Listening for inbound messages. Will forward to API at ${API_URL}`);
});

client.on('auth_failure', (msg) => {
  console.error('[WORKER] Auth failure:', msg);
});

client.on('disconnected', (reason) => {
  clientReady = false;
  console.error('[WORKER] Disconnected:', reason);
  // In production: auto-reconnect logic or PM2 restart
});

client.on('message', async (msg) => {
  try {
    if (msg.fromMe) return; // ignore our own outgoing
    if (msg.type !== 'chat') {
      // For now ignore non-text (images, docs, etc). Can extend later.
      console.log(`[WORKER] Non-text message from ${msg.from} type=${msg.type} (ignored)`);
      return;
    }

    const waId = msg.from; // "1234567890@c.us"
    const body = (msg.body || '').trim();
    if (!body) return;

    const notifyName = msg._data?.notifyName || null;
    const timestamp = msg.timestamp || Math.floor(Date.now() / 1000);

    console.log(`[IN] ${waId} (${notifyName || 'unknown'}): ${body}`);

    // Forward to central API / orchestrator
    const payload = {
      waId,
      phone: waId.replace('@c.us', ''),
      name: notifyName,
      message: body,
      waMsgId: msg.id?._serialized || null,
      timestamp,
    };

    const res = await fetch(`${API_URL}/api/incoming`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-secret': INTERNAL_SECRET,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const txt = await res.text();
      console.error('[WORKER] API forward failed:', res.status, txt);
      return;
    }

    const data = await res.json().catch(() => ({}));
    console.log('[WORKER] API processed:', { escalated: data.escalated, action: data.action, replyLength: data.reply?.length });

    // Sending is now handled exclusively by the API -> /send path (single source of truth).
    // The direct send block was removed to prevent duplicate replies.
  } catch (err) {
    console.error('[WORKER] message handler error:', err.message);
  }
});

// --- Lightweight HTTP server for outbound sends (called by API server) ---
const sendServer = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/send') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      res.setHeader('Content-Type', 'application/json');
      try {
        const { to, text } = JSON.parse(body || '{}');
        if (!to || !text) {
          res.statusCode = 400;
          return res.end(JSON.stringify({ ok: false, error: 'to and text are required' }));
        }
        if (!clientReady || !client.info || !client.info.wid) {
          res.statusCode = 503;
          return res.end(JSON.stringify({ ok: false, error: 'WhatsApp client not ready yet' }));
        }

        const sentMsg = await client.sendMessage(to, text);
        console.log(`[OUT] (via API) -> ${to}: ${text.substring(0, 80)}${text.length > 80 ? '...' : ''}`);
        res.statusCode = 200;
        res.end(JSON.stringify({
          ok: true,
          messageId: sentMsg?.id?._serialized || null,
          to,
        }));
      } catch (e) {
        console.error('[WORKER] /send error:', e);
        if (e && e.stack) console.error(e.stack);
        const errMsg = e && (e.message || e.toString() || e) || 'unknown error';
        res.statusCode = 500;
        res.end(JSON.stringify({ ok: false, error: errMsg }));
      }
    });
    return;
  }

  if (req.url === '/health') {
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, ready: clientReady }));
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ ok: false, error: 'not found' }));
});

sendServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[WORKER] Port ${WORKER_PORT} is already in use.`);
    console.error(`Run this to clean up stale processes (including puppeteer):`);
    console.error(`  npm run kill-worker`);
    process.exit(1);
  } else {
    console.error('[WORKER] Send server error:', err);
  }
});

sendServer.listen(WORKER_PORT, () => {
  console.log(`[WORKER] Outbound send API listening on http://localhost:${WORKER_PORT}/send`);
});

// Initialize the client (starts puppeteer + WA connection)
client.initialize().catch((e) => {
  console.error('[WORKER] Failed to initialize WA client:', e.message || e);
  if (e.message && e.message.includes('browser is already running')) {
    console.error('\n[WORKER] Browser session is locked.');
    console.error('Run this to clean up:');
    console.error('  npm run kill-worker');
    console.error('Or manually: rm -rf .wwebjs_auth (WARNING: will require re-scanning QR next time)');
  }
  process.exit(1);
});

const shutdown = async (signal) => {
  console.log(`\n[WORKER] Received ${signal}, shutting down gracefully...`);
  try {
    if (sendServer.listening) {
      await new Promise((resolve) => sendServer.close(resolve));
    }
    if (client) {
      await client.destroy();
    }
  } catch (e) {
    console.error('[WORKER] Error during shutdown:', e.message);
  }
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', (err) => {
  console.error('[WORKER] Uncaught exception:', err);
  shutdown('uncaughtException');
});

console.log('[WORKER] Initialized. Waiting for QR or existing session...');
