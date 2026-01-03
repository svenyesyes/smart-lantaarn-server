import LampEngine, { Lamp, ActivateStreetOptions, GraphData, LampState } from "./LampEngine.js";

export type ActivateParams = {
  spillover?: boolean;
  on?: boolean;
  brightness?: number;
  color?: string;
};

export default class Backend {
  private engine: LampEngine;
  private defaultSpill: number;
  private lampSender?: (id: string, msg: any) => boolean;
  private defaultOnColor?: string;

  constructor(engine: LampEngine, defaultSpilloverDepth: number, defaultOnColor?: string) {
    this.engine = engine;
    this.defaultSpill = defaultSpilloverDepth;
    this.defaultOnColor = defaultOnColor;
  }

  getGraph(): GraphData {
    return this.engine.getLampGraph();
  }

  getAllLamps(): Array<{ id: string; name?: string; street: string; connections: string[]; state: LampState }> {
    const graph = this.engine.getLampGraph();
    return graph.nodes.map((n) => {
      const l = (this.engine as any).lamps.get(n.id) as Lamp;
      return { id: n.id, name: l.name, street: n.street, connections: [...l.connections], state: l.state };
    });
  }

  setLampColor(lampId: string, color: string, colorMode?: string) {
    const partial: any = { color };
    if (colorMode) partial.colorMode = colorMode;
    this.engine.setLampState(lampId, partial);
  }

  activateStreet(streetId: string, params: ActivateParams = {}) {
    const spill = params.spillover === false ? 0 : this.defaultSpill;
    // Derive color (RGB only) and brightness (from AA) if defaultOnColor is provided
    let derivedColor = params.color;
    let derivedBrightness = params.brightness;
    if (!derivedColor || derivedBrightness === undefined) {
      const c = this.defaultOnColor;
      if (typeof c === 'string' && /^#?[0-9a-fA-F]{8}$/.test(c)) {
        const hex = c.startsWith('#') ? c.slice(1) : c;
        const rgb = `#${hex.slice(0, 6)}`; // RRGGBB
        const aa = hex.slice(6, 8); // AA
        if (!derivedColor) derivedColor = rgb;
        if (derivedBrightness === undefined) {
          const val = parseInt(aa, 16);
          if (Number.isFinite(val)) derivedBrightness = val;
        }
      } else if (!derivedColor && typeof c === 'string' && /^#?[0-9a-fA-F]{6}$/.test(c)) {
        derivedColor = c.startsWith('#') ? c : `#${c}`;
      }
    }

    const opts: ActivateStreetOptions = {
      on: params.on ?? true,
      brightness: derivedBrightness,
      color: derivedColor,
      spilloverDepth: spill,
    };
    this.engine.activateStreet(streetId, opts);
  }

  previewStreetActivation(streetId: string, spillover?: boolean): string[] {
    const depth = spillover === false ? 0 : this.defaultSpill;
    return this.engine.previewStreetActivation(streetId, depth);
  }

  setLampSender(sender: (id: string, msg: any) => boolean) {
    this.lampSender = sender;
  }

  sendToLamp(lampId: string, msg: any): boolean {
    if (!this.lampSender) return false;
    return this.lampSender(lampId, msg);
  }

  sendLampColorCommand(lampId: string, color: string) {
    // Generic device-side command to change color
    return this.sendToLamp(lampId, { type: "set_color", id: lampId, color });
  }

  sendLampIdentifyCommand(lampId: string, durationMs: number = 3000) {
    // Ask device to run an identify pattern for a short time
    return this.sendToLamp(lampId, { type: "identify", id: lampId, durationMs });
  }

  sendLampStateCommand(lampId: string, state: LampState) {
    // Push full desired state to device using the state color property
    return this.sendToLamp(lampId, { type: "state", id: lampId, state });
  }
}
