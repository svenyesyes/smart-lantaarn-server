import express, { Request, Response } from "express";
import path from "path";
import { fileURLToPath } from "url";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import LampEngine, { Lamp, ActivateStreetOptions } from "./LampEngine.js";
import Backend from "./backend.js";
import fs from "fs";
import dgram from "dgram";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load lamps from JSON settings
const settingsPath = path.join(__dirname, "../data/settings.json");
let settingsRaw = fs.readFileSync(settingsPath, "utf-8");
let settings = JSON.parse(settingsRaw) as { lamps: Lamp[]; spilloverDepth?: number; pulseColor?: string };
const lamps: Lamp[] = settings.lamps;
const SPILLOVER_DEPTH: number = typeof settings.spilloverDepth === "number" ? settings.spilloverDepth : 0;
let PULSE_COLOR: string = typeof settings.pulseColor === "string" ? settings.pulseColor : "#60a5fa";

// Simple 10s cache for /settings endpoint
let settingsCacheTime = 0;
function getSettingsCached() {
  const now = Date.now();
  if (now - settingsCacheTime > 10_000) {
    try {
      settingsRaw = fs.readFileSync(settingsPath, "utf-8");
      settings = JSON.parse(settingsRaw);
      // Update pulse color used by clients fetching /settings (does not affect engine spillover)
      PULSE_COLOR = typeof settings.pulseColor === "string" ? settings.pulseColor : PULSE_COLOR;
    } catch { }
    settingsCacheTime = now;
  }
  const spill = typeof settings.spilloverDepth === "number" ? settings.spilloverDepth : SPILLOVER_DEPTH;
  const pulse = typeof settings.pulseColor === "string" ? settings.pulseColor : PULSE_COLOR;
  return { spilloverDepth: spill, pulseColor: pulse };
}

const engine = new LampEngine(lamps);
const backend = new Backend(engine, SPILLOVER_DEPTH);

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

lampWss.on("connection", (ws: WebSocket) => {
  ws.on("message", (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString());
      // Legacy: explicit register with provided id
      if (msg && msg.type === "register" && typeof msg.id === "string") {
        const id = msg.id;
        lampClients.set(id, { id, ws });
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
        ws.send(JSON.stringify({ type: "authorized", id }));
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
          }
          ws.send(JSON.stringify({ type: "street_activated", street: l.street }));
        } else {
          ws.send(JSON.stringify({ type: "error", code: "no_street", message: "Lamp has no assigned street" }));
        }
        return;
      }
    } catch { }
  });
  ws.on("close", () => {
    // remove any mapping referencing this ws
    for (const [id, client] of lampClients.entries()) {
      if (client.ws === ws) lampClients.delete(id);
    }
    broadcastDeviceStatus();
  });
});

lampServer.listen(LAMP_WS_PORT, () => {
  console.log(`Lamp WebSocket listening on ws://localhost:${LAMP_WS_PORT}`);
});

// UDP broadcast: announce lamp server availability for devices on the LAN
try {
  const udpSocket = dgram.createSocket("udp4");
  udpSocket.on("error", () => { /* ignore errors for broadcast */ });
  udpSocket.bind(() => {
    try { udpSocket.setBroadcast(true); } catch { }
  });
  setInterval(() => {
    try {
      const message = Buffer.from(JSON.stringify({ type: "lamp_server_announce", ws_port: LAMP_WS_PORT }));
      udpSocket.send(message, 0, message.length, 3091, "255.255.255.255");
    } catch { }
  }, 2000);
} catch { }