/**
 * Poller entrypoint. Run this on a schedule (cron, GitHub Action, whatever).
 *
 *   npm run poll                       poll everyone, apply any due checkpoints
 *   npm run poll -- --dry-run          poll but do not write state
 *   npm run poll -- --now 2026-08-09T04:00:00Z    pretend it is a given time
 *   npm run poll -- --no-checkpoints   refresh ranks only, never take lives
 *
 * Polling and eliminating are intentionally decoupled: this can run every few
 * minutes safely, because lives are only ever taken when a configured
 * checkpoint timestamp has passed and has not already been applied.
 */

import { fetchProfile } from "./metatft.ts";
import { applyDueCheckpoints, rankSurvivors } from "./rules.ts";
import {
  initState,
  loadRoster,
  loadRules,
  loadState,
  publishRules,
  reconcileRoster,
  saveState,
} from "./store.ts";
import type { PlayerState, State } from "./types.ts";

const HISTORY_CAP = 500;
const CONCURRENCY = 3;
const SPACING_MS = 300;

interface Args {
  dryRun: boolean;
  now: Date;
  skipCheckpoints: boolean;
}

function parseArgs(argv: string[]): Args {
  const nowIndex = argv.indexOf("--now");
  const nowRaw = nowIndex >= 0 ? argv[nowIndex + 1] : undefined;
  const now = nowRaw ? new Date(nowRaw) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error(`invalid --now value: ${nowRaw}`);
  return {
    dryRun: argv.includes("--dry-run"),
    skipCheckpoints: argv.includes("--no-checkpoints"),
    now,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs tasks with a small concurrency cap and polite spacing between starts. */
async function pooled<T>(items: T[], worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++]!;
      await worker(item);
      await sleep(SPACING_MS);
    }
  });
  await Promise.all(runners);
}

function recordReading(player: PlayerState, reading: Awaited<ReturnType<typeof fetchProfile>>) {
  player.rank = reading.rank;
  player.recentPlacements = reading.recentPlacements;
  delete player.lastError;

  // Only append to history when the rating actually moved, so the sparkline
  // stays meaningful and the state file does not grow without bound.
  const last = player.history.at(-1);
  if (!last || last.numeric !== reading.rank.numeric) {
    player.history.push({ t: reading.rank.readAt, numeric: reading.rank.numeric });
    if (player.history.length > HISTORY_CAP) {
      player.history.splice(0, player.history.length - HISTORY_CAP);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [rules, roster] = await Promise.all([loadRules(), loadRoster()]);

  const existing = await loadState();
  let state: State = existing
    ? reconcileRoster(existing, roster, rules)
    : initState(roster, rules, args.now);

  console.log(`polling ${state.players.length} players (set ${rules.tftSet})`);

  let ok = 0;
  let failed = 0;

  // Eliminated players are frozen, so there is no reason to keep fetching them.
  const toPoll = state.players.filter((p) => !p.eliminated);

  await pooled(toPoll, async (player) => {
    try {
      const reading = await fetchProfile(
        {
          gameName: player.gameName,
          tagLine: player.tagLine,
          region: player.region,
        },
        { tftSet: rules.tftSet, queueId: rules.queueId },
      );
      recordReading(player, reading);
      ok++;
      console.log(`  ok    ${player.displayName.padEnd(20)} ${reading.rank.text}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      player.lastError = message;
      failed++;
      console.warn(`  FAIL  ${player.displayName.padEnd(20)} ${message}`);
    }
  });

  state.lastPolledAt = args.now.toISOString();

  if (!args.skipCheckpoints) {
    const { state: next, events } = applyDueCheckpoints(state, rules, args.now);
    state = next;
    for (const event of events) {
      if (event.type === "life_lost") {
        console.log(
          `  life  ${event.playerId} -> ${event.livesRemaining} left ` +
            `(position ${event.position}, cut ${event.cutLine}, ${event.reason})`,
        );
      } else if (event.type === "eliminated") {
        console.log(`  OUT   ${event.playerId} finished ${event.finalPosition}`);
      } else if (event.type === "winner") {
        console.log(`  WIN   ${event.playerId}`);
      }
    }
  }

  const board = rankSurvivors(state.players);
  console.log(`\n${ok} ok, ${failed} failed, ${board.length} still alive`);
  board.slice(0, 10).forEach((p, i) => {
    console.log(`  ${String(i + 1).padStart(2)}. ${p.displayName.padEnd(20)} ${p.rank?.text ?? "—"}  (${p.lives} lives)`);
  });

  if (args.dryRun) {
    console.log("\n--dry-run: state not written");
    return;
  }
  await saveState(state);
  await publishRules(rules);
  console.log("\nstate written");

  // Fail the job loudly if every single fetch failed — that means the endpoint
  // moved or we are blocked, not that players had a bad day.
  if (toPoll.length > 0 && ok === 0) {
    console.error("every fetch failed — check the MetaTFT endpoint");
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
