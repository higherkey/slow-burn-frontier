import { Room, Client } from "colyseus";
import { StateView } from "@colyseus/schema";
import type { MessageContext } from "@colyseus/shared-types";
import {
  FrontierState,
  Commander,
  SectorNode,
  TransitFleet,
  LogisticsRule,
  VIEW_OWNER,
} from "./schema/FrontierState.js";
import {
  generateDefault12NodeMap,
  generateProceduralPlanarMap,
  type GeneratedSector,
} from "../shared/FrontierMapGenerator.js";
import {
  calculateDistance,
  calculateTransitDuration,
  calculateAttritionTax,
  calculateEffectiveDefense,
  calculateDamageInflicted,
  RULE_COOLDOWN_TICKS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_REGEN_INTERVAL_MS,
  MAX_GARRISON,
  VICTORY_SECTOR_RATIO,
  RECONNECT_WINDOW_SECONDS,
  LOGISTICS_FUEL_FEE,
} from "../shared/FrontierSimulation.js";

export interface DispatchFleetMessage {
  fromSectorId: string;
  toSectorId: string;
  units: number;
}

export interface FortifySectorMessage {
  sectorId: string;
}

export interface UpsertRuleMessage {
  ruleId?: string;
  sourceSectorId: string;
  targetSectorId: string;
  minThreshold: number;
  dispatchAmount: number;
}

export interface RuleIdMessage {
  ruleId: string;
}

export class FrontierRoom extends Room<{ state: FrontierState }> {
  maxClients = 4;
  private hasSoloBot = false;

  onCreate(options: any = {}): void {
    this.setState(new FrontierState());

    if (options.maxClients) {
      this.maxClients = options.maxClients;
    }

    const regenInterval = options.regenIntervalMs || DEFAULT_REGEN_INTERVAL_MS;
    this.state.regenIntervalMs = regenInterval;

    // Generate sector topology
    let sectorMap: Map<string, GeneratedSector>;
    if (options.nodeCount && options.nodeCount > 12) {
      sectorMap = generateProceduralPlanarMap(
        options.seed || Date.now(),
        options.nodeCount
      );
    } else {
      sectorMap = generateDefault12NodeMap();
    }

    sectorMap.forEach((sectorData, id) => {
      const node = new SectorNode();
      node.sectorId = id;
      node.x = sectorData.x;
      node.y = sectorData.y;
      for (const n of sectorData.neighbors) {
        node.neighbors.push(n);
      }
      node.ownerSessionId = sectorData.ownerSessionId;
      node.garrison = sectorData.garrison;
      node.oreYieldPerTick = sectorData.oreYieldPerTick;
      node.fortified = sectorData.fortified;
      this.state.sectors.set(id, node);
    });

    // Solo AI Bot setup
    if (options.enableSoloBot) {
      this.hasSoloBot = true;
      const bot = new Commander();
      bot.sessionId = "bot_commander";
      bot.factionName = "Aegis AI Vanguard";
      bot.tokens = DEFAULT_MAX_TOKENS;
      bot.maxTokens = DEFAULT_MAX_TOKENS;
      this.state.commanders.set(bot.sessionId, bot);

      // Assign opposing home sector to bot
      const botHome =
        this.state.sectors.get("ring_5") ||
        Array.from(this.state.sectors.values())[1];
      if (botHome) {
        botHome.ownerSessionId = bot.sessionId;
        botHome.garrison = 25;
        botHome.oreYieldPerTick = 2;
      }
    }

    // Set authoritative 1 Hz timestep loop
    this.setTimestep(() => this.stepSimulation(), 1000);

    // Register message handlers
    this.onMessage("dispatch-fleet", (client: Client, message: DispatchFleetMessage, ctx?: MessageContext) => {
      const commander = this.state.commanders.get(client.sessionId);
      if (!commander) {
        if (ctx?.reject) return ctx.reject({ code: "ERR_COMMANDER_NOT_FOUND" });
        return;
      }
      if (commander.tokens < 1) {
        if (ctx?.reject) return ctx.reject({ code: "ERR_INSUFFICIENT_TOKENS" });
        return;
      }
      const fromSector = this.state.sectors.get(message.fromSectorId);
      if (!fromSector || fromSector.ownerSessionId !== client.sessionId) {
        if (ctx?.reject) return ctx.reject({ code: "ERR_NOT_SECTOR_OWNER" });
        return;
      }
      const toSector = this.state.sectors.get(message.toSectorId);
      if (!toSector) {
        if (ctx?.reject) return ctx.reject({ code: "ERR_TARGET_NOT_FOUND" });
        return;
      }
      const isNeighbor = fromSector.neighbors.some((n: string) => n === message.toSectorId);
      if (!isNeighbor) {
        if (ctx?.reject) return ctx.reject({ code: "ERR_NO_LANE_CONNECTION" });
        return;
      }
      const units = Math.floor(message.units);
      if (units < 1 || units >= fromSector.garrison) {
        if (ctx?.reject) return ctx.reject({ code: "ERR_INVALID_GARRISON_AMOUNT" });
        return;
      }

      // Deduct token & garrison
      commander.tokens -= 1;
      fromSector.garrison -= units;

      // Calculate attrition tax & distance-based transit duration
      const tax = calculateAttritionTax(units);
      const effectiveUnits = Math.max(1, units - tax);
      const dist = calculateDistance(fromSector.x, fromSector.y, toSector.x, toSector.y);
      const transitTicks = calculateTransitDuration(dist);

      const fleet = new TransitFleet();
      fleet.fleetId = `fleet_${this.state.currentTick}_${Math.random().toString(36).substring(2, 7)}`;
      fleet.ownerSessionId = client.sessionId;
      fleet.fromSectorId = message.fromSectorId;
      fleet.toSectorId = message.toSectorId;
      fleet.units = effectiveUnits;
      fleet.departureTick = this.state.currentTick;
      fleet.arrivalTick = this.state.currentTick + transitTicks;

      this.state.fleets.set(fleet.fleetId, fleet);
      if (ctx?.resolve) return ctx.resolve({ fleetId: fleet.fleetId, transitTicks });
    });

    this.onMessage("fortify-sector", (client: Client, message: FortifySectorMessage, ctx?: MessageContext) => {
      const commander = this.state.commanders.get(client.sessionId);
      if (!commander) {
        if (ctx?.reject) return ctx.reject({ code: "ERR_COMMANDER_NOT_FOUND" });
        return;
      }
      if (commander.tokens < 1) {
        if (ctx?.reject) return ctx.reject({ code: "ERR_INSUFFICIENT_TOKENS" });
        return;
      }
      const sector = this.state.sectors.get(message.sectorId);
      if (!sector || sector.ownerSessionId !== client.sessionId) {
        if (ctx?.reject) return ctx.reject({ code: "ERR_NOT_SECTOR_OWNER" });
        return;
      }
      if (sector.fortified) {
        if (ctx?.reject) return ctx.reject({ code: "ERR_ALREADY_FORTIFIED" });
        return;
      }

      commander.tokens -= 1;
      sector.fortified = true;
      if (ctx?.resolve) return ctx.resolve({ success: true, sectorId: sector.sectorId });
    });

    this.onMessage("upsert-rule", (client: Client, message: UpsertRuleMessage, ctx?: MessageContext) => {
      const commander = this.state.commanders.get(client.sessionId);
      if (!commander) {
        if (ctx?.reject) return ctx.reject({ code: "ERR_COMMANDER_NOT_FOUND" });
        return;
      }
      if (commander.tokens < 1) {
        if (ctx?.reject) return ctx.reject({ code: "ERR_INSUFFICIENT_TOKENS" });
        return;
      }
      const isNew = !message.ruleId || !commander.rules.has(message.ruleId);
      if (isNew && commander.rules.size >= 8) {
        if (ctx?.reject) return ctx.reject({ code: "ERR_MAX_RULES_REACHED" });
        return;
      }
      const src = this.state.sectors.get(message.sourceSectorId);
      const dst = this.state.sectors.get(message.targetSectorId);
      if (!src || !dst) {
        if (ctx?.reject) return ctx.reject({ code: "ERR_SECTOR_NOT_FOUND" });
        return;
      }
      const isNeighbor = src.neighbors.some((n: string) => n === message.targetSectorId);
      if (!isNeighbor) {
        if (ctx?.reject) return ctx.reject({ code: "ERR_NO_LANE_CONNECTION" });
        return;
      }
      const minThreshold = Math.floor(message.minThreshold || 30);
      const dispatchAmount = Math.floor(message.dispatchAmount || 15);
      if (dispatchAmount < 1 || minThreshold <= dispatchAmount) {
        if (ctx?.reject) return ctx.reject({ code: "ERR_INVALID_RULE_PARAMETERS" });
        return;
      }

      commander.tokens -= 1;
      const ruleId =
        message.ruleId || `rule_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
      let rule = commander.rules.get(ruleId);
      if (!rule) {
        rule = new LogisticsRule();
        rule.ruleId = ruleId;
        commander.rules.set(ruleId, rule);
        if (client.view) {
          client.view.add(rule, VIEW_OWNER);
        }
      }
      rule.sourceSectorId = message.sourceSectorId;
      rule.targetSectorId = message.targetSectorId;
      rule.minThreshold = minThreshold;
      rule.dispatchAmount = dispatchAmount;
      rule.cooldownTicksRemaining = 0;
      rule.active = true;

      if (ctx?.resolve) return ctx.resolve({ ruleId: rule.ruleId });
    });

    this.onMessage("delete-rule", (client: Client, message: RuleIdMessage, ctx?: MessageContext) => {
      const commander = this.state.commanders.get(client.sessionId);
      if (commander && commander.rules.has(message.ruleId)) {
        const rule = commander.rules.get(message.ruleId)!;
        if (client.view) {
          client.view.remove(rule);
        }
        commander.rules.delete(message.ruleId);
        if (ctx?.resolve) return ctx.resolve({ success: true });
      }
    });

    this.onMessage("toggle-rule", (client: Client, message: RuleIdMessage, ctx?: MessageContext) => {
      const commander = this.state.commanders.get(client.sessionId);
      if (commander && commander.rules.has(message.ruleId)) {
        const rule = commander.rules.get(message.ruleId)!;
        rule.active = !rule.active;
        if (ctx?.resolve) return ctx.resolve({ active: rule.active });
      }
    });
  }

  onJoin(client: Client, options: any = {}): void {
    let commander = this.state.commanders.get(client.sessionId);
    if (!commander) {
      commander = new Commander();
      commander.sessionId = client.sessionId;
      commander.factionName =
        options.factionName || `Commander ${this.state.commanders.size + 1}`;
      commander.tokens = DEFAULT_MAX_TOKENS;
      commander.maxTokens = DEFAULT_MAX_TOKENS;
      commander.connected = true;
      this.state.commanders.set(client.sessionId, commander);

      // Attach client private StateView with owner tag
      if (!client.view) {
        client.view = new StateView();
      }
      client.view.add(commander, VIEW_OWNER);
      client.view.subscribe(commander.rules);

      // Assign initial home sector if unassigned
      let home = this.state.sectors.get("ring_0");
      if (!home || (home.ownerSessionId && home.ownerSessionId !== client.sessionId)) {
        // Find first available sector
        for (const s of this.state.sectors.values()) {
          if (!s.ownerSessionId) {
            home = s;
            break;
          }
        }
      }
      if (home && !home.ownerSessionId) {
        home.ownerSessionId = client.sessionId;
        home.garrison = 25;
        home.oreYieldPerTick = 2;
      }
    } else {
      commander.connected = true;
    }
  }

  async onLeave(client: Client, code?: number): Promise<void> {
    const commander = this.state.commanders.get(client.sessionId);
    if (commander) {
      commander.connected = false;
    }

    if (code !== 1000) {
      try {
        await this.allowReconnection(client, RECONNECT_WINDOW_SECONDS);
        if (commander) {
          commander.connected = true;
        }
      } catch {
        // Reconnect window expired
      }
    }
  }

  stepSimulation(): void {
    this.state.currentTick += 1;

    if (this.state.phase === "GAME_OVER") {
      return;
    }

    // 1. APC Token Regeneration
    for (const commander of this.state.commanders.values()) {
      if (commander.tokens < commander.maxTokens) {
        commander.nextTokenProgressMs += 1000;
        if (commander.nextTokenProgressMs >= this.state.regenIntervalMs) {
          commander.tokens += 1;
          commander.nextTokenProgressMs -= this.state.regenIntervalMs;
        }
      } else {
        commander.nextTokenProgressMs = 0;
      }
    }

    // 2. Sector Resource / Garrison Accrual
    for (const sector of this.state.sectors.values()) {
      if (sector.ownerSessionId) {
        sector.garrison = Math.min(MAX_GARRISON, sector.garrison + sector.oreYieldPerTick);
      }
    }

    // 3. Offline Fallback & Bot AI
    this.executeFallbackDoctrines();
    if (this.hasSoloBot) {
      this.executeBotAI();
    }

    // 4. Automated Logistics Execution
    this.executeLogisticsRules();

    // 5. Fleet Movement & Deterministic Combat Resolution
    this.resolveFleetsAndCombat();

    // 6. Victory Condition Check (>= 75% total sectors)
    this.checkVictoryCondition();
  }

  private executeFallbackDoctrines(): void {
    for (const commander of this.state.commanders.values()) {
      if (!commander.connected && commander.fallbackDoctrine === "HOLD_AND_FORTIFY") {
        if (commander.tokens >= 6) {
          // Find unfortified owned sectors and fortify the most defended one
          let bestSector: SectorNode | null = null;
          let maxGarrison = -1;
          for (const s of this.state.sectors.values()) {
            if (s.ownerSessionId === commander.sessionId && !s.fortified) {
              if (s.garrison > maxGarrison) {
                maxGarrison = s.garrison;
                bestSector = s;
              }
            }
          }
          if (bestSector) {
            commander.tokens -= 1;
            bestSector.fortified = true;
          }
        }
      }
    }
  }

  private executeBotAI(): void {
    const bot = this.state.commanders.get("bot_commander");
    if (!bot) return;

    // A. Fortify vulnerable border sectors
    if (bot.tokens >= 2) {
      for (const s of this.state.sectors.values()) {
        if (s.ownerSessionId === bot.sessionId && !s.fortified) {
          const hasHostileNeighbor = s.neighbors.some((nId: string) => {
            const n = this.state.sectors.get(nId);
            return n && n.ownerSessionId !== bot.sessionId;
          });
          if (hasHostileNeighbor) {
            bot.tokens -= 1;
            s.fortified = true;
            break;
          }
        }
      }
    }

    // B. Program logistics conduit if bot has fewer than 2 rules
    if (bot.tokens >= 3 && bot.rules.size < 2) {
      // Find a safe internal sector and an adjacent frontline sector
      for (const src of this.state.sectors.values()) {
        if (src.ownerSessionId === bot.sessionId && src.garrison >= 35) {
          for (const nId of src.neighbors) {
            const dst = this.state.sectors.get(nId);
            if (dst && dst.ownerSessionId === bot.sessionId) {
              const ruleId = `bot_rule_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`;
              const rule = new LogisticsRule();
              rule.ruleId = ruleId;
              rule.sourceSectorId = src.sectorId;
              rule.targetSectorId = dst.sectorId;
              rule.minThreshold = 30;
              rule.dispatchAmount = 15;
              rule.active = true;
              bot.rules.set(ruleId, rule);
              bot.tokens -= 1;
              break;
            }
          }
          if (bot.rules.size >= 2) break;
        }
      }
    }

    // C. Offensive strike when garrison > 50
    if (bot.tokens >= 1) {
      for (const s of this.state.sectors.values()) {
        if (s.ownerSessionId === bot.sessionId && s.garrison > 50) {
          // Find weakest adjacent hostile/neutral sector
          let target: SectorNode | null = null;
          let minDefense = Infinity;
          for (const nId of s.neighbors) {
            const n = this.state.sectors.get(nId);
            if (n && n.ownerSessionId !== bot.sessionId) {
              const def = calculateEffectiveDefense(n.garrison, n.fortified);
              if (def < minDefense) {
                minDefense = def;
                target = n;
              }
            }
          }

          if (target && s.garrison > minDefense + 10) {
            const attackUnits = Math.min(s.garrison - 10, minDefense + 15);
            bot.tokens -= 1;
            s.garrison -= attackUnits;

            const tax = calculateAttritionTax(attackUnits);
            const effUnits = Math.max(1, attackUnits - tax);
            const dist = calculateDistance(s.x, s.y, target.x, target.y);
            const transitTicks = calculateTransitDuration(dist);

            const fleet = new TransitFleet();
            fleet.fleetId = `bot_fleet_${this.state.currentTick}_${Math.random().toString(36).substring(2, 6)}`;
            fleet.ownerSessionId = bot.sessionId;
            fleet.fromSectorId = s.sectorId;
            fleet.toSectorId = target.sectorId;
            fleet.units = effUnits;
            fleet.departureTick = this.state.currentTick;
            fleet.arrivalTick = this.state.currentTick + transitTicks;

            this.state.fleets.set(fleet.fleetId, fleet);
            break;
          }
        }
      }
    }
  }

  private executeLogisticsRules(): void {
    for (const commander of this.state.commanders.values()) {
      for (const rule of commander.rules.values()) {
        if (!rule.active) continue;

        if (rule.cooldownTicksRemaining > 0) {
          rule.cooldownTicksRemaining -= 1;
        } else {
          const src = this.state.sectors.get(rule.sourceSectorId);
          const dst = this.state.sectors.get(rule.targetSectorId);

          if (
            src &&
            dst &&
            src.ownerSessionId === commander.sessionId &&
            dst.ownerSessionId === commander.sessionId
          ) {
            if (src.garrison >= rule.minThreshold && src.garrison > rule.dispatchAmount) {
              src.garrison -= rule.dispatchAmount;

              // Apply 1-unit logistics fuel / attrition fee
              const actualUnits = Math.max(1, rule.dispatchAmount - LOGISTICS_FUEL_FEE);
              const dist = calculateDistance(src.x, src.y, dst.x, dst.y);
              const transitTicks = calculateTransitDuration(dist);

              const fleet = new TransitFleet();
              fleet.fleetId = `fleet_log_${this.state.currentTick}_${Math.random().toString(36).substring(2, 7)}`;
              fleet.ownerSessionId = commander.sessionId;
              fleet.fromSectorId = rule.sourceSectorId;
              fleet.toSectorId = rule.targetSectorId;
              fleet.units = actualUnits;
              fleet.departureTick = this.state.currentTick;
              fleet.arrivalTick = this.state.currentTick + transitTicks;

              this.state.fleets.set(fleet.fleetId, fleet);
              rule.cooldownTicksRemaining = RULE_COOLDOWN_TICKS;
            }
          }
        }
      }
    }
  }

  private resolveFleetsAndCombat(): void {
    const arrivingFleets: TransitFleet[] = [];
    for (const fleet of this.state.fleets.values()) {
      if (this.state.currentTick >= fleet.arrivalTick) {
        arrivingFleets.push(fleet);
      }
    }

    for (const fleet of arrivingFleets) {
      const target = this.state.sectors.get(fleet.toSectorId);
      if (target) {
        if (target.ownerSessionId === fleet.ownerSessionId) {
          // Friendly reinforcement
          target.garrison = Math.min(MAX_GARRISON, target.garrison + fleet.units);
        } else {
          // Hostile combat resolution
          const effDefense = calculateEffectiveDefense(target.garrison, target.fortified);
          if (fleet.units > effDefense) {
            // Sector captured!
            target.ownerSessionId = fleet.ownerSessionId;
            target.garrison = fleet.units - effDefense;
            target.fortified = false;
          } else {
            // Defense repels the attack; garrison suffers casualties
            const casualties = calculateDamageInflicted(fleet.units, target.fortified);
            target.garrison = Math.max(0, target.garrison - casualties);
          }
        }
      }
      this.state.fleets.delete(fleet.fleetId);
    }
  }

  private checkVictoryCondition(): void {
    const totalSectors = this.state.sectors.size;
    if (totalSectors === 0) return;

    const ownershipCounts = new Map<string, number>();
    for (const s of this.state.sectors.values()) {
      if (s.ownerSessionId) {
        ownershipCounts.set(s.ownerSessionId, (ownershipCounts.get(s.ownerSessionId) || 0) + 1);
      }
    }

    const victoryThreshold = Math.ceil(totalSectors * VICTORY_SECTOR_RATIO);
    for (const [ownerId, count] of ownershipCounts.entries()) {
      if (count >= victoryThreshold) {
        this.state.phase = "GAME_OVER";
        this.state.winnerSessionId = ownerId;
        break;
      }
    }
  }
}
