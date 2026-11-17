import { Client, Room, Callbacks } from "@colyseus/sdk";
import { FrontierState, type Commander } from "../rooms/schema/FrontierState.js";
import type {
  DispatchFleetMessage,
  FortifySectorMessage,
  UpsertRuleMessage,
  RuleIdMessage,
} from "../rooms/FrontierRoom.js";
import { LocalFrontierRoom } from "./LocalFrontierRoom.js";

export type StateChangeCallback = () => void;

function getDefaultServerUrl(): string {
  if (typeof window !== "undefined") {
    const params = new URLSearchParams(window.location.search);
    const serverParam = params.get("server");
    if (serverParam) return serverParam;

    const hostname = window.location.hostname;
    if (hostname === "localhost" || hostname === "127.0.0.1") {
      return "ws://localhost:2567";
    }
    return window.location.origin.replace(/^http/, "ws");
  }
  return "ws://localhost:2567";
}

export class FrontierClient {
  public client: Client;
  public room: any = null;
  public callbacks: any = null;
  public isLocal: boolean = false;
  private stateChangeListeners: StateChangeCallback[] = [];

  constructor(serverUrl: string = getDefaultServerUrl()) {
    this.client = new Client(serverUrl);
  }

  public async joinMatch(
    options: {
      factionName?: string;
      enableSoloBot?: boolean;
      nodeCount?: number;
      preferLocal?: boolean;
    } = {}
  ): Promise<any> {
    if (this.room) {
      this.leave();
    }

    if (options.preferLocal) {
      return this.startLocalSimulation(options.enableSoloBot !== false);
    }

    try {
      this.room = await this.client.joinOrCreate("frontier", options, FrontierState);
      this.isLocal = false;
      this.callbacks = Callbacks.get(this.room as any);

      this.room.onStateChange(() => this.notifyStateChange());

      if (this.callbacks) {
        this.callbacks.listen("currentTick", () => this.notifyStateChange());
        this.callbacks.listen("phase", () => this.notifyStateChange());
        this.callbacks.listen("winnerSessionId", () => this.notifyStateChange());

        this.callbacks.onAdd("sectors", () => this.notifyStateChange());
        this.callbacks.onRemove("sectors", () => this.notifyStateChange());

        this.callbacks.onAdd("fleets", () => this.notifyStateChange());
        this.callbacks.onRemove("fleets", () => this.notifyStateChange());

        this.callbacks.onAdd("commanders", () => this.notifyStateChange());
      }

      this.notifyStateChange();
      return this.room;
    } catch (err) {
      console.warn("Unable to connect to remote Colyseus server:", err);
      // Graceful instant fallback to in-browser simulation for solo play
      if (options.enableSoloBot !== false) {
        console.info("Launching instant in-browser tactical simulation against Aegis AI Vanguard.");
        return this.startLocalSimulation(true);
      }
      throw err;
    }
  }

  public startLocalSimulation(soloBot: boolean = true): any {
    this.isLocal = true;
    this.room = new LocalFrontierRoom({ soloBot });
    this.callbacks = null;
    this.room.onStateChange(() => this.notifyStateChange());
    this.notifyStateChange();
    return this.room;
  }

  public onStateChange(cb: StateChangeCallback): void {
    this.stateChangeListeners.push(cb);
  }

  private notifyStateChange(): void {
    for (const cb of this.stateChangeListeners) {
      cb();
    }
  }

  public getMyCommander(): Commander | undefined {
    if (!this.room) return undefined;
    return this.room.state.commanders.get(this.room.sessionId);
  }

  public async dispatchFleet(
    fromSectorId: string,
    toSectorId: string,
    units: number
  ): Promise<void> {
    if (!this.room) throw new Error("Not connected to a room");
    const payload: DispatchFleetMessage = { fromSectorId, toSectorId, units };
    this.room.send("dispatch-fleet", payload);
  }

  public async fortifySector(sectorId: string): Promise<void> {
    if (!this.room) throw new Error("Not connected to a room");
    const payload: FortifySectorMessage = { sectorId };
    this.room.send("fortify-sector", payload);
  }

  public async upsertRule(rule: {
    ruleId?: string;
    sourceSectorId: string;
    targetSectorId: string;
    minThreshold: number;
    dispatchAmount: number;
  }): Promise<void> {
    if (!this.room) throw new Error("Not connected to a room");
    const payload: UpsertRuleMessage = rule;
    this.room.send("upsert-rule", payload);
  }

  public async deleteRule(ruleId: string): Promise<void> {
    if (!this.room) throw new Error("Not connected to a room");
    const payload: RuleIdMessage = { ruleId };
    this.room.send("delete-rule", payload);
  }

  public async toggleRule(ruleId: string): Promise<void> {
    if (!this.room) throw new Error("Not connected to a room");
    const payload: RuleIdMessage = { ruleId };
    this.room.send("toggle-rule", payload);
  }

  public leave(): void {
    if (this.room) {
      this.room.leave();
      this.room = null;
    }
  }
}
