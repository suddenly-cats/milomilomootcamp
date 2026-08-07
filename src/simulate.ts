/**
 * Offline simulator. Runs a whole event against synthetic ladder movement so
 * you can sanity-check a schedule (and see the UI populated) without touching
 * the network or waiting two weeks.
 *
 *   npm run simulate                  32 players, the schedule in rules.json
 *   npm run simulate -- --players 48
 *   npm run simulate -- --generate 48  print a fresh schedule for a 48 field
 *   npm run simulate -- --write        write the result to web/data/state.json
 *   npm run simulate -- --stop-after 4 halt part-way, for a mid-event UI state
 */

import { applyCheckpoint, generateSchedule, fullLeaderboard } from "./rules.ts";
import { initState, loadRules, publishRules, saveState } from "./store.ts";
import type { RosterEntry, State } from "./types.ts";

const NAMES = [
  "Ashen", "Bramble", "Cinder", "Dusk", "Ember", "Frost", "Gale", "Haze",
  "Iris", "Jinx", "Kite", "Lumen", "Mote", "Nyx", "Onyx", "Pyre",
  "Quill", "Rune", "Slate", "Tide", "Umbra", "Vex", "Wisp", "Xero",
  "Yarrow", "Zephyr", "Aster", "Blight", "Coil", "Drift", "Echo", "Flux",
  "Grove", "Husk", "Ion", "Jade", "Kelp", "Lark", "Moss", "Nova",
  "Opal", "Pike", "Quartz", "Reed", "Sable", "Thorn", "Ursa", "Vale",
];

/** Deterministic PRNG so runs are reproducible. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main() {
  const rules = await loadRules();
  const fieldSize = Number(arg("players", "32"));

  const generateFor = arg("generate");
  if (generateFor) {
    const schedule = generateSchedule({
      start: new Date(new Date().setUTCHours(4, 0, 0, 0) + 86_400_000),
      intervalHours: 24,
      count: 14,
      fieldSize: Number(generateFor),
    });
    console.log(JSON.stringify(schedule, null, 2));
    return;
  }

  const roster: RosterEntry[] = Array.from({ length: fieldSize }, (_, i) => ({
    gameName: NAMES[i % NAMES.length] ?? `Player${i}`,
    tagLine: String(1000 + i),
    region: "NA",
  }));

  const random = rng(42);
  let state: State = initState(roster, rules, new Date(rules.checkpoints[0]!.at));

  // Seed everyone somewhere in Master..Challenger.
  for (const p of state.players) {
    const numeric = 2800 + Math.floor(random() * 900);
    p.rank = { text: `${numeric - 2800} LP`, numeric, numGames: 0, readAt: state.startedAt };
    p.gamesAtLastCheckpoint = 0;
  }

  console.log(`simulating ${fieldSize} players over ${rules.checkpoints.length} checkpoints\n`);

  // Stopping early leaves the board mid-event, which is the only way to see the
  // cut-line divider and a mix of alive/eliminated players in the UI.
  const stopAfter = Number(arg("stop-after", String(rules.checkpoints.length)));
  let lastAppliedAt = state.startedAt;

  /** Everyone plays some games and drifts up or down, as a poll would observe. */
  const drift = (at: string) => {
    for (const p of state.players) {
      if (p.eliminated || !p.rank) continue;
      const games = Math.floor(random() * 12);
      const swing = Math.round((random() - 0.45) * 220);
      const numeric = Math.max(2800, p.rank.numeric + swing);
      p.rank = {
        text: `${numeric - 2800} LP`,
        numeric,
        numGames: p.rank.numGames + games,
        readAt: at,
      };
      p.history.push({ t: at, numeric });
    }
  };

  rules.checkpoints.slice(0, stopAfter).forEach((cp, i) => {
    drift(cp.at);

    const result = applyCheckpoint(state, rules, i, new Date(cp.at));
    state = result.state;
    lastAppliedAt = cp.at;

    const alive = state.players.filter((p) => !p.eliminated).length;
    const out = result.events.filter((e) => e.type === "eliminated").length;
    console.log(
      `${(cp.label ?? `#${i + 1}`).padEnd(8)} cut ${String(cp.cutLine).padStart(3)}  ` +
        `-${String(out).padStart(2)} out  ${String(alive).padStart(3)} alive` +
        (state.winnerId ? `  WINNER: ${state.winnerId}` : ""),
    );
  });

  // Mid-event, the board would have been polled since the last checkpoint, so
  // drift once more. Without this every LP delta in the UI reads as zero.
  const stoppedEarly = stopAfter < rules.checkpoints.length;
  if (stoppedEarly) {
    lastAppliedAt = new Date(new Date(lastAppliedAt).getTime() + 6 * 3600_000).toISOString();
    drift(lastAppliedAt);
  }

  console.log("\nfinal standings (top 8):");
  fullLeaderboard(state.players)
    .slice(0, 8)
    .forEach((p, i) => {
      const pos = p.finalPosition ?? i + 1;
      console.log(`  ${String(pos).padStart(2)}. ${p.displayName.padEnd(16)} ${p.rank?.text ?? "—"}  ${p.lives} lives`);
    });

  // Only a complete run says anything about whether the schedule converges.
  if (!state.winnerId && stopAfter >= rules.checkpoints.length) {
    console.log("\nNOTE: schedule ended with more than one player alive — tighten the final cut lines.");
  }

  if (process.argv.includes("--write")) {
    state.lastPolledAt = lastAppliedAt;
    await saveState(state);
    await publishRules(rules);
    console.log("\nwrote web/data/state.json (simulated)");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
