import express, { Request, Response } from "express";
import path from "path";
import { fileURLToPath } from "url";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import LampEngine, { Lamp, ActivateStreetOptions } from "./LampEngine.js";
import fs from "fs";

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
    } catch {}
    settingsCacheTime = now;
  }
  const spill = typeof settings.spilloverDepth === "number" ? settings.spilloverDepth : SPILLOVER_DEPTH;
  const pulse = typeof settings.pulseColor === "string" ? settings.pulseColor : PULSE_COLOR;
  return { spilloverDepth: spill, pulseColor: pulse };
}

const engine = new LampEngine(lamps);

const app = express();
app.use(express.json());

const publicDir = path.join(__dirname, "../public");
app.use(express.static(publicDir));

app.get("/graph", (_req: Request, res: Response) => {
  res.json(engine.getLampGraph());
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
  const opts: ActivateStreetOptions = {
    on: Boolean(on),
    brightness: brightness !== undefined ? Number(brightness) : undefined,
    color: typeof color === "string" ? color : undefined,
    spilloverDepth: SPILLOVER_DEPTH,
  };

  engine.activateStreet(streetId, opts);

  broadcastLampStates();

  res.json({ ok: true, events: engine.getEvents() });
});

app.get("/streets/:streetId/preview", (req: Request, res: Response) => {
  const streetId = req.params.streetId;
  const ids = engine.previewStreetActivation(streetId, SPILLOVER_DEPTH);
  res.json({ affectedLampIds: ids, spilloverDepth: SPILLOVER_DEPTH });
});

app.get("/", (_req: Request, res: Response) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.get("/settings", (_req: Request, res: Response) => {
  res.json(getSettingsCached());
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

let positionsCache: Record<string, { x: number; y: number }> = {};
const positionsPath = path.join(__dirname, "../data/positions.json");
try {
  const raw = fs.readFileSync(positionsPath, "utf-8");
  positionsCache = JSON.parse(raw);
} catch {}

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
  const payload = JSON.stringify({ type: "update", states: getAllLampStates(), events: engine.getEvents() });
  wss.clients.forEach((client: WebSocket) => {
    try {
      client.send(payload);
    } catch {}
  });
}

function setPositions(p: Record<string, { x: number; y: number }>) {
  positionsCache = p;
  try {
    fs.writeFileSync(positionsPath, JSON.stringify(positionsCache, null, 2), "utf-8");
  } catch {}
  const payload = JSON.stringify({ type: "positions", positions: positionsCache });
  wss.clients.forEach((client: WebSocket) => {
    try { client.send(payload); } catch {}
  });
}

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
