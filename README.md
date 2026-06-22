# WhatsApp Linked-Device AI CRM (Ollama Unfiltered)

Local, private, direct-tone WhatsApp business AI agent + Postgres memory.  
Uses your phone's WhatsApp Business via Linked Devices (multi-device). No cloud WA API.

**Fully functional end-to-end with auto-reply for safe messages + escalation safety valve.**

## Quick Start

### 1. Prerequisites
- Docker + Docker Compose
- Node.js 20+
- Ollama installed (https://ollama.com) — or use the one in docker
- WhatsApp Business app on your phone

### 2. Clone / Setup Folder
This whole directory is the complete project.

```bash
cd "whats app bott "   # or rename the folder to whatsapp-ai-crm

cp .env.example .env
# (optional) edit .env
```

### 3. Start Infrastructure
```bash
npm run docker:infra
# or directly (modern):
docker compose -f infra/docker-compose.yml up -d
# or legacy:
docker-compose -f infra/docker-compose.yml up -d
```

Check:
```bash
docker ps
```

### 4. Setup Ollama Model (recommended on host for speed/GPU)
```bash
ollama pull llama3.1:8b
# or smaller: ollama pull llama3.2:3b

ollama create direct-crm-agent -f Modelfile
```

Test:
```bash
ollama run direct-crm-agent "Customer says: Where is my order? Be direct."
```

(If you want to use docker Ollama only: `docker exec -it whatsapp-ai-crm-ollama ollama pull ...` and create there.)

### 5. Install Dependencies
From project root:

```bash
npm run install:all
# or manually per package if needed
```

### 6. Run Everything (recommended: single command)

The easiest way — one command to rule them all:
```bash
npm run dev
```

This will:
- Start/ensure Docker infra (Postgres + Redis)
- Ensure the Ollama `direct-crm-agent` model exists (auto-runs setup if missing)
- Clean up any stale ports or browser sessions from previous runs
- Launch **both** the API server and WhatsApp worker in parallel (with nice labeled output)

Separate terminals (if you prefer separate logs):
```bash
# Terminal A
npm run dev:api

# Terminal B
npm run dev:worker
```

(The worker script auto-cleans port 3001 + puppeteer/Chrome locks.)

You should see Postgres connected + servers running.

### 7. Test the Full Loop

1. Send a WhatsApp message from another phone (or your own secondary) to the Business number that is linked.
2. Watch logs:
   - Worker receives → forwards
   - API loads memory, calls Ollama
   - Validator + safety
   - If safe: outbound send triggered automatically via worker
3. You get a direct, unfiltered reply on WhatsApp.

Safe test via curl (tests the AI brain + memory + safety, **no real WA send** because it uses a fake ID):
```bash
curl -X POST http://localhost:3000/api/test \
  -H "Content-Type: application/json" \
  -H "x-internal-secret: dev-secret-change-me" \
  -d '{"message": "Where is my order #4521?"}'
```

For full loop test (including real outbound send): Send a **real text message** from another phone to the WhatsApp Business number you linked.
```

Good. 

To clean the compose warning, the user saw the orphan.

Now, also, perhaps add a command in package.json for clean infra.

But optional.

Now, since the code is updated, the user will need to restart the api and worker for the changes to take effect (the improved logging and skipSend).

For the "t" error, with the new logging `console.error('[WORKER] /send error:', e);` next time we will see the full object or stack, which will help if it's a WA internal error.

Also, recommend for flaky client: re-link if sends don't work on real msgs.

Now, the zshrc: they ran the sed, but to make it take effect, they may need to `source ~/.zshrc` or open new terminal.

The sed command they ran was correct.

In one of the cd they used escaped, etc.

Also, in the first attempts, the docker sock was not available — probably Docker Desktop was not running at first attempt.

Then it worked.

The model create was done on native.

When docker ollama was started, it caused 404 until cleaned.

Now state should be good.

For the response: since the query is the log, give a summary of what happened and the commands to run now to have a clean working system, and how to test the full thing with a real message.

Also, tell them to restart the two node processes after the code is updated (I updated the files).

Since this is the AI, the files are updated in the workspace.

User needs to restart `npm run dev:worker` and `npm run dev:api` (kill the old ones first if running).

To clean orphan:

docker compose -f infra/docker-compose.yml down --remove-orphans

Then if needed npm run docker:infra (but since they just did, and containers are up from the last command).

In the paste the last action was the down+infra (with orphan warn).

To clean the orphan container:

The command with --remove-orphans will remove the old whatsapp-ai-crm-ollama container.

Yes.

Since ollama container is not wanted, good to remove it.

Also, the volumes for ollama_data will stay, harmless.

To test if worker send health:

We can add or suggest curl http://localhost:3001/health after worker ready.

Yes.

Now, craft the final answer.
View state:
```bash
curl http://localhost:3000/api/customer/test@c.us -H "x-internal-secret: dev-secret-change-me"
```

Escalated queue:
```bash
curl http://localhost:3000/api/escalated -H "x-internal-secret: dev-secret-change-me"
```

Resolve one:
```bash
curl -X POST http://localhost:3000/api/resolve/test@c.us -H "x-internal-secret: dev-secret-change-me"
```

## Key Safety Features (Built-in)
- Never promises specific dates, refunds, or "guaranteed" things.
- Over-promise patterns are detected and neutralized.
- Keywords like "lawyer", "manager", "chargeback", "scam" → immediate escalation. No AI reply, human flag set in DB.
- Escalated customers get no further auto-replies until you clear the flag via `/api/resolve`.

## Architecture
- `apps/whatsapp-worker` — Pure I/O with whatsapp-web.js. Forwards inbound, accepts `/send` for outbound. Owns the WA session.
- `apps/api-server` + `orchestrator.js` — The brain: memory, AI call, validation, escalation logic, triggers send.
- `packages/database` — Postgres helpers + schema (customers, messages, memories).
- `packages/ai-agent` — Thin Ollama client.
- `infra/docker-compose.yml` — Postgres + Redis + Ollama (ready for queues later).
- `Modelfile` — Strict direct-tone unfiltered personality.

## Next (as noted in brief)
- Redis + BullMQ proper queues (currently direct HTTP)
- Vector memory (pgvector)
- Intent + tool calling (inventory, order lookup, etc.)
- Admin UI for handoffs + memory editing
- Media support, better session encryption

## Production Notes
- Change `INTERNAL_API_SECRET` in .env
- Run under PM2 or Docker
- Backup the `.wwebjs_auth` folder (or encrypt it)
- Monitor linked device status in WhatsApp app weekly
- Use a dedicated business phone number

## Troubleshooting
- **Port 3001 in use (EADDRINUSE) or "browser is already running"**: Run `npm run kill-worker` (or the command in the error). This kills the node on 3001 and any stuck puppeteer/Chrome processes holding the `.wwebjs_auth/session` lock.
  - If still stuck: `rm -rf apps/whatsapp-worker/.wwebjs_auth` (WARNING: you will have to re-scan the QR next time).
- QR not scanning / "client not ready": kill the worker, delete `.wwebjs_auth/`, restart.
- DB connection issues: ensure `docker compose ... up -d`, then `npm run db:schema` if needed.
- Ollama model not found: make sure you ran `ollama create direct-crm-agent -f Modelfile` and the name matches .env.
- Long first reply: model is loading into RAM.

You now have a complete, local, private, blunt AI WhatsApp CRM agent.

Send a message and watch it work.
