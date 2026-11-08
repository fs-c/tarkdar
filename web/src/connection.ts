// WebSocket connection to the backend with automatic reconnect. Keeps the latest state.

import {
  type Exfil,
  type ExplosivesData,
  type LootEntry,
  type Message,
  PROTOCOL_VERSION,
  type Player,
  type PlayerEquipment,
  type StatusData,
  parseMessage,
} from "./protocol";

export interface RadarState {
  connected: boolean;
  protocolMismatch: boolean;
  status: StatusData | null;
  raid: number | null;
  players: Player[];
  playersAt: number; // message time of the last players update (ms)
  exfils: Exfil[];
  explosives: ExplosivesData;
  loot: LootEntry[];
  equipment: Map<number, PlayerEquipment>;
}

const emptyExplosives = (): ExplosivesData => ({ grenades: [], tripwires: [] });

export class Connection {
  readonly state: RadarState = {
    connected: false,
    protocolMismatch: false,
    status: null,
    raid: null,
    players: [],
    playersAt: 0,
    exfils: [],
    explosives: emptyExplosives(),
    loot: [],
    equipment: new Map(),
  };
  private retryMs = 500;
  private openedAt = 0;

  constructor(private readonly url: string, private readonly onChange: () => void) {}

  start(): void {
    const ws = new WebSocket(this.url);
    ws.onopen = () => {
      this.openedAt = Date.now();
      this.state.connected = true;
      this.onChange();
    };
    ws.onmessage = (e) => {
      const msg = parseMessage(String(e.data));
      if (msg) this.handle(msg);
    };
    ws.onclose = () => {
      this.state.connected = false;
      this.onChange();
      // Only a connection that stayed up resets the backoff: one that the server (or a bad message)
      // closes right away must not turn into a reconnect loop.
      if (this.openedAt && Date.now() - this.openedAt > 10_000) this.retryMs = 500;
      this.openedAt = 0;
      setTimeout(() => this.start(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 10_000);
    };
  }

  private handle(msg: Message): void {
    switch (msg.type) {
      case "hello":
        this.state.protocolMismatch = msg.data.protocol !== PROTOCOL_VERSION;
        break;
      case "status":
        this.state.status = msg.data;
        if (msg.data.state !== "inRaid") {
          this.state.players = [];
          this.state.exfils = [];
          this.state.explosives = emptyExplosives();
          this.state.loot = [];
          this.state.equipment = new Map();
          this.state.raid = null;
        }
        break;
      case "players":
        this.state.raid = msg.raid;
        this.state.players = msg.data.players;
        this.state.playersAt = msg.t;
        break;
      case "exfils":
        this.state.exfils = msg.data.exfils;
        break;
      case "explosives":
        this.state.explosives = msg.data;
        break;
      case "loot":
        this.state.loot = msg.data.loot;
        break;
      case "equipment":
        this.state.equipment = new Map(msg.data.players.map((p) => [p.id, p]));
        break;
    }
    this.onChange();
  }
}
