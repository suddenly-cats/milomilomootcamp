# MiloMiloMootcamp

A TFT ladder survival leaderboard. A fixed roster of players is polled from
[MetaTFT](https://www.metatft.com/) and ranked into a live board. At scheduled **checkpoints**,
every surviving player sitting below a **cut line** loses a life. At zero lives they are
eliminated. The cut line tightens over time until one player is left standing.

The cut line is a **leaderboard position**, not a per-game placement — what matters is where
you sit on the board, not whether you bottom-foured a given lobby.

## How it runs

A GitHub Actions cron job polls MetaTFT every 30 minutes, applies any checkpoints that have
come due, commits the resulting state, and publishes the site to GitHub Pages. There is no
server and no database: the entire event lives in one JSON file, `web/data/state.json`.

Polling and eliminating are deliberately separate. Polls are frequent and only refresh ranks;
lives are taken **only** at configured checkpoint timestamps. Checkpoints are idempotent
(replaying one takes no extra lives) and catch up (if the poller is down for a day, the next
run applies every checkpoint it missed, in order).

## Configuration

| File | What it controls |
|---|---|
| `config/players.json` | The roster: Riot ID and region per player |
| `config/rules.json` | Event title, starting lives, and the checkpoint schedule |

## Development

```bash
npm install
npm test                                  # unit tests, no network needed
npm run typecheck
npm run simulate -- --players 32          # dry-run a whole event offline
npm run simulate -- --players 32 --stop-after 5 --write   # mid-event board for the UI
npm run poll -- --dry-run                 # real fetch, no writes
npm run serve                             # http://localhost:5173
```

The elimination engine in `src/rules.ts` is pure — no I/O, no clock — which is why a full
event can be simulated offline in milliseconds instead of waiting two weeks to find out the
schedule was wrong.

See [HANDOFF.md](HANDOFF.md) for design notes, the MetaTFT API details, and current status.
