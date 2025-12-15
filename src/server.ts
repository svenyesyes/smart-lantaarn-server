import express, { Request, Response } from "express";
import path from "path";
import { fileURLToPath } from "url";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import LampEngine, { Lamp, ActivateStreetOptions } from "./LampEngine.js";
import Backend from "./backend.js";
import fs from "fs";
import os from "os";
import dgram from "dgram";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load lamps from JSON settings
const settingsPath = path.join(__dirname, "../data/settings.json");
let settingsRaw = fs.readFileSync(settingsPath, "utf-8");
let settings = JSON.parse(settingsRaw) as { lamps: Lamp[]; spilloverDepth?: number; pulseColor?: string; defaultOnColor?: string; activationDurationMs?: number };
// Normalize potential malformed keys from settings.json (e.g., leading space)
if ((settings as any)[" activationDurationMs"] && !settings.activationDurationMs) {
  try { settings.activationDurationMs = Number((settings as any)[" activationDurationMs"]); } catch {}
}
const lamps: Lamp[] = settings.lamps;
const SPILLOVER_DEPTH: number = typeof settings.spilloverDepth === "number" ? settings.spilloverDepth : 0;
let PULSE_COLOR: string = typeof settings.pulseColor === "string" ? settings.pulseColor : "#60a5fa";
const ACTIVATION_DURATION_MS: number | undefined = typeof settings.activationDurationMs === "number" && settings.activationDurationMs > 0 ? settings.activationDurationMs : undefined;

// Simple 10s cache for /settings endpoint
let settingsCacheTime = 0;
function getSettingsCached() {
  const now = Date.now();
  if (now - settingsCacheTime > 10_000) {
    try {
      settingsRaw = fs.readFileSync(settingsPath, "utf-8");
      settings = JSON.parse(settingsRaw);
      if ((settings as any)[" activationDurationMs"] && !settings.activationDurationMs) {
        try { (settings as any).activationDurationMs = Number((settings as any)[" activationDurationMs"]); } catch {}
      }
      // Update pulse color used by clients fetching /settings (does not affect engine spillover)
      PULSE_COLOR = typeof settings.pulseColor === "string" ? settings.pulseColor : PULSE_COLOR;
    } catch { }
    settingsCacheTime = now;
  }
  const spill = typeof settings.spilloverDepth === "number" ? settings.spilloverDepth : SPILLOVER_DEPTH;
  const pulse = typeof settings.pulseColor === "string" ? settings.pulseColor : PULSE_COLOR;
  const defaultOnColor = typeof settings.defaultOnColor === "string" ? settings.defaultOnColor : undefined;
  const activationDurationMs = typeof settings.activationDurationMs === "number" ? settings.activationDurationMs : undefined;
  return { spilloverDepth: spill, pulseColor: pulse, defaultOnColor, activationDurationMs };
}

const engine = new LampEngine(lamps);
const backend = new Backend(engine, SPILLOVER_DEPTH, typeof settings.defaultOnColor === "string" ? settings.defaultOnColor : undefined);

const app = express();
app.use(express.json());

const publicDir = path.join(__dirname, "../public");
app.use(express.static(publicDir));

app.get("/graph", (_req: Request, res: Response) => {
  res.json(backend.getGraph());
});
app.get("/lamps", (_req: Request, res: Response) => {
  res.json(backend.getAllLamps());
});

// Update lamp metadata (name, street, connections). ID is immutable.
app.post("/lamps/:lampId/update", (req: Request, res: Response) => {
  const lampId = req.params.lampId;
  const { name, street, connections } = req.body || {};
  const l = (engine as any).lamps.get(lampId) as Lamp | undefined;
  if (!l) { res.status(404).json({ ok: false, error: "Lamp not found" }); return; }
  if (typeof name === "string") (l as any).name = name;
  if (typeof street === "string") (l as any).street = street;
  if (Array.isArray(connections)) (l as any).connections = connections.filter((x: any) => typeof x === "string");
  (engine as any).lamps.set(lampId, l);
  // Persist to settings.json
  try {
    const raw = fs.readFileSync(settingsPath, "utf-8");
    const json = JSON.parse(raw);
    if (Array.isArray(json.lamps)) {
      json.lamps = json.lamps.map((itm: any) => itm.id === lampId ? { ...itm, name: l.name, street: l.street, connections: l.connections } : itm);
      fs.writeFileSync(settingsPath, JSON.stringify(json, null, 2), "utf-8");
    }
  } catch { }
  broadcastLampStates();
  res.json({ ok: true });
});
app.post("/positions", (req: Request, res: Response) => {
  try {
    const body = req.body as Record<string, { x: number; y: number }>;
    setPositions(body);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get("/positions", (_req: Request, res: Response) => {
  res.json(positionsCache);
});

app.post("/streets/:streetId/activate", (req: Request, res: Response) => {
  const streetId = req.params.streetId;
  const { on, brightness, color } = req.body || {};
  const spillParam = req.query.spillover;
  const spillover = spillParam === undefined ? undefined : String(spillParam).toLowerCase() !== "false";

  backend.activateStreet(streetId, {
    on: on !== undefined ? Boolean(on) : undefined,
    brightness: brightness !== undefined ? Number(brightness) : undefined,
    color: typeof color === "string" ? color : undefined,
    spillover,
  });

  broadcastLampStates();
  // Send device-level activation notifications to authorized lamp sockets
  const events = engine.getEvents();
  const last = events[events.length - 1] as any;
  if (last && last.type === "street_activated" && Array.isArray(last.affectedLampIds)) {
    notifyDeviceActivation(last.affectedLampIds);
  }

  res.json({ ok: true, events: engine.getEvents() });
});

app.get("/streets/:streetId/preview", (req: Request, res: Response) => {
  const streetId = req.params.streetId;
  const spillParam = req.query.spillover;
  const spillover = spillParam === undefined ? undefined : String(spillParam).toLowerCase() !== "false";
  const ids = backend.previewStreetActivation(streetId, spillover);
  res.json({ affectedLampIds: ids, spilloverDepth: spillover === false ? 0 : SPILLOVER_DEPTH });
});

app.post("/lamps/:lampId/color", (req: Request, res: Response) => {
  const lampId = req.params.lampId;
  const { color, mode } = req.body || {};
  if (typeof color !== "string") {
    res.status(400).json({ ok: false, error: "color is required" });
    return;
  }
  backend.setLampColor(lampId, color, typeof mode === "string" ? mode : undefined);
  broadcastLampStates();
  res.json({ ok: true });
});

app.get("/", (_req: Request, res: Response) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.get("/settings", (_req: Request, res: Response) => {
  res.json(getSettingsCached());
});

// Device control: identify
app.post("/lamps/:lampId/device/identify", (req: Request, res: Response) => {
  const lampId = req.params.lampId;
  const durationMsRaw = (req.body as any)?.durationMs;
  const durationMs = typeof durationMsRaw === "number" ? durationMsRaw : Number(durationMsRaw);
  const ok = backend.sendLampIdentifyCommand(lampId, isFinite(durationMs) ? durationMs : 3000);
  if (!ok) { res.status(404).json({ ok: false, error: "Lamp connection not found" }); return; }
  res.json({ ok: true });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

let positionsCache: Record<string, { x: number; y: number }> = {};
const positionsPath = path.join(__dirname, "../data/positions.json");
try {
  const raw = fs.readFileSync(positionsPath, "utf-8");
  positionsCache = JSON.parse(raw);
} catch { }

wss.on("connection", (ws: WebSocket) => {
  ws.send(
    JSON.stringify({ type: "init", graph: engine.getLampGraph(), states: getAllLampStates(), positions: positionsCache })
  );
  // Also send current device connection status so UI can mark online dots
  try {
    const connectedIds = Array.from(lampClients.keys());
    ws.send(JSON.stringify({ type: "device_status", connectedIds }));
  } catch {}
});

function getAllLampStates() {
  const graph = engine.getLampGraph();
  return graph.nodes.map((n) => {
    const l = (engine as any).lamps.get(n.id) as Lamp;
    return { id: n.id, state: l.state };
  });
}

function broadcastLampStates() {
  const payload = JSON.stringify({ type: "update", graph: engine.getLampGraph(), states: getAllLampStates(), events: engine.getEvents() });
  wss.clients.forEach((client: WebSocket) => {
    try {
      client.send(payload);
    } catch { }
  });
}

function notifyDeviceActivation(affectedLampIds: string[]) {
  if (!Array.isArray(affectedLampIds) || affectedLampIds.length === 0) return;
  affectedLampIds.forEach((id) => {
    const client = lampClients.get(id);
    if (!client) return;
    try {
      const l = (engine as any).lamps.get(id) as Lamp | undefined;
      const state = l ? l.state : undefined;
      client.ws.send(JSON.stringify({ type: "activated", id, state }));
    } catch { }
  });
}

function setPositions(p: Record<string, { x: number; y: number }>) {
  positionsCache = p;
  try {
    fs.writeFileSync(positionsPath, JSON.stringify(positionsCache, null, 2), "utf-8");
  } catch { }
  const payload = JSON.stringify({ type: "positions", positions: positionsCache });
  wss.clients.forEach((client: WebSocket) => {
    try { client.send(payload); } catch { }
  });
}

function broadcastDeviceStatus() {
  try {
    const connectedIds = Array.from(lampClients.keys());
    const payload = JSON.stringify({ type: "device_status", connectedIds });
    wss.clients.forEach((client: WebSocket) => { try { client.send(payload); } catch { } });
  } catch { }
}

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

// Separate WebSocket for lamps on port 3090
const lampServer = http.createServer();
const lampWss = new WebSocketServer({ server: lampServer });
const LAMP_WS_PORT = 3090;

type LampClient = { id: string; ws: WebSocket };
const lampClients: Map<string, LampClient> = new Map();
const lampAuthBySocket: WeakMap<WebSocket, string> = new WeakMap();
const autoOffTimers: Map<string, NodeJS.Timeout> = new Map();

function ensureEngineLampExists(id: string) {
  const g = engine.getLampGraph();
  const exists = g.nodes.some((n) => n.id === id);
  if (exists) return;
  try {
    const placeholder = {
      id,
      street: "",
      connections: [],
      state: { on: false, brightness: 0, color: "#ffffff" },
      name: ""
    } as Lamp;
    // Directly add to engine's internal map
    (engine as any).lamps.set(id, placeholder);
  } catch {}
}

function ensureSettingsLampExists(id: string) {
  try {
    const raw = fs.readFileSync(settingsPath, "utf-8");
    const json = JSON.parse(raw);
    json.lamps = Array.isArray(json.lamps) ? json.lamps : [];
    if (!json.lamps.some((l: any) => l && l.id === id)) {
      json.lamps.push({
        id,
        street: "",
        connections: [],
        state: { on: false, brightness: 0, color: "#ffffff" },
        name: ""
      });
      fs.writeFileSync(settingsPath, JSON.stringify(json, null, 2), "utf-8");
    }
  } catch {}
}

function persistLampState(id: string, state: { on: boolean; brightness: number; color: string }) {
  try {
    const raw = fs.readFileSync(settingsPath, "utf-8");
    const json = JSON.parse(raw);
    json.lamps = Array.isArray(json.lamps) ? json.lamps : [];
    let found = false;
    json.lamps = json.lamps.map((l: any) => {
      if (l && l.id === id) {
        found = true;
        const entry: any = { ...l, state: { on: !!state.on, brightness: Number(state.brightness) || 0, color: String(state.color) } };
        // Compute explicit offAt timestamp for cross-restart auto-off
        if (ACTIVATION_DURATION_MS && entry.state.on) {
          entry.offAt = Date.now() + ACTIVATION_DURATION_MS;
          try { console.log(`[auto-off] offAt set for ${id} -> ${entry.offAt}`); } catch {}
        } else if (!entry.state.on) {
          entry.offAt = undefined;
        }
        return entry;
      }
      return l;
    });
    if (!found) {
      const entry: any = { id, street: "", connections: [], state: { on: !!state.on, brightness: Number(state.brightness) || 0, color: String(state.color) }, name: "" };
      if (ACTIVATION_DURATION_MS && entry.state.on) entry.offAt = Date.now() + ACTIVATION_DURATION_MS; else entry.offAt = undefined;
      try { if (entry.offAt) console.log(`[auto-off] offAt set for ${id} -> ${entry.offAt}`); } catch {}
      json.lamps.push(entry);
    }
    fs.writeFileSync(settingsPath, JSON.stringify(json, null, 2), "utf-8");
  } catch {}
}

// Persist state changes from the engine and send desired state to connected lamps
engine.setOnStateUpdated((lampId, state) => {
  persistLampState(lampId, state as any);
  const client = lampClients.get(lampId);
  if (client) {
    try {
      const payloadActivated = JSON.stringify({ type: "activated", id: lampId, state });
      const payloadSetState = JSON.stringify({ type: "set_state", id: lampId, state });
      client.ws.send(payloadActivated);
      client.ws.send(payloadSetState);
      console.log(`[auto-off] pushed state to ${lampId} (on=${state.on})`);
    } catch {}
  }
  // Schedule auto-off if activation duration is configured
  try {
    if (ACTIVATION_DURATION_MS && state.on) {
      const existing = autoOffTimers.get(lampId);
      if (existing) { try { clearTimeout(existing); } catch {} }
      const t = setTimeout(() => {
        try {
          engine.setLampState(lampId, { on: false, brightness: 0, color: "#ffffff" });
          broadcastLampStates();
          console.log(`[auto-off] turned off ${lampId} after ${ACTIVATION_DURATION_MS}ms`);
        } catch {}
      }, ACTIVATION_DURATION_MS);
      autoOffTimers.set(lampId, t);
    } else if (ACTIVATION_DURATION_MS && !state.on) {
      const existing = autoOffTimers.get(lampId);
      if (existing) { try { clearTimeout(existing); } catch {} autoOffTimers.delete(lampId); }
    }
  } catch {}
});

// Provide Backend with a way to send messages to lamps by ID
backend.setLampSender((id: string, msg: any) => {
  const client = lampClients.get(id);
  if (!client) return false;
  try { client.ws.send(JSON.stringify(msg)); return true; } catch { return false; }
});

function generateHexId(len = 8): string {
  let s = "";
  for (let i = 0; i < len; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

function isIdInUse(id: string): boolean {
  if (lampClients.has(id)) return true;
  const g = engine.getLampGraph();
  return g.nodes.some((n) => n.id === id);
}

// Heartbeat tracking for lamp sockets to detect unexpected disconnects
type LampWS = WebSocket & { isAlive?: boolean };

function markDeadLamp(ws: WebSocket) {
  try {
    // remove any mapping referencing this ws
    for (const [id, client] of lampClients.entries()) {
      if (client.ws === ws) lampClients.delete(id);
    }
    broadcastDeviceStatus();
  } catch {}
}

lampWss.on("connection", (wsRaw: WebSocket, req: any) => {
  const ws = wsRaw as LampWS;
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  try {
    const ip = req?.socket?.remoteAddress ?? req?.connection?.remoteAddress ?? "-";
    console.log(`[lamp-ws CONNECT] ip=${ip}`);
  } catch { }
  // Debug: wrap outbound sends for this lamp socket
  const __originalSend = ws.send.bind(ws);
  (ws as any).send = ((data: any, ...args: any[]) => {
    try {
      const currentId = lampAuthBySocket.get(ws);
      const payloadStr = typeof data === "string"
        ? data
        : Buffer.isBuffer(data)
          ? data.toString()
          : JSON.stringify(data);
      let outType: any = undefined;
      try { outType = JSON.parse(payloadStr)?.type; } catch { }
      console.log(`[lamp-ws OUT] id=${currentId ?? '-'} type=${outType ?? '-'} data=${payloadStr}`);
    } catch { }
    return __originalSend(data as any, ...args as any);
  }) as any;

  ws.on("message", (raw: Buffer) => {
    ws.isAlive = true;
    // Debug: log inbound lamp messages
    try {
      const txt = raw.toString();
      const currentId = lampAuthBySocket.get(ws);
      let inType: any = undefined;
      let idForLog: any = currentId;
      try {
        const parsed = JSON.parse(txt);
        inType = parsed?.type;
        idForLog = idForLog || parsed?.id;
      } catch { }
      console.log(`[lamp-ws IN] id=${idForLog ?? '-'} type=${inType ?? '-'} data=${txt}`);
    } catch { }
    try {
      const msg = JSON.parse(raw.toString());
      // Legacy: explicit register with provided id
      if (msg && msg.type === "register" && typeof msg.id === "string") {
        const id = msg.id;
        lampClients.set(id, { id, ws });
        ensureSettingsLampExists(id);
        ensureEngineLampExists(id);
        ws.send(JSON.stringify({ type: "registered", id }));
        return;
      }
      // New: request a unique ID
      if (msg && msg.type === "request_id") {
        let id = generateHexId(8);
        let guard = 0;
        while (isIdInUse(id) && guard++ < 1000) id = generateHexId(8);
        ws.send(JSON.stringify({ type: "assigned_id", id }));
        // Persist a placeholder lamp to settings so admin can link it
        try {
          const raw = fs.readFileSync(settingsPath, "utf-8");
          const json = JSON.parse(raw);
          json.lamps = Array.isArray(json.lamps) ? json.lamps : [];
          if (!json.lamps.some((l: any) => l.id === id)) {
            json.lamps.push({
              id,
              street: "",
              connections: [],
              state: { on: false, brightness: 0, color: "#ffffff" },
              name: ""
            });
            fs.writeFileSync(settingsPath, JSON.stringify(json, null, 2), "utf-8");
            ensureEngineLampExists(id);
            broadcastLampStates();
            // After activation, schedule auto-off for affected lamps
            try {
              if (ACTIVATION_DURATION_MS) {
                const events = engine.getEvents();
                const last = events[events.length - 1] as any;
                if (last && last.type === "street_activated" && Array.isArray(last.affectedLampIds)) {
                  last.affectedLampIds.forEach((id: string) => {
                    const existing = autoOffTimers.get(id);
                    if (existing) { try { clearTimeout(existing); } catch {} }
                    const t = setTimeout(() => {
                      try {
                        engine.setLampState(id, { on: false, brightness: 0, color: "#ffffff" });
                        broadcastLampStates();
                      } catch {}
                    }, ACTIVATION_DURATION_MS);
                    autoOffTimers.set(id, t);
                    // Ensure offAt persisted immediately for each affected lamp
                    try {
                      const raw = fs.readFileSync(settingsPath, "utf-8");
                      const json = JSON.parse(raw);
                      json.lamps = Array.isArray(json.lamps) ? json.lamps : [];
                      let updated = false;
                      json.lamps = json.lamps.map((l: any) => {
                        if (l && l.id === id) {
                          const entry: any = { ...l };
                          entry.offAt = Date.now() + ACTIVATION_DURATION_MS;
                          updated = true;
                          return entry;
                        }
                        return l;
                      });
                      if (!updated) {
                        json.lamps.push({ id, street: "", connections: [], state: { on: true, brightness: 0, color: "#ffffff" }, name: "", offAt: Date.now() + ACTIVATION_DURATION_MS });
                      }
                      fs.writeFileSync(settingsPath, JSON.stringify(json, null, 2), "utf-8");
                      try { console.log(`[auto-off] offAt set (street) for ${id}`); } catch {}
                    } catch {}
                  });
                }
              }
            } catch {}
          }
        } catch { }
        return;
      }
      // New: authorize connection with an ID
      if (msg && msg.type === "authorize" && typeof msg.id === "string") {
        const id = msg.id;
        // Ensure uniqueness: replace any existing mapping
        const existing = lampClients.get(id);
        if (existing && existing.ws !== ws) {
          try { existing.ws.close(); } catch { }
          lampClients.delete(id);
        }
        lampClients.set(id, { id, ws });
        lampAuthBySocket.set(ws, id);
        ensureSettingsLampExists(id);
        ensureEngineLampExists(id);
        ws.send(JSON.stringify({ type: "authorized", id }));
        ensureEngineLampExists(id);
        // When a lamp connects, wait 2 seconds, then fetch desired state from settings and send to device
        setTimeout(() => {
          try {
            const raw = fs.readFileSync(settingsPath, "utf-8");
            const json = JSON.parse(raw);
            const desired = (Array.isArray(json.lamps) ? json.lamps : []).find((l: any) => l && l.id === id)?.state;
            if (desired && typeof desired === 'object') {
              const st = { on: !!desired.on, brightness: Number(desired.brightness) || 0, color: typeof desired.color === 'string' ? desired.color : '#ffffff' };
              try { ws.send(JSON.stringify({ type: "activated", id, state: st })); } catch {}
            }
          } catch {}
        }, 2000);
        broadcastLampStates();
        broadcastDeviceStatus();
        return;
      }
      if (msg && msg.type === "state" && typeof msg.id === "string" && msg.state) {
        // Enforce identity: only accept messages from the authorized ID for this socket
        const authId = lampAuthBySocket.get(ws);
        if (!authId || authId !== msg.id) {
          ws.send(JSON.stringify({ type: "error", code: "unauthorized_id", message: "ID mismatch for this connection" }));
          return;
        }
        // optional: accept state updates from lamp devices
        // update engine state for this lamp if known
        const l = (engine as any).lamps.get(msg.id) as Lamp | undefined;
        if (l) {
          const { on, brightness, color } = msg.state;
          engine.setLampState(msg.id, { on, brightness, color });
          broadcastLampStates();
        }
        return;
      }
      // Device-triggered street activation with spillover
      if (msg && msg.type === "activate_street" && typeof msg.id === "string") {
        const authId = lampAuthBySocket.get(ws);
        if (!authId || authId !== msg.id) {
          ws.send(JSON.stringify({ type: "error", code: "unauthorized_id", message: "ID mismatch for this connection" }));
          return;
        }
        const l = (engine as any).lamps.get(msg.id) as Lamp | undefined;
        if (l && typeof l.street === "string" && l.street.length) {
          backend.activateStreet(l.street, { spillover: true, on: true });
          broadcastLampStates();
          // Also notify UI clients explicitly
          try {
            const uiPayload = JSON.stringify({ type: "street_activated", street: l.street });
            wss.clients.forEach((client: WebSocket) => { try { client.send(uiPayload); } catch { } });
          } catch { }
          // Notify all affected devices, including the issuer
          const events = engine.getEvents();
          const last = events[events.length - 1] as any;
          if (last && last.type === "street_activated" && Array.isArray(last.affectedLampIds)) {
            notifyDeviceActivation(last.affectedLampIds);
            // Schedule auto-off for affected lamps
            try {
              if (ACTIVATION_DURATION_MS) {
                last.affectedLampIds.forEach((lid: string) => {
                  const existing = autoOffTimers.get(lid);
                  if (existing) { try { clearTimeout(existing); } catch {} }
                  const t = setTimeout(() => {
                    try { engine.setLampState(lid, { on: false, brightness: 0, color: "#ffffff" }); broadcastLampStates(); } catch {}
                  }, ACTIVATION_DURATION_MS);
                  autoOffTimers.set(lid, t);
                });
              }
            } catch {}
          }
          ws.send(JSON.stringify({ type: "street_activated", street: l.street }));
        } else {
          ws.send(JSON.stringify({ type: "error", code: "no_street", message: "Lamp has no assigned street" }));
        }
        return;
      }
    } catch { }
  });
  ws.on("close", () => { markDeadLamp(ws); });
});

lampServer.listen(LAMP_WS_PORT, () => {
  console.log(`Lamp WebSocket listening on ws://localhost:${LAMP_WS_PORT}`);
});

// Periodically print connected lamp IDs
setInterval(() => {
  try {
    const ids = Array.from(lampClients.keys());
    console.log(`[lamp-ws STATUS] connected=${ids.length} ids=${ids.join(',') || '-'}`);
  } catch {}
}, 5000);

// Periodically broadcast device_status to UI clients to ensure consistency
setInterval(() => {
  try {
    const connectedIds = Array.from(lampClients.keys());
    const payload = JSON.stringify({ type: "device_status", connectedIds });
    wss.clients.forEach((client: WebSocket) => { try { client.send(payload); } catch {} });
  } catch {}
}, 5000);

function getBroadcastAddresses() {
  const interfaces = os.networkInterfaces();
  const broadcasts = [];

  for (const iface of Object.values(interfaces)) {
    for (const addr of iface || []) {
      if (
        addr.family === "IPv4" &&
        !addr.internal &&
        addr.netmask
      ) {
        const ip = addr.address.split(".").map(Number);
        const mask = addr.netmask.split(".").map(Number);

        const broadcast = ip.map((b, i) => (b | (~mask[i] & 255)));
        broadcasts.push(broadcast.join("."));
      }
    }
  }

  return broadcasts;
}

const socket = dgram.createSocket("udp4");
socket.bind(() => socket.setBroadcast(true));

setInterval(() => {
  const msg = Buffer.from(JSON.stringify({
    type: "lamp_server_announce",
    ws_port: 3090
  }));

  for (const bcast of getBroadcastAddresses()) {
    socket.send(msg, 3091, bcast);
  }
}, 2000);

// On server start, restore auto-off timers for lamps based on offAt
try {
  if (ACTIVATION_DURATION_MS) {
    const raw = fs.readFileSync(settingsPath, "utf-8");
    const json = JSON.parse(raw);
    const lampsArr: any[] = Array.isArray(json.lamps) ? json.lamps : [];
    lampsArr.forEach((l: any) => {
      try {
        if (l && l.id && l.state && typeof l.offAt !== 'undefined') {
          const remaining = Number(l.offAt) - Date.now();
          if (remaining <= 0) {
            // Already expired; turn off immediately in engine and persist
            engine.setLampState(l.id, { on: false });
            broadcastLampStates();
          } else {
            const existing = autoOffTimers.get(l.id);
            if (existing) { try { clearTimeout(existing); } catch {} }
            const t = setTimeout(() => { try { engine.setLampState(l.id, { on: false, brightness: 0, color: "#ffffff" }); broadcastLampStates(); } catch {} }, remaining);
            autoOffTimers.set(l.id, t);
          }
        }
      } catch {}
    });
  }
} catch {}

// Heartbeat interval: ping lamps and terminate dead sockets
setInterval(() => {
  try {
    lampWss.clients.forEach((client: WebSocket) => {
      const c = client as LampWS;
      if (c.isAlive === false) {
        try { c.terminate(); } catch {}
        markDeadLamp(c);
        return;
      }
      c.isAlive = false;
      try { c.ping(); } catch {}
    });
  } catch {}
}, 10000);