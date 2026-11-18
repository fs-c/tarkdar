// WebSocket connection to the backend with automatic reconnect. Keeps the latest state as an
// immutable snapshot (a new object on every change), so React can subscribe with useSyncExternalStore.

import {
  type CameraData,
  type ClientMessage,
  type Exfil,
  type ExplosivesData,
  type Vehicle,
  type LootEntry,
  type Message,
  PROTOCOL_VERSION,
  type Player,
  type PlayerEquipment,
  type QuestState,
  type StatusData,
  parseMessage,
} from "./protocol";

/** The backend's WebSocket, on the host that served the page. */
export const wsUrl = (): string => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

/** The game sometimes parks some despawned/uninitialised entities at about -9999 on some axis; the backend sends it as is. */
export const isSentinelPos = (pos: readonly number[] | null | undefined): boolean => !!pos && pos.some((c) => c <= -9000);

export interface RadarState {
  connected: boolean;
  protocolMismatch: boolean;
  /** False when the backend has no game to read (--offline): only recordings to show. */
  live: boolean;
  /** The backend runs the overlay window (--overlay), which Settings can configure. */
  overlay: boolean;
  status: StatusData | null;
  raid: number | null;
  players: Player[];
  playersAt: number; // message time of the last players update (ms)
  exfils: Exfil[];
  explosives: ExplosivesData;
  vehicles: Vehicle[];
  loot: LootEntry[];
  equipment: Map<number, PlayerEquipment>;
  /** The local player's quests in progress; null when unknown (not sent yet, or an old backend). */
  quests: QuestState[] | null;
}

const emptyExplosives = (): ExplosivesData => ({ grenades: [], tripwires: [] });

export const initialRadarState = (): RadarState => ({
  connected: false,
  protocolMismatch: false,
  live: true,
  overlay: false,
  status: null,
  raid: null,
  players: [],
  playersAt: 0,
  exfils: [],
  explosives: emptyExplosives(),
  vehicles: [],
  loot: [],
  equipment: new Map(),
  quests: null,
});

export class Connection {
  private state: RadarState = initialRadarState();
  private readonly listeners = new Set<() => void>();
  // The camera changes at the full message rate: kept apart from the state, so only who asks for it
  // (the POV page) re-renders on it.
  private camera: CameraData | null = null;
  private readonly cameraListeners = new Set<() => void>();
  private ws: WebSocket | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private retryMs = 500;
  private openedAt = 0;

  /** `onMessage` sees every message before the state changes (and listeners are told). */
  constructor(
    private readonly url: string,
    private readonly onMessage?: (msg: Message) => void,
  ) {}

  getState = (): RadarState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getCamera = (): CameraData | null => this.camera;

  subscribeCamera = (listener: () => void): (() => void) => {
    this.cameraListeners.add(listener);
    return () => this.cameraListeners.delete(listener);
  };

  /** Sends a message to the backend (only `overlay` exists); false if not connected. */
  send(msg: ClientMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  start(): void {
    this.running = true;
    this.connect();
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.retryTimer);
    this.ws?.close();
    this.ws = null;
    if (this.state.connected) this.update({ connected: false });
  }

  private connect(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.openedAt = Date.now();
      this.update({ connected: true });
    };
    ws.onmessage = (e) => {
      const msg = parseMessage(String(e.data));
      if (!msg) return;
      this.onMessage?.(msg);
      this.handle(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return; // stopped, or replaced
      this.ws = null;
      this.update({ connected: false });
      if (!this.running) return;
      // Only a connection that stayed up resets the backoff: one that the server (or a bad message)
      // closes right away must not turn into a reconnect loop.
      if (this.openedAt && Date.now() - this.openedAt > 10_000) this.retryMs = 500;
      this.openedAt = 0;
      this.retryTimer = setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 10_000);
    };
  }

  private update(patch: Partial<RadarState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  private handle(msg: Message): void {
    switch (msg.type) {
      case "hello":
        return this.update({ protocolMismatch: msg.data.protocol !== PROTOCOL_VERSION, live: msg.data.live !== false, overlay: msg.data.overlay === true });
      case "status":
        if (msg.data.state !== "inRaid") {
          if (this.camera) {
            this.camera = null;
            for (const l of this.cameraListeners) l();
          }
          const { connected, protocolMismatch, live, overlay } = this.state;
          return this.update({ ...initialRadarState(), connected, protocolMismatch, live, overlay, status: msg.data });
        }
        return this.update({ status: msg.data });
      case "players":
        return this.update({ raid: msg.raid, players: msg.data.players.filter((p) => !isSentinelPos(p.pos)), playersAt: msg.t });
      case "exfils":
        return this.update({ exfils: msg.data.exfils });
      case "explosives":
        return this.update({ explosives: msg.data });
      case "vehicles":
        return this.update({ vehicles: msg.data.vehicles });
      case "loot":
        return this.update({ loot: msg.data.loot.filter((l) => !isSentinelPos(l.pos)) });
      case "equipment":
        return this.update({ equipment: new Map(msg.data.players.map((p) => [p.id, p])) });
      case "quests":
        return this.update({ quests: msg.data.quests });
      case "camera":
        // The camera's last (empty) snapshot of a raid can come after the status that ended it.
        if (msg.raid === null || this.state.status?.state !== "inRaid") return;
        this.camera = msg.data;
        for (const l of this.cameraListeners) l();
        return;
    }
  }
}
