# BoxBox-style TFT Survivor Leaderboard — Handoff

Status as of 2026-08-07. Written to be handed to Claude Code (or any dev) to continue.

## What this is

A clone of the format at <https://na.boxboxtft.com/pro>. A fixed roster of TFT players is
polled on a schedule; their ranks are read from MetaTFT and ranked into a leaderboard. At
scheduled **checkpoints**, every surviving player ranked below a **cut line** loses a life.
At zero lives they are eliminated. The cut line tightens over time until one player is left.

Confirmed with the user: the cut line is a **leaderboard position** (e.g. "top 30 survive"),
not a per-game placement. Losing a life is about where you sit on the board, not whether you
bottom-foured a given lobby.

## Current status

| Area | State |
|---|---|
| MetaTFT endpoint discovery | **Done, verified against live API** |
| Response parsing | Done, 25 unit tests green |
| Elimination engine | Done, 25 unit tests green |
| Persistence (JSON state) | Done |
| Poller CLI | **Verified end to end against the live API, 2026-08-07** |
| Frontend leaderboard | **Verified** against mid-event and finished simulated states |
| Dev server | Done, smoke-tested (200s, path traversal blocked) |
| Offline simulator | Done, converges 32 players → 1 winner |
| Deployment | **Live** at <https://suddenly-cats.github.io/milomilomootcamp/> |
| Real roster | 4 real VN players, all verified live; **more to be added** |
| Real ruleset numbers | **Schedule is still the 32-player default** — see the warning below |

## The key finding: how to actually get rank data

`metatft.com/player/...` is a client-rendered React app. The served HTML contains no rank —
just a shell and "You need to enable JavaScript to run this app". Scraping the HTML gets you
nothing. The user supplied the JSON endpoint their frontend calls, which is what we use:

```
GET https://api.metatft.com/public/profile/lookup_by_riotid/{PLATFORM}/{gameName}/{tagLine}
      ?source=profile&tft_set={SET}&include_revival_matches=false
```

Two shape changes from the browser URL: `metatft.com/player/vn/Raikugen-four` uses a friendly
region and a dash; the API uses a **Riot platform id** and a **slash** → `VN2/Raikugen/four`.
The region map lives in `src/metatft.ts`.

`source=full_profile` returns the same shape with a larger payload; `source=profile` is enough.

### Response shape (verified live, 2026-08-07)

```json
{
  "summoner": { "id": 138147192, "puuid": "...", "summoner_region": "vn2",
                "riot_id": "Raikugen#four", "summoner_level": 1392,
                "is_profile_hidden": false },
  "ranked":   { "num_games": 450,
                "rating_text": "GRANDMASTER I 742 LP",
                "rating_numeric": 3542,
                "peak_rating": "CHALLENGER I 1205 LP",
                "peak_rating_numeric": 4005,
                "timestamp": "2026-07-28T16:04:48.325228" },
  "matches":  [ { "placement": 2, "riot_match_id": "VN2_1519666119",
                  "match_timestamp": 1785254285900, "queue_id": 1100,
                  "tft_set": "TFTSet17", "patch": "16.14",
                  "summary": { "units": [...], "traits": [...],
                               "player_rating": "GRANDMASTER I 711 LP" } } ],
  "rating_history": [...],
  "ranked_season_stats": [...]
}
```

`matches` is 50 deep. Filter on `queue_id === 1100` (ranked) and `tft_set` — the array
includes double-up and previous-set games.

### `rating_numeric` — the important field

A single sortable integer, so ranking the board is a numeric sort with no tier/division
string parsing. **Verified**: for Master and above, `rating_numeric = LP + 2800`
(742 → 3542, and 1205 → 4005 both check out).

**Inferred, not verified**: below Master, `tier*400 + division*100 + LP` with Iron IV at 0.
Seven sub-Master tiers × four divisions × 100 lands exactly on 2800 at Master, which is
strong evidence, but nobody on a real roster was below Master to confirm it. Only matters if
you track sub-Master players. `formatRating()` in `src/metatft.ts` encodes this assumption —
prefer the stored `rating_text` for display and treat `formatRating` as a fallback.

## Network verification (2026-08-07, resolved)

The original build sandbox could not reach `api.metatft.com`, so the fetch path had never
executed. **That has now been run from a machine with network access and it works.**

- `npm run poll -- --dry-run` against the live API returns
  `ok Raikugen GRANDMASTER I 742 LP`. URL building, region mapping, fetch, parse, ranking
  and the dry-run guard are all confirmed working.
- **404 path**: a nonexistent Riot ID fails in ~350 ms, i.e. it correctly does *not* burn the
  retry budget.
- **Timeout path**: a 1 ms timeout aborts and exhausts retries as designed.
- **Rate limits**: 8 concurrent requests with no spacing at all returned **8/8 in 485 ms**.
  No throttling was observed.

So the politeness settings (3 concurrent, 300 ms apart, 3 retries, 15 s timeout) are
comfortably conservative — a 100-player roster polls in roughly 20 s. They were left as-is,
since a burst of 8 is weak evidence about sustained load, but there is no reason to think a
real roster needs them loosened *or* tightened.

Still unexercised: 429 and 5xx handling (MetaTFT never returned either during testing).

## Architecture

Deliberately hosting-agnostic. State is one JSON file, so this runs either as a long-lived
server or as a GitHub Action that commits the file back to the repo. Nothing is tied to a
database or a specific platform yet.

```
config/rules.json      ruleset: lives, checkpoint schedule, cut lines, tft set
config/players.json    the roster (currently ONE placeholder player)
src/types.ts           shared types, heavily commented
src/metatft.ts         data source adapter: url building, region map, parsing, retries
src/rules.ts           elimination engine — PURE, no I/O, no clock. The heart of it.
src/store.ts           load/save state, roster reconciliation, atomic writes
src/poll.ts            CLI entrypoint: fetch everyone, apply due checkpoints, save
src/simulate.ts        offline simulator, synthetic ladder movement
scripts/run-tests.mjs  cross-platform test discovery (see Running it)
src/serve.ts           dev-only static server
src/rules.test.ts      25 tests, all green
fixtures/profile.json  real MetaTFT payload, trimmed
web/index.html         self-contained frontend, reads data/state.json
web/data/              generated: state.json + rules.json (currently SIMULATED data)
```

`src/rules.ts` being pure is the load-bearing design decision — it is why the whole ruleset
is testable without a network or a two-week wait.

## Ruleset semantics

**Polling and eliminating are separate.** Polls run often (keep the board fresh); checkpoints
are rare scheduled moments where lives are actually taken. Without this split, anyone below
the cut line would lose every life within minutes of falling behind. This matters and is easy
to get wrong.

At each checkpoint:

1. Rank survivors best-first by `rating_numeric` (ties: fewer games, then id; no rank sorts last).
2. Anyone at position `> cutLine` loses one life.
3. Optionally, anyone who played fewer than `minGames` since the last checkpoint loses one life.
4. Max **one life lost per checkpoint** regardless of how many conditions are tripped.
5. Zero lives → eliminated, with a final position assigned in the block just below the survivors.
6. One survivor left → winner at position 1.

The cut line applies to **survivors only**, so the field tightens on its own as players go out,
on top of whatever curve is configured.

Checkpoints are **idempotent** (replaying one takes no extra lives) and **catch up** (if the
poller is down for a day, the next run applies every missed checkpoint in order). Both are tested.

## Decisions made 2026-08-07

- **Hosting: GitHub Actions cron + Pages.** Written as `.github/workflows/poll.yml`. See
  "Deployment" below for the one-time repo setup it still needs.
- **`minGames` stays on.** The user confirmed an inactive player should not be able to coast
  on a good rank. The threshold of 3 games per checkpoint is still an invented number —
  revisit it once the real cadence is set.
- **`git init` has been run.** There are no commits and no remote yet.

## Roster (as of 2026-08-07)

Four players, all on VN, all confirmed to resolve against the live API:

| Riot ID | Rank at first poll | `rating_numeric` |
|---|---|---|
| Raikugen#four | GRANDMASTER I 742 LP | 3542 |
| zod1ac#yotlo | MASTER I 451 LP | 3251 |
| VP Succulento#poggo | MASTER I 0 LP | 2800 |
| quanggisme#1234 | MASTER I 0 LP | 2800 |

More players are to be added later. Two notes:

- `VP Succulento` has a **space** in the game name. `buildUrl` percent-encodes it, which was
  verified live — do not "fix" that encoding.
- The bottom two are tied at exactly 2800. The tiebreak (fewer games first) puts VP Succulento
  above quanggisme, which is what the board shows. Incidentally, `MASTER I 0 LP == 2800`
  directly confirms the `MASTER_FLOOR` constant that was previously only inferred.

## ⚠ The schedule does not match the field size

`config/rules.json` still carries the **32-player** default schedule (cut line 30 → 1 over 14
daily checkpoints) while the roster has 4 players. This was a deliberate choice — the roster is
going to grow — but until it does, the consequence is:

- The **position cut is inert.** A cut line of 30 with 4 players cuts nobody. Positions only
  start to matter at Day 13 (cut 3) and Finals (cut 1).
- **`minGames: 3` is the only rule with teeth**, and it applies from Day 1. Every player who
  plays fewer than 3 ranked games between checkpoints loses a life, so with 3 starting lives a
  quiet player is eliminated in three days without position ever being involved.

Regenerate the schedule once the field is final: `npm run simulate -- --generate <N>`.
Sanity-check it end to end with `npm run simulate -- --players <N>`, which will warn if the
curve does not converge to a single winner.

## Deployment — live

- **Site:** <https://suddenly-cats.github.io/milomilomootcamp/>
- **Repo:** <https://github.com/suddenly-cats/milomilomootcamp> (public)

`.github/workflows/poll.yml` polls every 30 minutes, commits `web/data/`, and publishes `web/`
to Pages. Verified end to end on 2026-08-07: the workflow ran, fetched all four players from
the runner, committed `poll: update leaderboard state`, and deployed. **MetaTFT is reachable
from GitHub Actions runners** — worth recording, since the original build sandbox was blocked.

The one-time repo setup is already done (Pages source set to GitHub Actions, workflow
permissions set to read/write). Redoing it is only necessary in a fresh fork.

Two traps that are already handled, and should stay handled:

- Poll and Pages deploy are **one workflow, two jobs**. Commits pushed with the default
  `GITHUB_TOKEN` do not trigger other workflows, so a separate push-triggered Pages workflow
  would silently never run.
- GitHub's cron is best-effort and is often late. That is harmless here only because
  checkpoints fire on timestamp and catch up — do not "fix" this by making the schedule
  authoritative.

Scheduled workflows are disabled automatically on repos with no activity for 60 days, which
matters if an event runs long or the repo sits idle between seasons. (In practice the poller's
own commits count as activity while an event is running, so this only bites between seasons.)

Runs currently emit a Node 20 deprecation warning: `actions/checkout@v4` and
`actions/setup-node@v4` are being forced onto Node 24. Harmless today; bump to v5 when
convenient.

`fixtures/profile.json` has had its `puuid` redacted, since the repo is public and the parser
never reads that field. Do not paste a raw payload back in.

**Pages serves `index.html` with `Cache-Control: max-age=600`.** After deploying a frontend
change, browsers keep showing the old page for up to ten minutes — it looks exactly like a
failed deploy. Before debugging, confirm what the server actually has:

```bash
curl -s https://suddenly-cats.github.io/milomilomootcamp/ | grep -c rank-icon
```

`data/state.json` is exempt: the page fetches it with `cache: "no-store"`, which is why ranks
refresh immediately while markup changes lag.

Pushing to `main` does **not** deploy — the workflow only runs on cron and manual dispatch, so
a frontend change waits for the next poll (≤30 min) unless you run
`gh workflow run poll.yml`. Adding a `push` trigger would fix that; it was left off to keep
pushes from making live API calls. There is no infinite-loop risk if you add it, because
commits made with the default `GITHUB_TOKEN` do not trigger workflows.

## Frontend notes

Rank badges (`rankIcon` in `web/index.html`) are **our own SVG shields, not Riot's emblem
art** — nothing hotlinked, nothing to license, page stays self-contained. Chevron count rises
through the apex tiers and Challenger gets a crown, so tiers do not depend on colour alone;
the badges are `aria-hidden` because the full rank text sits beside them.

Player names link to the **browser-shape** MetaTFT URL — friendly lowercase region and a dash,
`.../player/vn/Raikugen-four` — which is *not* the platform-id-and-slash shape the API takes
(`VN2/Raikugen/four`). Both were verified live, including `VP Succulento`, whose game name
contains a space and percent-encodes to `VP%20Succulento-poggo`.

## Running it

```bash
npm install
npm test                     # 25 tests, no network needed
npm run typecheck
npm run simulate -- --players 32          # dry-run a whole event
npm run simulate -- --players 32 --write  # ...and populate web/data for the UI
npm run simulate -- --players 32 --stop-after 5 --write   # mid-event board
npm run poll -- --dry-run    # real fetch, no writes  ← verified working
npm run poll                 # real fetch, writes state
npm run serve                # http://localhost:5173
```

`--stop-after <n>` halts the simulation after `n` checkpoints instead of running to a
winner. Use it to see the UI in its normal state: cut-line divider, a mix of alive and
eliminated players, and non-zero LP deltas. A full run ends with one survivor and no
divider, which is the least representative view of the page.

`npm test` shells out to `scripts/run-tests.mjs`. It used to be `tsx --test src/*.test.ts`,
which silently ran **zero tests** on Windows — neither cmd/PowerShell nor Node 20's `--test`
expands that glob. The script discovers the files and passes them explicitly.

Useful flags on `poll`: `--now <iso>` (pretend it is another time, for testing checkpoint
firing), `--no-checkpoints` (refresh ranks without ever taking lives).

**`web/data/state.json` currently contains simulated data**, not real ranks. Delete it before
the first real run, or the fake players will be reconciled away on the first poll anyway.

## Suggested next steps

Steps 1 and 2 of the previous list (verify the live fetch, verify the UI) are **done** — see
the status table and the network section above. What is left is everything that needs a
decision from the user:

1. Get the real roster and replace `config/players.json`. Everything downstream is blocked on
   this: field size determines the checkpoint schedule, which determines the cut-line curve.
2. Confirm the real ruleset numbers and replace `config/rules.json` — starting lives,
   checkpoint cadence and times, and whether `minGames` should exist at all.
3. **This is not a git repository yet.** `git init` is a prerequisite for the GitHub Actions
   hosting option below.
4. Pick hosting and write the deploy path. If GitHub Actions: a workflow on a cron that runs
   `npm run poll` and commits `web/data/`, plus Pages serving `web/`. Watch out for the
   Action's default `GITHUB_TOKEN` needing `contents: write`.
5. Consider adding: LP-over-time sparklines (`player.history` is already being recorded, so
   this is a pure frontend job), a public "rules" page, and an `?embed` mode for overlays.

## Things a future session should not re-litigate

- Don't try to scrape the HTML. It is a JS shell; there is no rank in it.
- Don't reach for the Riot API unless MetaTFT breaks. It was offered and the user explicitly
  chose MetaTFT polling.
- Don't collapse polling and checkpoints back into one step.
