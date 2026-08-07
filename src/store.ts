/**
 * Persistence. State is a single JSON file, which keeps this deployable
 * anywhere — a server with a disk, or a GitHub Action that commits the file
 * back to the repo. Swap this module for a real database if the roster ever
 * outgrows a few hundred players.
 */

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PlayerState, RosterEntry, Rules, State } from "./types.ts";
import { playerId } from "./metatft.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, "..");
export const RULES_PATH = resolve(ROOT, "config/rules.json");
export const PLAYERS_PATH = resolve(ROOT, "config/players.json");
export const STATE_PATH = resolve(ROOT, "web/data/state.json");

export async function loadRules(path = RULES_PATH): Promise<Rules> {
  const rules = JSON.parse(await readFile(path, "utf8")) as Rules;
  if (!Array.isArray(rules.checkpoints) || rules.checkpoints.length === 0) {
    throw new Error("rules.json must define at least one checkpoint");
  }
  // Checkpoints must be chronological, since each one's baseline depends on the last.
  const sorted = [...rules.checkpoints].sort(
    (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime(),
  );
  return { ...rules, checkpoints: sorted };
}

export async function loadRoster(path = PLAYERS_PATH): Promise<RosterEntry[]> {
  const roster = JSON.parse(await readFile(path, "utf8")) as RosterEntry[];
  const seen = new Set<string>();
  for (const entry of roster) {
    const id = playerId(entry);
    if (seen.has(id)) throw new Error(`duplicate player in roster: ${id}`);
    seen.add(id);
  }
  return roster;
}

function blankPlayer(entry: RosterEntry): PlayerState {
  return {
    id: playerId(entry),
    gameName: entry.gameName,
    tagLine: entry.tagLine,
    region: entry.region.toUpperCase(),
    displayName: entry.displayName ?? playerId(entry),
    team: entry.team,
    lives: 0, // filled in by reconcile, which knows the rules
    eliminated: false,
    rank: null,
    rankAtLastCheckpoint: null,
    gamesAtLastCheckpoint: null,
    recentPlacements: [],
    history: [],
  };
}

/** Fresh state for a roster that has never been polled. */
export function initState(roster: RosterEntry[], rules: Rules, now: Date): State {
  return {
    version: 1,
    title: rules.title,
    startedAt: now.toISOString(),
    lastPolledAt: null,
    checkpointsApplied: [],
    players: roster.map((entry) => ({ ...blankPlayer(entry), lives: rules.startingLives })),
    events: [],
    winnerId: null,
  };
}

/**
 * Folds roster edits into existing state: new players join with full lives,
 * removed players are dropped, and metadata (display name, team) is refreshed.
 * Progress for everyone already present is preserved.
 */
export function reconcileRoster(state: State, roster: RosterEntry[], rules: Rules): State {
  const byId = new Map(state.players.map((p) => [p.id, p]));
  const players = roster.map((entry) => {
    const id = playerId(entry);
    const existing = byId.get(id);
    if (!existing) return { ...blankPlayer(entry), lives: rules.startingLives };
    return {
      ...existing,
      region: entry.region.toUpperCase(),
      displayName: entry.displayName ?? existing.displayName,
      team: entry.team,
    };
  });
  return { ...state, title: rules.title, players };
}

export async function loadState(path = STATE_PATH): Promise<State | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as State;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Writes atomically, so a crash mid-write cannot leave a truncated state file. */
export async function saveState(state: State, path = STATE_PATH): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

/**
 * Copies the ruleset next to the state file so the frontend can show the cut
 * line and the countdown to the next checkpoint without a backend.
 */
export async function publishRules(rules: Rules, dir = dirname(STATE_PATH)): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, "rules.json"), `${JSON.stringify(rules, null, 2)}\n`, "utf8");
}
