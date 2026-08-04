/**
 * The one list of health metrics — what the phone reads, where it lands.
 *
 * This table lives on the SERVER, not in the iOS app, and that is the whole
 * point. A web deploy is a `git push`; an iOS change is Xcode, re-signing and
 * re-installing. So the app ships knowing nothing: it asks
 * GET /api/health/config what to collect, and POSTs whatever comes back.
 * Adding HRV or fibre later is a line here — the app never changes.
 *
 * `hk` is the HealthKit type identifier the app queries. `unit` is the unit it
 * must convert to before sending, so the server never has to guess whether a
 * weight arrived in kg or lb.
 *
 * `agg` tells the app how to fold a day's samples into one number:
 *   sum    — many samples add up (steps, calories, water)
 *   avg    — an average over the day (resting heart rate)
 *   latest — the newest sample wins (body weight; you weigh once)
 *   total  — a duration in hours, summed from sample start/end (sleep)
 *
 * `max` is a sanity ceiling. Not validation theatre: a mis-set unit in the app
 * turns 75 kg into 165 lb into nonsense, and a wrong number that looks
 * plausible is worse than a rejected one.
 */

export type Agg = 'sum' | 'avg' | 'latest' | 'total'

export interface MetricSpec {
  hk: string
  unit: string
  agg: Agg
  max: number
  /** Which tile's data this belongs to. */
  slot: 'vitals' | 'fuel'
  /** Optional nesting inside the slot, e.g. fuel.nutrition.<date>.protein */
  group?: string
}

export const METRICS: Record<string, MetricSpec> = {
  // ── Schlaf ────────────────────────────────────────────────────────────────
  // Category type, not a number: HealthKit stores segments with start/end, so
  // the app sums durations. Several segments per night is normal.
  sleepHours: { hk: 'HKCategoryTypeIdentifierSleepAnalysis', unit: 'h', agg: 'total', max: 24, slot: 'vitals' },
  sleepDeep: { hk: 'HKCategoryValueSleepAnalysisAsleepDeep', unit: 'h', agg: 'total', max: 24, slot: 'vitals' },
  sleepRem: { hk: 'HKCategoryValueSleepAnalysisAsleepREM', unit: 'h', agg: 'total', max: 24, slot: 'vitals' },

  // ── Herz ──────────────────────────────────────────────────────────────────
  restingHR: { hk: 'HKQuantityTypeIdentifierRestingHeartRate', unit: 'count/min', agg: 'avg', max: 250, slot: 'vitals' },
  hrv: { hk: 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN', unit: 'ms', agg: 'avg', max: 500, slot: 'vitals' },
  avgHR: { hk: 'HKQuantityTypeIdentifierHeartRate', unit: 'count/min', agg: 'avg', max: 250, slot: 'vitals' },

  // ── Aktivität ─────────────────────────────────────────────────────────────
  steps: { hk: 'HKQuantityTypeIdentifierStepCount', unit: 'count', agg: 'sum', max: 200000, slot: 'vitals' },
  activeEnergy: { hk: 'HKQuantityTypeIdentifierActiveEnergyBurned', unit: 'kcal', agg: 'sum', max: 20000, slot: 'vitals' },
  exerciseMinutes: { hk: 'HKQuantityTypeIdentifierAppleExerciseTime', unit: 'min', agg: 'sum', max: 1440, slot: 'vitals' },

  // ── Körper ────────────────────────────────────────────────────────────────
  weightKg: { hk: 'HKQuantityTypeIdentifierBodyMass', unit: 'kg', agg: 'latest', max: 400, slot: 'vitals' },
  bodyFat: { hk: 'HKQuantityTypeIdentifierBodyFatPercentage', unit: '%', agg: 'latest', max: 100, slot: 'vitals' },

  // ── Ernährung (Yazio schreibt das hier hinein) ────────────────────────────
  kcal: { hk: 'HKQuantityTypeIdentifierDietaryEnergyConsumed', unit: 'kcal', agg: 'sum', max: 20000, slot: 'fuel', group: 'nutrition' },
  protein: { hk: 'HKQuantityTypeIdentifierDietaryProtein', unit: 'g', agg: 'sum', max: 1000, slot: 'fuel', group: 'nutrition' },
  carbs: { hk: 'HKQuantityTypeIdentifierDietaryCarbohydrates', unit: 'g', agg: 'sum', max: 2000, slot: 'fuel', group: 'nutrition' },
  fat: { hk: 'HKQuantityTypeIdentifierDietaryFatTotal', unit: 'g', agg: 'sum', max: 1000, slot: 'fuel', group: 'nutrition' },
  sugar: { hk: 'HKQuantityTypeIdentifierDietarySugar', unit: 'g', agg: 'sum', max: 2000, slot: 'fuel', group: 'nutrition' },
  fiber: { hk: 'HKQuantityTypeIdentifierDietaryFiber', unit: 'g', agg: 'sum', max: 500, slot: 'fuel', group: 'nutrition' },

  // Litres, and therefore NOT store.water — der Gläserzähler des Fuel-Tiles
  // zählt Gläser (Ziel 8). 2.4 Liter dort hineinzuschreiben liest sich als
  // "2,4 von 8 Gläsern" und ist schlicht falsch. Zwei verschiedene Messungen
  // derselben Sache dürfen nicht in dasselbe Feld: der Knopf im Tile behält
  // seinen Zähler, HealthKit legt seine Liter daneben.
  waterLiters: { hk: 'HKQuantityTypeIdentifierDietaryWater', unit: 'l', agg: 'sum', max: 50, slot: 'fuel', group: 'nutrition' },
}

/** What the app is told to collect. Keys are the metric names it must report back. */
export function metricConfig() {
  return Object.entries(METRICS).map(([key, m]) => ({
    key,
    type: m.hk,
    unit: m.unit,
    aggregate: m.agg,
  }))
}

/**
 * Accept a value only if the metric is known and the number is sane. Returns
 * null for anything else — an unknown key is silently ignored rather than
 * failing the whole push, so an app running an older config never loses the
 * metrics it DID get right.
 */
export function clean(key: string, value: unknown): number | null {
  const spec = METRICS[key]
  if (!spec) return null
  if (typeof value !== 'number' || !isFinite(value)) return null
  if (value < 0 || value > spec.max) return null
  return Math.round(value * 100) / 100
}
