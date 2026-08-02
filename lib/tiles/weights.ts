/**
 * Goals + tile weights — the math of the equation, with NO AI key at runtime.
 *
 *   y = the Mentor (the overseer, where the math lives)
 *   x = each input tile · w = that tile's share of the ACTIVE goal
 *
 * Each goal carries its own weights (sum = 100). The row badges show the active
 * goal's weights; the Mentor lists every goal with its full breakdown.
 *
 * WHO DOES THE MATH: Claude Code, at build time — not an Anthropic key, not
 * you by hand. In VS Code, say:
 *
 *   "My goals are X and Y. Open lib/tiles/weights.ts and re-run the math:
 *    for each goal, weigh how much each tile's input actually moves it
 *    (ask me questions if you need to). Each goal's weights sum to 100."
 *
 * Claude reasons, edits DEFAULT_GOALS, you reload. Later it can also
 * cross-reference your real tile data and retune from evidence. A localStorage
 * override ('vitality:goals') wins over these defaults.
 *
 * ── State 02.08.2026 ──────────────────────────────────────────────────────
 * Filled from the owner's own answers (see the vault note "04 - Datenerfassung").
 * Nothing here is invented: `progress` stays 0 on both goals because no data
 * has been swept yet, and `brand` sits at 0 because TikTok/YouTube were
 * deliberately skipped — the tile stays on the board, empty, not deleted.
 */

export interface Goal {
  id: string
  title: string
  /** tile slot -> % of this goal (sums to ~100) */
  weights: Record<string, number>
  /** true while the mentor (Claude Code) hasn't shaped + weighed it yet */
  pending?: boolean
  /** each goal tints the board a little; the overall goal goes gold */
  accent?: string
  /** how far you've come, 0–100 — computed by the mentor from data sweeps
   *  (analytics, manual logs, wearables), never guessed by the app */
  progress?: number
}

/** One observation the mentor pushed after scanning your data, with any
 *  weight changes it made because of what it found. */
export interface Notice {
  id: string
  when: string
  text: string
  /** bullet points; **bold** marks the highlighted words */
  points?: string[]
  deltas?: { tile: string; from: number; to: number }[]
}

export const DEFAULT_GOALS: Goal[] = [
  {
    id: 'users10k',
    title: '10 000 App-Nutzer',
    accent: '#6EE7B7',
    // Measured across all apps combined. Brand sits at 0: the socials were
    // skipped on purpose, so nothing on the board tracks reach yet. The lever
    // that is left is shipping time — hence Peak carries this goal.
    weights: { peak: 45, vitals: 20, finance: 15, train: 10, fuel: 10, brand: 0 },
    progress: 0,
  },
  {
    id: 'bf10',
    title: '10 % Körperfett',
    accent: '#8AB4FF',
    // From ~25 % at 93 kg: roughly 15 kg of fat, landing near 77–78 kg if
    // lean mass holds. Target date 31.01.2027 ≈ 0,6 kg/week.
    weights: { fuel: 45, train: 30, vitals: 20, peak: 5, brand: 0 },
    progress: 0,
  },
]

/** The overseer's synthesis of EVERY goal. Switching it on = top priority. */
export const OVERALL_GOAL: Goal = {
  id: 'overall',
  title: 'Profitable Apps',
  accent: '#E8C878',
  weights: { peak: 40, finance: 25, vitals: 15, train: 10, fuel: 10, brand: 0 },
  progress: 0,
}

/** Overall first, then the individual goals. */
export function allGoals(): Goal[] {
  return [OVERALL_GOAL, ...goals()]
}

/** The full active Goal (incl. overall), for accent + title. */
export function activeGoal(): Goal | undefined {
  const id = activeGoalId()
  return allGoals().find((g) => g.id === id) ?? goals()[0]
}

/** The mentor's noticed feed. EMPTY until a real sweep has run — an observation
 *  here reads as "I saw this in your data", so a seeded example would be a lie. */
export const DEFAULT_NOTICED: Notice[] = []

/** A blueprint for a tile they SHOULD have — a gap the mentor found between
 *  their goal and what their tiles actually track. */
export interface TileIdea {
  /** ONE word — how the idea shows up in the popup (the mentor picks it) */
  word?: string
  title: string
  /** what the tile tracks, in one line */
  tracks: string
  /** why it moves THIS goal — tied to their data when possible */
  why: string
  /** the weight it would likely earn (≈ %) */
  estWeight: number
}

/** These are the owner's OWN phase-2 wishes, not guesses from data. */
export const DEFAULT_IDEAS: Record<string, TileIdea[]> = {
  overall: [
    {
      word: 'Analytics',
      title: 'App-Statistiken',
      tracks: 'Nutzerzahlen und Umsatz je App, an einem Ort',
      why: 'Beide Hauptziele hängen an dieser Zahl — und aktuell trackt sie kein einziges Tile.',
      estWeight: 20,
    },
    {
      word: 'Obsidian',
      title: 'Obsidian-Anbindung',
      tracks: 'Notizen und Projektstände aus dem Vault',
      why: 'Die Planung liegt bereits im Vault. Das Board sieht sie nur, wenn sie angebunden ist.',
      estWeight: 8,
    },
    {
      word: 'ToDos',
      title: 'To-Dos je App',
      tracks: 'offene Aufgaben pro Projekt',
      why: 'Peak misst die Zeit, aber nicht, woran sie gegangen ist.',
      estWeight: 10,
    },
  ],
  users10k: [
    {
      word: 'Analytics',
      title: 'App-Statistiken',
      tracks: 'tägliche Installs und aktive Nutzer je App',
      why: 'Das Ziel ist eine Zahl, die derzeit nirgends steht. Ohne sie bleibt der Fortschritt bei 0.',
      estWeight: 25,
    },
  ],
  bf10: [
    {
      word: 'Health',
      title: 'Apple Health',
      tracks: 'Gewicht, Schlaf, Kalorien — aus MyStrengthBook, Yazio und der Watch',
      why: 'Alle drei Quellen schreiben nach Apple Health. Eine Anbindung füllt Fuel, Train und Vitals auf einmal.',
      estWeight: 15,
    },
  ],
}

/** The mentor's tile recommendations for a goal (localStorage override wins). */
export function tileIdeas(goalId: string): TileIdea[] {
  if (typeof window !== 'undefined') {
    try {
      const raw = window.localStorage.getItem('vitality:ideas')
      if (raw) {
        const o = JSON.parse(raw)
        if (o && typeof o === 'object' && Array.isArray(o[goalId])) return o[goalId] as TileIdea[]
      }
    } catch {
      /* fall through */
    }
  }
  return DEFAULT_IDEAS[goalId] ?? DEFAULT_IDEAS.overall ?? []
}

/** The mentor's noticed feed: localStorage override, else the seeded example.
 *  Claude Code (or the connector) writes 'vitality:noticed' after a scan. */
export function noticedFeed(): Notice[] {
  if (typeof window !== 'undefined') {
    try {
      const raw = window.localStorage.getItem('vitality:noticed')
      if (raw) {
        const o = JSON.parse(raw)
        if (Array.isArray(o)) return o as Notice[]
      }
    } catch {
      /* fall through */
    }
  }
  return DEFAULT_NOTICED
}

/** Save the goals list (used by the mentor page's goal input). */
export function saveGoals(list: Goal[]): void {
  try {
    window.localStorage.setItem('vitality:goals', JSON.stringify(list))
  } catch {
    /* ignore */
  }
}

/** All goals: localStorage override ('vitality:goals') if valid, else defaults. */
export function goals(): Goal[] {
  if (typeof window !== 'undefined') {
    try {
      const raw = window.localStorage.getItem('vitality:goals')
      if (raw) {
        const o = JSON.parse(raw)
        if (Array.isArray(o) && o.every((g) => g && typeof g.id === 'string' && g.weights)) return o as Goal[]
      }
    } catch {
      /* fall through */
    }
  }
  return DEFAULT_GOALS
}

/** The active goal id (persisted). Defaults to the first goal.
 *  A stored id is only honoured if that goal still EXISTS — otherwise a goal
 *  that was renamed or removed would leave a dangling id behind, and the
 *  header would keep showing a title nothing else on the board agrees with. */
export function activeGoalId(): string {
  const fallback = goals()[0]?.id ?? ''
  if (typeof window !== 'undefined') {
    try {
      const v = window.localStorage.getItem('vitality:goal:active')
      if (v && allGoals().some((g) => g.id === v)) return v
    } catch {
      /* fall through */
    }
  }
  return fallback
}

export function setActiveGoalId(id: string): void {
  try {
    window.localStorage.setItem('vitality:goal:active', id)
  } catch {
    /* ignore */
  }
}

/** The active goal's weights (the badges on the row read these). */
export function tileWeights(): Record<string, number> {
  return activeGoal()?.weights ?? {}
}
