/** Shared types for the survivor leaderboard. */

/** A player on the roster, as configured in config/players.json. */
export interface RosterEntry {
  /** Riot game name, e.g. "Raikugen" (the part before the #). */
  gameName: string;
  /** Riot tag line, e.g. "four" (the part after the #). */
  tagLine: string;
  /** Friendly region code, e.g. "VN", "NA", "EUW". Mapped to a platform id internally. */
  region: string;
  /** Optional display name for the UI. Defaults to "gameName#tagLine". */
  displayName?: string;
  /** Optional team / streamer / country label shown next to the name. */
  team?: string;
}

/** Rank reading for one player at one point in time. */
export interface RankSnapshot {
  /** Human readable, straight from MetaTFT, e.g. "GRANDMASTER I 742 LP". */
  text: string;
  /** Sortable integer. Master+ is LP + 2800. Higher is better. */
  numeric: number;
  /** Ranked games played this set. */
  numGames: number;
  /** ISO timestamp of when we read it. */
  readAt: string;
}

/** One ranked game, pulled from the matches[] array. */
export interface MatchResult {
  matchId: string;
  placement: number;
  /** Epoch milliseconds. */
  timestamp: number;
}

export type LifeLossReason = "below_cut_line" | "insufficient_games" | "no_rank_data";

/** An entry in the running event log, for the UI's activity feed. */
export interface GameEvent {
  at: string;
  checkpoint: number;
  playerId: string;
  type: "life_lost" | "eliminated" | "winner";
  reason?: LifeLossReason;
  /** Leaderboard position at the moment of the event (1-indexed, among survivors). */
  position?: number;
  cutLine?: number;
  livesRemaining?: number;
  finalPosition?: number;
}

/** Everything we track about one player across the whole run. */
export interface PlayerState {
  /** Stable id, "gameName#tagLine". */
  id: string;
  gameName: string;
  tagLine: string;
  region: string;
  displayName: string;
  team?: string;
  lives: number;
  eliminated: boolean;
  eliminatedAt?: string;
  eliminatedAtCheckpoint?: number;
  /** Final standing, 1 = winner. Only set once eliminated (or once they win). */
  finalPosition?: number;
  /** Most recent successful rank reading, or null if we have never got one. */
  rank: RankSnapshot | null;
  /** Rank at the previous checkpoint, so the UI can show movement. */
  rankAtLastCheckpoint: RankSnapshot | null;
  /** Games played as of the previous checkpoint, for the min-games rule. */
  gamesAtLastCheckpoint: number | null;
  /** Recent ranked placements, newest first, capped. */
  recentPlacements: MatchResult[];
  /** Sparkline data: rating over time, capped and downsampled. */
  history: { t: string; numeric: number }[];
  /** Populated when the last poll for this player failed. */
  lastError?: string;
}

/** A scheduled moment where the cut line is applied and lives are taken. */
export interface Checkpoint {
  /** ISO timestamp. Lives are taken the first time we poll at or after this moment. */
  at: string;
  /**
   * Survivors ranked strictly worse than this position lose a life.
   * A cut line of 30 means positions 31 and below are cut.
   * May exceed the number of survivors, in which case nobody is cut.
   */
  cutLine: number;
  /** Optional: survivors who played fewer than this many games since the last checkpoint also lose a life. */
  minGames?: number;
  /** Optional human label shown in the UI, e.g. "Day 3". */
  label?: string;
}

export interface Rules {
  /** Display name of the whole event. */
  title: string;
  /** TFT set passed to MetaTFT, e.g. "TFTSet17". */
  tftSet: string;
  /** Ranked queue id. 1100 is ranked TFT. */
  queueId: number;
  startingLives: number;
  /** Players with no rank reading at a checkpoint lose a life. */
  penaliseMissingRank: boolean;
  checkpoints: Checkpoint[];
}

/** The full persisted state, written to data/state.json. */
export interface State {
  version: 1;
  title: string;
  startedAt: string;
  lastPolledAt: string | null;
  /** Indices into rules.checkpoints that have already been applied. */
  checkpointsApplied: number[];
  players: PlayerState[];
  events: GameEvent[];
  winnerId: string | null;
}
