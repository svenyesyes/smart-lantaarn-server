import LampEngine, { Lamp } from "./LampEngine.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Simple harness using JSON settings
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const settingsPath = path.join(__dirname, "../data/settings.json");
const settingsRaw = fs.readFileSync(settingsPath, "utf-8");
const settings = JSON.parse(settingsRaw) as { lamps: Lamp[]; spilloverDepth?: number };
const lamps: Lamp[] = settings.lamps;
const SPILLOVER_DEPTH: number = typeof settings.spilloverDepth === "number" ? settings.spilloverDepth : 0;

const engine = new LampEngine(lamps);

console.log("Graph:", JSON.stringify(engine.getLampGraph(), null, 2));

console.log("Preview Main spillover depth:", engine.previewStreetActivation("Main", SPILLOVER_DEPTH));

engine.activateStreet("Main", { on: true, brightness: 75, color: "#ffdd88", spilloverDepth: SPILLOVER_DEPTH });

console.log("Events:", engine.getEvents());

console.log(
  "Final states:",
  lamps.map((l) => ({ id: l.id, state: l.state }))
);
