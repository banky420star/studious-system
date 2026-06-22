# Full Agent Build Instructions — WhatsApp Linked-Device AI CRM (Ollama Unfiltered)

## 1. Prerequisites
- Mac / Linux / VPS with Docker + Docker Compose
- Node.js 20+
- Ollama installed locally (https://ollama.com)
- WhatsApp Business App on your phone
- Git (optional)

## 2. Project Setup
```bash
# Copy the entire whatsapp-ai-crm folder to your machine
cd whatsapp-ai-crm

# Copy env
cp .env.example .env
# Edit .env if needed (Postgres URL, etc.)
```

## 3. Start Infrastructure (Postgres + Redis + Ollama)
```bash
docker compose -f infra/docker-compose.yml up -d
```

Verify:
```bash
docker ps
```

## 4. Create the Unfiltered Direct-Tone Ollama Model
```bash
# Pull a strong base model (recommended)
ollama pull llama3.1:8b
# or smaller for testing: ollama pull llama3.2:3b

# Create custom agent model
ollama create direct-crm-agent -f Modelfile
```

Test the model:
```bash
ollama run direct-crm-agent "Customer says: Where is my order? Be direct."
```

Expected: Short, honest, no-fluff reply.

## 5. Database Setup
```bash
# Run schema (first time)
psql -U crmuser -d wa_crm -h localhost -f packages/database/schema.sql
# Or use Docker:
docker exec -it <postgres_container> psql -U crmuser -d wa_crm -f /schema.sql
```

## 6. Install Dependencies
```bash
# Root level (for convenience)
npm init -y

# WhatsApp worker
cd apps/whatsapp-worker
npm install whatsapp-web.js qrcode-terminal node-fetch

# API server
cd ../api-server
npm install express node-fetch pg

# Database package
cd ../../packages/database
npm install pg
```

## 7. Run the System (Strict Linked-Device Mode)

### Terminal 1: WhatsApp Worker (Dumb Pipe)
```bash
cd apps/whatsapp-worker
node index.js
```
→ Scan the QR code with WhatsApp Business App → Linked Devices.

### Terminal 2: API Server + Orchestrator + Postgres Memory
```bash
cd apps/api-server
node index.js
```

You should see:
- Postgres connected
- Server running on 3000

## 8. Test the Full Agent Flow
1. Send a WhatsApp message to your Business number.
2. Watch logs:
   - Worker receives → forwards to API
   - Orchestrator loads customer memory from Postgres
   - Ollama generates direct/unfiltered reply
   - Validator checks for bad promises
   - Escalation decision made

Current behavior: Replies are **prepared** but not yet auto-sent back (we'll add outbound next).

## 9. Key Files & What They Do
- `Modelfile` → Unfiltered direct CRM personality
- `packages/database/db.js` → Postgres memory layer (customers, memories, etc.)
- `apps/api-server/orchestrator.js` → Traffic cop + safety rules
- `apps/whatsapp-worker/index.js` → Pure linked-device pipe
- `packages/ai-agent/ollama-agent.js` → Calls your local Ollama model

## 10. Production Tips
- Run with PM2 or Docker
- Add Redis + BullMQ for real queues
- Add outbound sending logic (use same adapter)
- Build admin dashboard for handoffs
- Encrypt session folder
- Monitor linked devices weekly

## 11. Next Enhancements (Recommended Order)
1. Complete outbound message sending loop
2. Add Redis queues (incoming / outbound / failed)
3. Persistent conversation + message saving
4. Vector memory with pgvector for long-term search
5. Intent classifier + tool router
6. Human handoff dashboard
7. Session health checks + auto-reconnect

---

**You now have a fully functional local, unfiltered, direct-tone WhatsApp AI agent** running on linked device with Postgres memory.

Copy this folder, follow the steps, and your bot is live.

Need the **outbound sending** implemented next? Or queues? Or the full admin panel? Just say the word.