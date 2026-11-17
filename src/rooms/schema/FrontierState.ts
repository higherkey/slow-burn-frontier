import { schema, t, type SchemaType } from "@colyseus/schema";

export const VIEW_OWNER = 1;

export const LogisticsRule = schema({
  ruleId: t.string(),
  sourceSectorId: t.string(),
  targetSectorId: t.string(),
  minThreshold: t.uint16().default(30),
  dispatchAmount: t.uint16().default(15),
  cooldownTicksRemaining: t.uint8().default(0),
  active: t.boolean().default(true),
}, "LogisticsRule");
export type LogisticsRule = SchemaType<typeof LogisticsRule>;

export const Commander = schema({
  sessionId: t.string(),
  factionName: t.string(),
  connected: t.boolean().default(true),
  fallbackDoctrine: t.string().default("HOLD_AND_FORTIFY"),
  tokens: t.uint8().default(10).view(VIEW_OWNER),
  maxTokens: t.uint8().default(10).view(VIEW_OWNER),
  nextTokenProgressMs: t.uint32().default(0).view(VIEW_OWNER),
  rules: t.map(LogisticsRule).view(VIEW_OWNER),
}, "Commander");
export type Commander = SchemaType<typeof Commander>;

export const SectorNode = schema({
  sectorId: t.string().fullStateOnly(),
  x: t.int16().fullStateOnly(),
  y: t.int16().fullStateOnly(),
  neighbors: t.array("string").fullStateOnly(),
  ownerSessionId: t.string().default(""),
  garrison: t.uint16().default(10),
  oreYieldPerTick: t.uint8().default(1),
  fortified: t.boolean().default(false),
}, "SectorNode");
export type SectorNode = SchemaType<typeof SectorNode>;

export const TransitFleet = schema({
  fleetId: t.string(),
  ownerSessionId: t.string(),
  fromSectorId: t.string(),
  toSectorId: t.string(),
  units: t.uint16(),
  departureTick: t.uint32(),
  arrivalTick: t.uint32(),
}, "TransitFleet");
export type TransitFleet = SchemaType<typeof TransitFleet>;

export const FrontierState = schema({
  currentTick: t.uint32().default(0),
  regenIntervalMs: t.uint32().default(20_000),
  phase: t.string().default("ACTIVE"), // "ACTIVE" | "GAME_OVER"
  winnerSessionId: t.string().default(""),
  sectors: t.map(SectorNode),
  fleets: t.map(TransitFleet),
  commanders: t.map(Commander),
}, "FrontierState");
export type FrontierState = SchemaType<typeof FrontierState>;
