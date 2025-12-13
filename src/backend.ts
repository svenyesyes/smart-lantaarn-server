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

  constructor(engine: LampEngine, defaultSpilloverDepth: number) {
    this.engine = engine;
    this.defaultSpill = defaultSpilloverDepth;
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
    const opts: ActivateStreetOptions = {
      on: params.on ?? true,
      brightness: params.brightness,
      color: params.color,
      spilloverDepth: spill,
    };
    this.engine.activateStreet(streetId, opts);
  }

  previewStreetActivation(streetId: string, spillover?: boolean): string[] {
    const depth = spillover === false ? 0 : this.defaultSpill;
    return this.engine.previewStreetActivation(streetId, depth);
  }
}
