/**
 * The elimination engine. Deliberately pure: every function here takes state
 * and returns state, with no I/O and no clock of its own. That is what makes
 * the whole ruleset testable without touching the network.
 *
 * The model:
 *   - Polling and eliminating are separate things. Polls run often (to keep the
 *     board fresh); checkpoints are rare scheduled moments where lives are
 *     actually taken. Without that split, anyone below the cut line would lose
 *     every life within a few minutes of falling behind.
 *   - At each checkpoint, surviving players are ranked by rating. Anyone ranked
 *     strictly worse than the cut line loses one life. At zero lives they are out.
 *   - The cut line applies to *survivors only*, so it tightens naturally as the
 *     field shrinks, on top of whatever curve is configured.
 */

import type {
  Checkpoint,
  GameEvent,
  LifeLossReason,
  PlayerState,
  Rules,
  State,
} from "./types.ts";

/**
 * Orders players best-first.
 * Ties break on fewer games played (same rating reached more efficiently),
 * then on id so the ordering is fully deterministic. Players with no rank
 * reading at all sort to the bottom.
 */
export function compareForLeaderboard(a: PlayerState, b: PlayerState): number {
  if (a.rank && !b.rank) return -1;
  if (!a.rank && b.rank) return 1;
  if (a.rank && b.rank) {
    if (b.rank.numeric !== a.rank.numeric) return b.rank.numeric - a.rank.numeric;
    if (a.rank.numGames !== b.rank.numGames) return a.rank.numGames - b.rank.numGames;
  }
  return a.id.localeCompare(b.id);
}

/** Survivors, best-first. Position in this array + 1 is the leaderboard position. */
export function rankSurvivors(players: PlayerState[]): PlayerState[] {
  return players.filter((p) => !p.eliminated).sort(compareForLeaderboard);
}

/** Full board including the eliminated, who are pinned below by final position. */
export function fullLeaderboard(players: PlayerState[]): PlayerState[] {
  const alive = rankSurvivors(players);
  const dead = players
    .filter((p) => p.eliminated)
    .sort((a, b) => (a.finalPosition ?? 9999) - (b.finalPosition ?? 9999));
  return [...alive, ...dead];
}

/** Checkpoint indices that are due at `now` and have not been applied yet. */
export function pendingCheckpoints(state: State, rules: Rules, now: Date): number[] {
  const due: number[] = [];
  rules.checkpoints.forEach((cp, i) => {
    if (state.checkpointsApplied.includes(i)) return;
    if (new Date(cp.at).getTime() <= now.getTime()) due.push(i);
  });
  return due.sort((a, b) => a - b);
}

interface CheckpointOutcome {
  state: State;
  events: GameEvent[];
}

/**
 * Applies one checkpoint: takes lives, eliminates anyone who hits zero, and
 * declares a winner if exactly one player is left standing.
 */
export function applyCheckpoint(
  state: State,
  rules: Rules,
  index: number,
  now: Date,
): CheckpointOutcome {
  const checkpoint = rules.checkpoints[index];
  if (!checkpoint) throw new Error(`no checkpoint at index ${index}`);
  if (state.checkpointsApplied.includes(index)) return { state, events: [] };

  const at = now.toISOString();
  const events: GameEvent[] = [];
  const players = state.players.map((p) => ({ ...p }));

  // If the run is already decided, just record the checkpoint and move on.
  if (state.winnerId) {
    return {
      state: { ...state, players, checkpointsApplied: [...state.checkpointsApplied, index] },
      events: [],
    };
  }

  const survivors = rankSurvivors(players);
  const survivorsBefore = survivors.length;

  // Decide who loses a life, and why. A player loses at most one life per
  // checkpoint even if they trip several conditions.
  const losses = new Map<string, { reason: LifeLossReason; position: number }>();

  survivors.forEach((player, i) => {
    const position = i + 1;

    if (!player.rank) {
      if (rules.penaliseMissingRank) {
        losses.set(player.id, { reason: "no_rank_data", position });
      }
      return;
    }

    if (position > checkpoint.cutLine) {
      losses.set(player.id, { reason: "below_cut_line", position });
      return;
    }

    if (checkpoint.minGames && checkpoint.minGames > 0) {
      const baseline = player.gamesAtLastCheckpoint ?? 0;
      const played = player.rank.numGames - baseline;
      if (played < checkpoint.minGames) {
        losses.set(player.id, { reason: "insufficient_games", position });
      }
    }
  });

  // Take the lives.
  const newlyEliminated: { player: PlayerState; position: number }[] = [];
  for (const player of players) {
    const loss = losses.get(player.id);
    if (!loss) continue;

    player.lives = Math.max(0, player.lives - 1);
    events.push({
      at,
      checkpoint: index,
      playerId: player.id,
      type: "life_lost",
      reason: loss.reason,
      position: loss.position,
      cutLine: checkpoint.cutLine,
      livesRemaining: player.lives,
    });

    if (player.lives === 0) {
      player.eliminated = true;
      player.eliminatedAt = at;
      player.eliminatedAtCheckpoint = index;
      newlyEliminated.push({ player, position: loss.position });
    }
  }

  // Final standings for the eliminated. They occupy the block of positions just
  // below the survivors, ordered by how they stood when they went out.
  const remaining = survivorsBefore - newlyEliminated.length;
  newlyEliminated
    .sort((a, b) => a.position - b.position)
    .forEach(({ player }, i) => {
      player.finalPosition = remaining + 1 + i;
      events.push({
        at,
        checkpoint: index,
        playerId: player.id,
        type: "eliminated",
        position: losses.get(player.id)?.position,
        cutLine: checkpoint.cutLine,
        finalPosition: player.finalPosition,
      });
    });

  // Snapshot the baseline the next checkpoint compares against.
  for (const player of players) {
    if (player.eliminated) continue;
    player.rankAtLastCheckpoint = player.rank ? { ...player.rank } : null;
    player.gamesAtLastCheckpoint = player.rank?.numGames ?? player.gamesAtLastCheckpoint ?? 0;
  }

  let winnerId = state.winnerId;
  const stillAlive = players.filter((p) => !p.eliminated);
  if (stillAlive.length === 1 && survivorsBefore > 1) {
    const champion = stillAlive[0]!;
    champion.finalPosition = 1;
    winnerId = champion.id;
    events.push({ at, checkpoint: index, playerId: champion.id, type: "winner", finalPosition: 1 });
  }

  return {
    state: {
      ...state,
      players,
      winnerId,
      checkpointsApplied: [...state.checkpointsApplied, index],
      events: [...state.events, ...events],
    },
    events,
  };
}

/** Runs every checkpoint that has come due, oldest first. */
export function applyDueCheckpoints(state: State, rules: Rules, now: Date): CheckpointOutcome {
  let current = state;
  const all: GameEvent[] = [];
  for (const index of pendingCheckpoints(current, rules, now)) {
    const result = applyCheckpoint(current, rules, index, now);
    current = result.state;
    all.push(...result.events);
  }
  return { state: current, events: all };
}

/**
 * Generates an evenly spaced checkpoint schedule whose cut line tightens from
 * the starting field down to a single survivor. Handy for bootstrapping a
 * config you then hand-tune.
 */
export function generateSchedule(opts: {
  start: Date;
  intervalHours: number;
  count: number;
  fieldSize: number;
  finalCutLine?: number;
}): Checkpoint[] {
  const { start, intervalHours, count, fieldSize, finalCutLine = 1 } = opts;
  const checkpoints: Checkpoint[] = [];
  for (let i = 0; i < count; i++) {
    const progress = count === 1 ? 1 : (i + 1) / count;
    const cutLine = Math.max(
      finalCutLine,
      Math.round(fieldSize - (fieldSize - finalCutLine) * progress),
    );
    checkpoints.push({
      at: new Date(start.getTime() + i * intervalHours * 3_600_000).toISOString(),
      cutLine,
      label: `Cut ${i + 1}`,
    });
  }
  return checkpoints;
}
