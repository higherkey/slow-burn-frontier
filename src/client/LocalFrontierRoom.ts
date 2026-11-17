import {
  FrontierState,
  Commander,
  SectorNode,
  TransitFleet,
  LogisticsRule,
} from "../rooms/schema/FrontierState.js";
import { generateDefault12NodeMap } from "../shared/FrontierMapGenerator.js";
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
  LOGISTICS_FUEL_FEE,
} from "../shared/FrontierSimulation.js";
import type {
  DispatchFleetMessage,
  FortifySectorMessage,
  UpsertRuleMessage,
  RuleIdMessage,
} from "../rooms/FrontierRoom.js";

export class LocalFrontierRoom {
  public sessionId: string = "player_commander";
  public state: FrontierState;
  private tickInterval: any = null;
  private stateChangeListeners: (() => void)[] = [];
  public hasSoloBot: boolean = true;

  constructor(options: { soloBot?: boolean } = {}) {
    this.hasSoloBot = options.soloBot !== false;
    this.state = new FrontierState();
    this.state.regenIntervalMs = DEFAULT_REGEN_INTERVAL_MS;

    // Initialize 12-node topology
    const sectorMap = generateDefault12NodeMap();
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

    // Setup Local Player Commander
    const player = new Commander();
    player.sessionId = this.sessionId;
    player.factionName = "Frontier Vanguard";
    player.tokens = DEFAULT_MAX_TOKENS;
    player.maxTokens = DEFAULT_MAX_TOKENS;
    player.connected = true;
    this.state.commanders.set(this.sessionId, player);

    // Setup Solo AI Bot Commander
    if (this.hasSoloBot) {
      const bot = new Commander();
      bot.sessionId = "bot_commander";
      bot.factionName = "Aegis AI Vanguard";
      bot.tokens = DEFAULT_MAX_TOKENS;
      bot.maxTokens = DEFAULT_MAX_TOKENS;
      bot.connected = true;
      this.state.commanders.set("bot_commander", bot);
    }

    // Assign player home sector (ring_0) and bot home sector (ring_5)
    const ring0 = this.state.sectors.get("ring_0");
    if (ring0) {
      ring0.ownerSessionId = this.sessionId;
      ring0.garrison = 25;
      ring0.oreYieldPerTick = 2;
    }

    if (this.hasSoloBot) {
      const ring5 = this.state.sectors.get("ring_5");
      if (ring5) {
        ring5.ownerSessionId = "bot_commander";
        ring5.garrison = 25;
        ring5.oreYieldPerTick = 2;
      }
    }

    // Start 1 Hz simulation timestep
    this.tickInterval = setInterval(() => this.simulationTick(), 1000);
  }

  public onStateChange(cb: () => void): void {
    this.stateChangeListeners.push(cb);
  }

  private notify(): void {
    for (const cb of this.stateChangeListeners) {
      cb();
    }
  }

  public send(type: string, message: any): void {
    const player = this.state.commanders.get(this.sessionId);
    if (!player) return;

    if (type === "dispatch-fleet") {
      const msg = message as DispatchFleetMessage;
      const src = this.state.sectors.get(msg.fromSectorId);
      const dst = this.state.sectors.get(msg.toSectorId);
      if (!src || !dst) return;
      if (src.ownerSessionId !== this.sessionId) return;
      if (player.tokens < 1) return;
      if (!src.neighbors.includes(dst.sectorId)) return;
      if (src.garrison <= msg.units || msg.units <= 0) return;

      player.tokens -= 1;
      src.garrison -= msg.units;

      const tax = calculateAttritionTax(msg.units);
      const effectiveUnits = Math.max(1, msg.units - tax);
      const dist = calculateDistance(src.x, src.y, dst.x, dst.y);
      const transitTicks = calculateTransitDuration(dist);

      const fleet = new TransitFleet();
      fleet.fleetId = `fleet_${this.state.currentTick}_${Math.random().toString(36).substring(2, 7)}`;
      fleet.ownerSessionId = this.sessionId;
      fleet.fromSectorId = msg.fromSectorId;
      fleet.toSectorId = msg.toSectorId;
      fleet.units = effectiveUnits;
      fleet.departureTick = this.state.currentTick;
      fleet.arrivalTick = this.state.currentTick + transitTicks;

      this.state.fleets.set(fleet.fleetId, fleet);
      this.notify();
    } else if (type === "fortify-sector") {
      const msg = message as FortifySectorMessage;
      const s = this.state.sectors.get(msg.sectorId);
      if (!s || s.ownerSessionId !== this.sessionId || s.fortified) return;
      if (player.tokens < 1) return;

      player.tokens -= 1;
      s.fortified = true;
      this.notify();
    } else if (type === "upsert-rule") {
      const msg = message as UpsertRuleMessage;
      const src = this.state.sectors.get(msg.sourceSectorId);
      const dst = this.state.sectors.get(msg.targetSectorId);
      if (!src || !dst) return;
      if (src.ownerSessionId !== this.sessionId) return;
      if (player.tokens < 1) return;
      if (!src.neighbors.includes(dst.sectorId)) return;

      const minThreshold = Math.floor(msg.minThreshold || 30);
      const dispatchAmount = Math.floor(msg.dispatchAmount || 15);
      if (dispatchAmount < 1 || minThreshold <= dispatchAmount) return;

      player.tokens -= 1;
      const ruleId = msg.ruleId || `rule_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
      let rule = player.rules.get(ruleId);
      if (!rule) {
        rule = new LogisticsRule();
        rule.ruleId = ruleId;
        player.rules.set(ruleId, rule);
      }
      rule.sourceSectorId = msg.sourceSectorId;
      rule.targetSectorId = msg.targetSectorId;
      rule.minThreshold = minThreshold;
      rule.dispatchAmount = dispatchAmount;
      rule.cooldownTicksRemaining = 0;
      rule.active = true;
      this.notify();
    } else if (type === "delete-rule") {
      const msg = message as RuleIdMessage;
      if (player.rules.has(msg.ruleId)) {
        player.rules.delete(msg.ruleId);
        this.notify();
      }
    } else if (type === "toggle-rule") {
      const msg = message as RuleIdMessage;
      const r = player.rules.get(msg.ruleId);
      if (r) {
        r.active = !r.active;
        this.notify();
      }
    }
  }

  private simulationTick(): void {
    if (this.state.phase === "GAME_OVER") return;

    this.state.currentTick += 1;

    // 1. Token Regeneration
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

    // 2. Resource Accrual
    for (const sector of this.state.sectors.values()) {
      if (sector.ownerSessionId) {
        sector.garrison = Math.min(MAX_GARRISON, sector.garrison + sector.oreYieldPerTick);
      }
    }

    // 3. Bot AI
    if (this.hasSoloBot) {
      this.executeBotAI();
    }

    // 4. Logistics Rules
    this.executeLogisticsRules();

    // 5. Fleet Movement & Combat
    this.resolveFleetsAndCombat();

    // 6. Victory Check
    this.checkVictoryCondition();

    this.notify();
  }

  private executeBotAI(): void {
    const bot = this.state.commanders.get("bot_commander");
    if (!bot) return;

    // A. Fortify vulnerable borders
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

    // B. Logistics conduit
    if (bot.tokens >= 3 && bot.rules.size < 2) {
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

    // C. Offensive strike
    if (bot.tokens >= 1) {
      for (const s of this.state.sectors.values()) {
        if (s.ownerSessionId === bot.sessionId && s.garrison > 50) {
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
          target.garrison = Math.min(MAX_GARRISON, target.garrison + fleet.units);
        } else {
          const effDefense = calculateEffectiveDefense(target.garrison, target.fortified);
          if (fleet.units > effDefense) {
            target.ownerSessionId = fleet.ownerSessionId;
            target.garrison = fleet.units - effDefense;
            target.fortified = false;
          } else {
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

  public leave(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
  }
}
