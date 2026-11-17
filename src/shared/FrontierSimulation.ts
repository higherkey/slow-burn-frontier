export const RULE_COOLDOWN_TICKS = 8;
export const DEFAULT_MAX_TOKENS = 10;
export const DEFAULT_REGEN_INTERVAL_MS = 20_000;
export const MAX_GARRISON = 500;
export const VICTORY_SECTOR_RATIO = 0.75;
export const RECONNECT_WINDOW_SECONDS = 300;
export const LOGISTICS_FUEL_FEE = 1;

/**
 * Calculates Euclidean distance between two 2D points.
 */
export function calculateDistance(x1: number, y1: number, x2: number, y2: number): number {
  return Math.hypot(x2 - x1, y2 - y1);
}

/**
 * Calculates fleet transit duration in ticks based on Euclidean distance.
 * Scaled formula: max(5, round(distance / 10)).
 */
export function calculateTransitDuration(distance: number): number {
  return Math.max(5, Math.round(distance / 10));
}

/**
 * Calculates transit attrition tax.
 * Dispatches of >= 10 units incur a 1-unit attrition tax.
 */
export function calculateAttritionTax(units: number): number {
  return units >= 10 ? 1 : 0;
}

/**
 * Calculates effective defense garrison considering the 1.25x fortification multiplier.
 */
export function calculateEffectiveDefense(garrison: number, fortified: boolean): number {
  return Math.ceil(garrison * (fortified ? 1.25 : 1.0));
}

/**
 * Calculates casualties inflicted on the defending garrison when an attack is repelled.
 */
export function calculateDamageInflicted(fleetUnits: number, fortified: boolean): number {
  return Math.floor(fleetUnits / (fortified ? 1.25 : 1.0));
}
