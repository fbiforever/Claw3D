"use strict";

/**
 * BG Intelligence Gateway Adapter for Claw3D
 *
 * Bridges the BG Intelligence OSINT/CRM backend (FastAPI, port 8001) to the
 * Claw3D 3D office protocol, so all swarm agents appear as animated workers.
 *
 * Chat agents (MACOL-OMEGA personas):
 *   TITANIS  — Intelligence Fusion Core
 *   OBSYR    — OSINT & Risk Signals
 *   STRATYX  — Strategic Command
 *   STEALTHX — Covert Intelligence / Red Team
 *
 * Swarm background agents (visible in 3D office, animated when active):
 *   Aria (Geopolitical) · Nova (OSINT Scout) · Shade (Dark Web) · Hawk (Air Intel)
 *   Marina (Maritime)   · Rex (Entity Risk)  · Finn (Finance)  · Claude (Superpowers)
 *
 * Environment variables (set in claw3d/.env.local):
 *   BG_INTELLIGENCE_API_URL    Backend URL    (default: http://localhost:8001)
 *   BG_INTELLIGENCE_API_TOKEN  Bearer token   (required for API calls)
 *   BG_ADAPTER_PORT            WS port        (default: 18790)
 */

const http = require("http");
const https = require("https");
const { randomUUID } = require("crypto");
const { WebSocketServer } = require("ws");
const fs = require("fs");
const path = require("path");

// ─────────────────────────────────────────────
// .env loader
// ─────────────────────────────────────────────
function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const [, key, rawVal] = m;
    if (process.env[key] !== undefined) continue;
    let v = rawVal.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[key] = v;
  }
}
loadEnv(path.join(process.cwd(), ".env.local"));
loadEnv(path.join(process.cwd(), ".env"));

const BG_API_URL = (process.env.BG_INTELLIGENCE_API_URL || "http://localhost:8001").replace(/\/$/, "");
const BG_API_TOKEN = process.env.BG_INTELLIGENCE_API_TOKEN || "";
const ADAPTER_PORT = parseInt(process.env.BG_ADAPTER_PORT || "18790", 10);
const MAIN_KEY = "main";

// ─────────────────────────────────────────────
// Agent roster
// ─────────────────────────────────────────────

/** MACOL-OMEGA chat personas — full LLM conversations */
const CHAT_AGENTS = [
  { id: "titanis",  name: "TITANIS",  role: "Intelligence Fusion Core",      emoji: "🔮", persona: "TITANIS",  workspace: "/office/titanis" },
  { id: "obsyr",    name: "OBSYR",    role: "OSINT & Risk Signals",           emoji: "👁",  persona: "OBSYR",    workspace: "/office/obsyr" },
  { id: "stratyx",  name: "STRATYX",  role: "Strategic Command",              emoji: "⚡", persona: "STRATYX",  workspace: "/office/stratyx" },
  { id: "stealthx", name: "STEALTHX", role: "Covert Intelligence / Red Team", emoji: "🕵", persona: "STEALTHX", workspace: "/office/stealthx" },
];

/** Swarm background workers — animated in the 3D office */
const SWARM_AGENTS = [
  { id: "geo_intel",    name: "Aria",   role: "Geopolitical Analyst",     emoji: "🌍", agent_type: "geopolitical", workspace: "/office/geo" },
  { id: "osint_scout",  name: "Nova",   role: "OSINT Scout",               emoji: "🔍", agent_type: "osint",        workspace: "/office/osint" },
  { id: "dark_scout",   name: "Shade",  role: "Dark Web Scout",            emoji: "🌐", agent_type: "darkweb",      workspace: "/office/dark" },
  { id: "air_intel",    name: "Hawk",   role: "Air Intelligence",          emoji: "✈", agent_type: "air_intel",    workspace: "/office/air" },
  { id: "maritime",     name: "Marina", role: "Maritime Intelligence",     emoji: "🚢", agent_type: "maritime",     workspace: "/office/maritime" },
  { id: "entity_risk",  name: "Rex",    role: "Entity Risk Analyst",       emoji: "⚠", agent_type: "entity_risk",  workspace: "/office/risk" },
  { id: "finance",      name: "Finn",   role: "Finance & Economics",       emoji: "💹", agent_type: "finance",      workspace: "/office/finance" },
  { id: "superpowers",  name: "Claude", role: "Superpowers Brainstorming", emoji: "🧠", agent_type: "superpowers",  workspace: "/office/brainstorm" },
];

const ALL_AGENTS = [...CHAT_AGENTS, ...SWARM_AGENTS];
const agentRegistry = new Map(ALL_AGENTS.map((a) => [a.id, a]));
const CHAT_AGENT_IDS = new Set(CHAT_AGENTS.map((a) => a.id));
const DEFAULT_AGENT_ID = "titanis";

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────
const conversationHistory = new Map();
const sessionSettings = new Map();
const activeRuns = new Map();
const activeSendEventFns = new Set();
let seqCounter = 0;

// ─────────────────────────────────────────────────────────────────────────────
// History persistence
// ─────────────────────────────────────────────────────────────────────────────
const HISTORY_DIR = path.join(
  process.env.USERPROFILE || process.env.HOME || "/tmp",
  ".bg-intelligence"
);
const HISTORY_FILE = path.join(HISTORY_DIR, "claw3d-history.json");

function saveHistory() {
  try {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
    const data = Object.fromEntries(conversationHistory);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch {}
}

function loadHistory() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return;
    const data = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
    for (const [k, v] of Object.entries(data)) conversationHistory.set(k, v);
    console.log(`[bg-adapter] Loaded conversation history for ${Object.keys(data).length} session(s).`);
  } catch {}
}

function getHistory(sessionKey) {
  if (!conversationHistory.has(sessionKey)) conversationHistory.set(sessionKey, []);
  return conversationHistory.get(sessionKey);
}

function clearHistory(sessionKey) {
  conversationHistory.delete(sessionKey);
  saveHistory();
}

// ─────────────────────────────────────────────────────────────────────────────
// Protocol helpers
// ─────────────────────────────────────────────────────────────────────────────
function randomId() {
  return randomUUID().replace(/-/g, "");
}

function sessionKeyFor(agentId) {
  return `agent:${agentId}:${MAIN_KEY}`;
}

function resOk(id, payload) {
  return { type: "res", id, ok: true, payload: payload ?? {} };
}

function resErr(id, code, message) {
  return { type: "res", id, ok: false, error: { code, message } };
}

function broadcastEvent(frame) {
  for (const send of activeSendEventFns) {
    try { send(frame); } catch {}
  }
}

function agentListPayload() {
  return [...agentRegistry.values()].map((agent) => ({
    id: agent.id,
    name: agent.name,
    workspace: agent.workspace,
    identity: { name: agent.name, emoji: agent.emoji },
    role: agent.role,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// BG Intelligence backend HTTP client
// ─────────────────────────────────────────────────────────────────────────────
async function bgRequest(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(BG_API_URL + urlPath);
    const mod = url.protocol === "https:" ? https : http;
    const bodyStr = body ? JSON.stringify(body) : null;
    const req = mod.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest",
          ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
          ...(token || BG_API_TOKEN ? { Authorization: `Bearer ${token || BG_API_TOKEN}` } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      }
    );
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Chat routing
// ─────────────────────────────────────────────────────────────────────────────
async function sendChatToBg(agentId, message, sessionKey, token) {
  const agent = agentRegistry.get(agentId);
  let persona = "TITANIS";
  let chatMessage = message;

  if (agent) {
    if (CHAT_AGENT_IDS.has(agentId)) {
      // Direct MACOL-OMEGA persona chat
      persona = agent.persona;
    } else {
      // Swarm agent chat — route to TITANIS with specialist framing
      persona = "TITANIS";
      chatMessage =
        `[You are acting as ${agent.name}, the ${agent.role} specialist. ` +
        `Answer with the deep expertise and perspective of this role.]\n\n${message}`;
    }
  }

  const res = await bgRequest(
    "POST",
    "/api/agents/chat",
    { message: chatMessage, agent: persona, session_id: sessionKey, flags: {} },
    token
  );

  if (res.status !== 200) {
    throw new Error(`Backend returned HTTP ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`);
  }
  return String(res.body?.reply || "");
}

// ─────────────────────────────────────────────────────────────────────────────
// Method handler
// ─────────────────────────────────────────────────────────────────────────────
async function handleMethod(method, params, id, sendEvent, userToken) {
  const p = params || {};

  switch (method) {

    // ── Agents ────────────────────────────────────────────────────────────────
    case "agents.list":
      return resOk(id, { defaultId: DEFAULT_AGENT_ID, mainKey: MAIN_KEY, agents: agentListPayload() });

    case "agents.create": {
      const name = (typeof p.name === "string" && p.name.trim()) ? p.name.trim() : "Custom Agent";
      const role = typeof p.role === "string" ? p.role.trim() : "";
      const slug  = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "custom";
      const agentId = `custom-${slug}-${randomId().slice(0, 6)}`;
      agentRegistry.set(agentId, {
        id: agentId, name, role, emoji: "🤖", persona: "TITANIS",
        workspace: `/office/custom/${slug}`, isCustom: true,
      });
      broadcastEvent({ type: "event", event: "presence",
        payload: { sessions: { recent: [], byAgent: [] } } });
      return resOk(id, { agentId, name, workspace: `/office/custom/${slug}` });
    }

    case "agents.update": {
      const agentId = typeof p.agentId === "string" ? p.agentId.trim() : "";
      const agent = agentRegistry.get(agentId);
      if (!agent) return resErr(id, "not_found", `Agent ${agentId} not found`);
      if (typeof p.name === "string" && p.name.trim()) agent.name = p.name.trim();
      if (typeof p.role === "string") agent.role = p.role.trim();
      return resOk(id, { ok: true, removedBindings: 0 });
    }

    case "agents.delete": {
      const agentId = typeof p.agentId === "string" ? p.agentId.trim() : "";
      const agent = agentRegistry.get(agentId);
      if (agentId && agent?.isCustom) {
        agentRegistry.delete(agentId);
        clearHistory(sessionKeyFor(agentId));
      }
      return resOk(id, { ok: true, removedBindings: 0 });
    }

    // ── Sessions ──────────────────────────────────────────────────────────────
    case "sessions.list": {
      const sessions = [...agentRegistry.values()].map((agent) => {
        const sessionKey = sessionKeyFor(agent.id);
        const history = getHistory(sessionKey);
        return {
          key: sessionKey,
          agentId: agent.id,
          name: sessionSettings.get(sessionKey)?.name || agent.name,
          updatedAt: history.length > 0 ? Date.now() : null,
          messageCount: history.length,
        };
      });
      return resOk(id, { sessions });
    }

    case "sessions.preview": {
      const key = typeof p.sessionKey === "string" ? p.sessionKey : "";
      return resOk(id, { sessionKey: key, preview: getHistory(key).slice(-3) });
    }

    case "sessions.patch": {
      const key = typeof p.sessionKey === "string" ? p.sessionKey : "";
      sessionSettings.set(key, { ...(sessionSettings.get(key) || {}), ...(p.settings || {}) });
      return resOk(id, { ok: true });
    }

    case "sessions.reset": {
      const key = typeof p.sessionKey === "string" ? p.sessionKey : "";
      clearHistory(key);
      return resOk(id, { ok: true });
    }

    // ── Chat ──────────────────────────────────────────────────────────────────
    case "chat.send": {
      const sessionKey = typeof p.sessionKey === "string"
        ? p.sessionKey
        : sessionKeyFor(DEFAULT_AGENT_ID);
      const userMessage = typeof p.message === "string" ? p.message.trim() : "";
      const runId = (typeof p.idempotencyKey === "string" && p.idempotencyKey)
        ? p.idempotencyKey
        : randomId();

      if (!userMessage) return resOk(id, { status: "no-op", runId });

      const sessionAgentId = sessionKey.startsWith("agent:")
        ? sessionKey.split(":")[1]
        : DEFAULT_AGENT_ID;

      let aborted = false;
      activeRuns.set(runId, { runId, sessionKey, agentId: sessionAgentId, abort: () => { aborted = true; } });

      const emitChat = (state, extra = {}) =>
        sendEvent({ type: "event", event: "chat", seq: seqCounter++,
          payload: { runId, sessionKey, state, ...extra } });

      const emitPresence = () =>
        broadcastEvent({ type: "event", event: "presence",
          payload: { sessions: {
            recent: [{ key: sessionKey, updatedAt: Date.now() }],
            byAgent: [{ agentId: sessionAgentId, recent: [{ key: sessionKey, updatedAt: Date.now() }] }],
          }}});

      (async () => {
        try {
          emitChat("start");
          emitPresence();

          const history = getHistory(sessionKey);
          history.push({ role: "user", content: userMessage, ts: Date.now() });

          let reply = "";
          try {
            reply = await sendChatToBg(sessionAgentId, userMessage, sessionKey, userToken);
          } catch (err) {
            reply = `⚠️ BG Intelligence backend unreachable: ${err.message}\n\nMake sure the backend is running at ${BG_API_URL}`;
          }

          if (aborted) return;

          // Stream in ~40-char chunks for natural typing effect
          const CHUNK = 40;
          for (let i = 0; i < reply.length; i += CHUNK) {
            if (aborted) break;
            emitChat("delta", { delta: reply.slice(i, i + CHUNK) });
            await new Promise((r) => setTimeout(r, 14));
          }

          history.push({ role: "assistant", content: reply, ts: Date.now() });
          saveHistory();

          emitChat("done", { message: { role: "assistant", content: reply } });
          emitPresence();
        } catch (err) {
          emitChat("error", { error: err.message });
        } finally {
          activeRuns.delete(runId);
        }
      })();

      return resOk(id, { status: "started", runId });
    }

    case "chat.abort": {
      const runId = typeof p.runId === "string" ? p.runId.trim() : "";
      const sessionKey = typeof p.sessionKey === "string" ? p.sessionKey.trim() : "";
      let aborted = 0;
      if (runId) {
        const h = activeRuns.get(runId);
        if (h) { h.abort(); activeRuns.delete(runId); aborted++; }
      } else if (sessionKey) {
        for (const [rid, h] of activeRuns.entries()) {
          if (h.sessionKey === sessionKey) { h.abort(); activeRuns.delete(rid); aborted++; }
        }
      }
      return resOk(id, { ok: true, aborted });
    }

    case "chat.history": {
      const key = typeof p.sessionKey === "string" ? p.sessionKey : sessionKeyFor(DEFAULT_AGENT_ID);
      return resOk(id, { sessionKey: key, messages: getHistory(key) });
    }

    case "agent.wait": {
      const { runId, timeoutMs = 30000 } = p;
      const start = Date.now();
      while (activeRuns.has(runId) && Date.now() - start < timeoutMs) {
        await new Promise((r) => setTimeout(r, 50));
      }
      return resOk(id, { status: activeRuns.has(runId) ? "running" : "done" });
    }

    // ── Status ────────────────────────────────────────────────────────────────
    case "status": {
      const recent = [...agentRegistry.keys()].flatMap((agentId) => {
        const key = sessionKeyFor(agentId);
        const h = getHistory(key);
        return h.length > 0 ? [{ key, updatedAt: Date.now() }] : [];
      });
      return resOk(id, {
        sessions: {
          recent,
          byAgent: [...agentRegistry.keys()].map((agentId) => ({
            agentId,
            recent: recent.filter((e) => e.key.includes(`:${agentId}:`)),
          })),
        },
      });
    }

    // ── Config (stub — BG Intelligence manages its own config) ────────────────
    case "config.get":
      return resOk(id, { exists: false, config: { model: "bg-intelligence", systemPrompt: "" } });
    case "config.set":
    case "config.patch":
      return resOk(id, { ok: true });

    // ── Files / approvals / cron (stubs) ─────────────────────────────────────
    case "agents.files.get":       return resOk(id, { files: [] });
    case "agents.files.set":       return resOk(id, { ok: true });
    case "exec.approvals.get":     return resOk(id, { approvals: [] });
    case "exec.approvals.set":
    case "exec.approval.resolve":  return resOk(id, { ok: true });
    case "cron.list":              return resOk(id, { crons: [] });
    case "cron.add":
    case "cron.remove":
    case "cron.patch":
    case "cron.run":               return resOk(id, { ok: true });

    // ── Skills / models ───────────────────────────────────────────────────────
    case "skills.status":
      return resOk(id, { skills: [] });

    case "models.list":
      return resOk(id, {
        models: [
          { id: "titanis",  name: "TITANIS — Intelligence Fusion Core",      provider: "bg-intelligence" },
          { id: "obsyr",    name: "OBSYR — OSINT & Risk Signals",            provider: "bg-intelligence" },
          { id: "stratyx",  name: "STRATYX — Strategic Command",             provider: "bg-intelligence" },
          { id: "stealthx", name: "STEALTHX — Covert Intelligence",          provider: "bg-intelligence" },
          { id: "superpowers", name: "Superpowers Brainstorming (Claude)",   provider: "bg-intelligence" },
        ],
      });

    case "wake":
      return resOk(id, { ok: true });

    default:
      return resOk(id, {});
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket server
// ─────────────────────────────────────────────────────────────────────────────
function startAdapter() {
  loadHistory();

  const httpServer = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("BG Intelligence Claw3D Gateway Adapter — online\n");
  });

  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (ws) => {
    let connected = false;
    let userToken = BG_API_TOKEN;

    const send = (frame) => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(JSON.stringify(frame));
    };

    const sendEventFn = (frame) => {
      if (frame.type === "event" && typeof frame.seq !== "number") frame.seq = seqCounter++;
      send(frame);
    };

    activeSendEventFns.add(sendEventFn);
    // Challenge nonce (claw3D expects this on connect)
    send({ type: "event", event: "connect.challenge", payload: { nonce: randomId() } });

    ws.on("message", async (raw) => {
      let frame;
      try { frame = JSON.parse(raw.toString("utf8")); } catch { return; }
      if (!frame || typeof frame !== "object" || frame.type !== "req") return;
      const { id, method, params } = frame;
      if (typeof id !== "string" || typeof method !== "string") return;

      if (method === "connect") {
        connected = true;
        if (params?.token) userToken = params.token;

        send({
          type: "res", id, ok: true,
          payload: {
            type: "hello-ok",
            protocol: 3,
            adapterType: "bg-intelligence",
            features: {
              methods: [
                "agents.list", "agents.create", "agents.update", "agents.delete",
                "sessions.list", "sessions.preview", "sessions.patch", "sessions.reset",
                "chat.send", "chat.abort", "chat.history", "agent.wait",
                "status", "config.get", "config.set", "config.patch",
                "agents.files.get", "agents.files.set",
                "exec.approvals.get", "exec.approvals.set", "exec.approval.resolve",
                "wake", "skills.status", "models.list",
                "cron.list", "cron.add", "cron.remove", "cron.patch", "cron.run",
              ],
              events: ["chat", "presence", "heartbeat"],
            },
            snapshot: {
              health: {
                agents: [...agentRegistry.values()].map((a) => ({
                  agentId: a.id,
                  name: a.name,
                  isDefault: a.id === DEFAULT_AGENT_ID,
                })),
                defaultAgentId: DEFAULT_AGENT_ID,
              },
              sessionDefaults: { mainKey: MAIN_KEY },
            },
            auth: { role: "operator", scopes: ["operator.admin"] },
            policy: { tickIntervalMs: 30000 },
          },
        });
        return;
      }

      if (!connected) {
        send(resErr(id, "not_connected", "Send connect first."));
        return;
      }

      try {
        send(await handleMethod(method, params, id, sendEventFn, userToken));
      } catch (err) {
        send(resErr(id, "internal_error", err instanceof Error ? err.message : "Internal error"));
      }
    });

    // 30-second heartbeat
    const hb = setInterval(() => {
      if (ws.readyState !== ws.OPEN) { clearInterval(hb); return; }
      sendEventFn({ type: "event", event: "heartbeat", payload: { ts: Date.now() } });
    }, 30_000);

    ws.on("close", () => { activeSendEventFns.delete(sendEventFn); clearInterval(hb); });
    ws.on("error", () => { activeSendEventFns.delete(sendEventFn); clearInterval(hb); });
  });

  httpServer.listen(ADAPTER_PORT, "127.0.0.1", () => {
    console.log("──────────────────────────────────────────────");
    console.log(" BG Intelligence Claw3D Gateway Adapter");
    console.log(`  WebSocket : ws://127.0.0.1:${ADAPTER_PORT}`);
    console.log(`  Backend   : ${BG_API_URL}`);
    console.log(`  Agents    : ${CHAT_AGENTS.length} chat personas + ${SWARM_AGENTS.length} swarm workers`);
    console.log("──────────────────────────────────────────────");
    console.log(" Connect claw3D to: ws://localhost:" + ADAPTER_PORT);
    console.log(" Select 'Custom / Other' provider in the connect screen");
    console.log("──────────────────────────────────────────────");

    // Activity polling — animates swarm agents in the 3D office
    const agentTypeToId = Object.fromEntries(
      SWARM_AGENTS.filter((a) => a.agent_type).map((a) => [a.agent_type, a.id])
    );

    async function pollActivity() {
      if (activeSendEventFns.size === 0) return; // nobody connected, skip
      try {
        const res = await bgRequest("GET", "/api/agents/claw3d/activity", null, BG_API_TOKEN);
        if (res.status !== 200 || !res.body?.activity) return;
        const activity = res.body.activity;
        for (const [agentType, info] of Object.entries(activity)) {
          const agentId = agentTypeToId[agentType];
          if (!agentId || !info.is_active) continue;
          const sessionKey = sessionKeyFor(agentId);
          broadcastEvent({
            type: "event", event: "presence",
            payload: {
              sessions: {
                recent: [{ key: sessionKey, updatedAt: Date.now() }],
                byAgent: [{ agentId, recent: [{ key: sessionKey, updatedAt: Date.now() }] }],
              },
            },
          });
        }
      } catch {
        // Backend not available — skip silently
      }
    }

    // Poll every 30 seconds (staggered from heartbeat)
    setInterval(pollActivity, 30_000);
    setTimeout(pollActivity, 5_000); // initial poll after 5s
  });
}

if (require.main === module) {
  startAdapter();
}

module.exports = { handleMethod, startAdapter };
