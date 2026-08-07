import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { applyCheckpoint, applyDueCheckpoints, generateSchedule, rankSurvivors } from "./rules.ts";
import { buildUrl, parseProfile, toPlatform } from "./metatft.ts";
import { ROOT } from "./store.ts";
import type { PlayerState, Rules, State } from "./types.ts";

// ---------------------------------------------------------------- helpers

function player(id: string, numeric: number | null, lives = 3, numGames = 100): PlayerState {
  return {
    id,
    gameName: id,
    tagLine: "na1",
    region: "NA",
    displayName: id,
    lives,
    eliminated: false,
    rank: numeric === null ? null : { text: `${numeric}`, numeric, numGames, readAt: "2026-08-01T00:00:00.000Z" },
    rankAtLastCheckpoint: null,
    gamesAtLastCheckpoint: null,
    recentPlacements: [],
    history: [],
  };
}

function makeState(players: PlayerState[]): State {
  return {
    version: 1,
    title: "test",
    startedAt: "2026-08-01T00:00:00.000Z",
    lastPolledAt: null,
    checkpointsApplied: [],
    players,
    events: [],
    winnerId: null,
  };
}

function makeRules(checkpoints: Rules["checkpoints"], overrides: Partial<Rules> = {}): Rules {
  return {
    title: "test",
    tftSet: "TFTSet17",
    queueId: 1100,
    startingLives: 3,
    penaliseMissingRank: false,
    checkpoints,
    ...overrides,
  };
}

const T1 = "2026-08-02T00:00:00.000Z";
const T2 = "2026-08-03T00:00:00.000Z";

// ---------------------------------------------------------------- ranking

test("leaderboard sorts by rating descending", () => {
  const board = rankSurvivors([player("c", 3000), player("a", 3500), player("b", 3200)]);
  assert.deepEqual(board.map((p) => p.id), ["a", "b", "c"]);
});

test("ties break on fewer games played, then id", () => {
  const board = rankSurvivors([
    player("b", 3000, 3, 200),
    player("a", 3000, 3, 200),
    player("c", 3000, 3, 50),
  ]);
  assert.deepEqual(board.map((p) => p.id), ["c", "a", "b"]);
});

test("players with no rank reading sort last", () => {
  const board = rankSurvivors([player("noRank", null), player("ranked", 100)]);
  assert.deepEqual(board.map((p) => p.id), ["ranked", "noRank"]);
});

test("eliminated players are excluded from the survivor board", () => {
  const dead = { ...player("dead", 9999), eliminated: true };
  const board = rankSurvivors([dead, player("alive", 100)]);
  assert.deepEqual(board.map((p) => p.id), ["alive"]);
});

// ---------------------------------------------------------------- cut line

test("only players strictly below the cut line lose a life", () => {
  const state = makeState([
    player("first", 4000),
    player("second", 3000),
    player("third", 2000),
    player("fourth", 1000),
  ]);
  const rules = makeRules([{ at: T1, cutLine: 2 }]);

  const { state: next } = applyCheckpoint(state, rules, 0, new Date(T1));
  const lives = Object.fromEntries(next.players.map((p) => [p.id, p.lives]));

  assert.equal(lives.first, 3, "1st is safe");
  assert.equal(lives.second, 3, "2nd is exactly on the line, so safe");
  assert.equal(lives.third, 2, "3rd is below the line");
  assert.equal(lives.fourth, 2, "4th is below the line");
});

test("a cut line larger than the field eliminates nobody", () => {
  const state = makeState([player("a", 100), player("b", 50)]);
  const rules = makeRules([{ at: T1, cutLine: 99 }]);
  const { state: next } = applyCheckpoint(state, rules, 0, new Date(T1));
  assert.ok(next.players.every((p) => p.lives === 3));
});

test("a player loses at most one life per checkpoint", () => {
  // Below the cut line AND short on games: still only one life.
  const state = makeState([player("top", 4000), player("bottom", 100)]);
  const rules = makeRules([{ at: T1, cutLine: 1, minGames: 50 }]);
  const { state: next } = applyCheckpoint(state, rules, 0, new Date(T1));
  assert.equal(next.players.find((p) => p.id === "bottom")!.lives, 2);
});

// ---------------------------------------------------------------- elimination

test("a player is eliminated when lives reach zero", () => {
  const state = makeState([player("safe", 4000), player("doomed", 100, 1)]);
  const rules = makeRules([{ at: T1, cutLine: 1 }]);
  const { state: next } = applyCheckpoint(state, rules, 0, new Date(T1));

  const doomed = next.players.find((p) => p.id === "doomed")!;
  assert.equal(doomed.lives, 0);
  assert.equal(doomed.eliminated, true);
  assert.equal(doomed.eliminatedAtCheckpoint, 0);
});

test("eliminated players get final positions below the survivors, best first", () => {
  const state = makeState([
    player("a", 4000),
    player("b", 3000),
    player("c", 2000, 1),
    player("d", 1000, 1),
  ]);
  const rules = makeRules([{ at: T1, cutLine: 2 }]);
  const { state: next } = applyCheckpoint(state, rules, 0, new Date(T1));
  const byId = Object.fromEntries(next.players.map((p) => [p.id, p]));

  assert.equal(byId.c!.finalPosition, 3, "better of the two eliminated finishes 3rd");
  assert.equal(byId.d!.finalPosition, 4);
  assert.equal(byId.a!.finalPosition, undefined, "survivors have no final position yet");
});

test("the cut line applies to survivors only, so the field tightens naturally", () => {
  const players = [
    { ...player("dead1", 9999), eliminated: true, finalPosition: 4 },
    { ...player("dead2", 9998), eliminated: true, finalPosition: 3 },
    player("alive1", 300),
    player("alive2", 200, 1),
  ];
  const state = makeState(players);
  // Cut line 1 among the two survivors: alive2 is 2nd, so it goes.
  const rules = makeRules([{ at: T1, cutLine: 1 }]);
  const { state: next } = applyCheckpoint(state, rules, 0, new Date(T1));

  assert.equal(next.players.find((p) => p.id === "alive2")!.eliminated, true);
  assert.equal(next.winnerId, "alive1");
});

test("the last player standing is declared the winner at position 1", () => {
  const state = makeState([player("champ", 4000), player("other", 100, 1)]);
  const rules = makeRules([{ at: T1, cutLine: 1 }]);
  const { state: next, events } = applyCheckpoint(state, rules, 0, new Date(T1));

  assert.equal(next.winnerId, "champ");
  assert.equal(next.players.find((p) => p.id === "champ")!.finalPosition, 1);
  assert.ok(events.some((e) => e.type === "winner"));
});

// ---------------------------------------------------------------- scheduling

test("checkpoints are idempotent — replaying one takes no extra lives", () => {
  const state = makeState([player("a", 4000), player("b", 100)]);
  const rules = makeRules([{ at: T1, cutLine: 1 }]);

  const once = applyCheckpoint(state, rules, 0, new Date(T1)).state;
  const twice = applyCheckpoint(once, rules, 0, new Date(T1)).state;

  assert.equal(twice.players.find((p) => p.id === "b")!.lives, 2);
  assert.deepEqual(twice.checkpointsApplied, [0]);
});

test("future checkpoints are not applied early", () => {
  const state = makeState([player("a", 4000), player("b", 100)]);
  const rules = makeRules([{ at: T2, cutLine: 1 }]);
  const { state: next } = applyDueCheckpoints(state, rules, new Date(T1));

  assert.deepEqual(next.checkpointsApplied, []);
  assert.equal(next.players.find((p) => p.id === "b")!.lives, 3);
});

test("a missed checkpoint is caught up on the next poll", () => {
  const state = makeState([player("a", 4000), player("b", 100)]);
  const rules = makeRules([
    { at: T1, cutLine: 1 },
    { at: T2, cutLine: 1 },
  ]);
  // Poller was down all day and only runs after both checkpoints passed.
  const { state: next } = applyDueCheckpoints(state, rules, new Date("2026-08-04T00:00:00.000Z"));

  assert.deepEqual(next.checkpointsApplied, [0, 1]);
  assert.equal(next.players.find((p) => p.id === "b")!.lives, 1);
});

// ---------------------------------------------------------------- min games

test("survivors above the line still lose a life for not playing enough", () => {
  const state = makeState([player("grinder", 4000, 3, 120), player("idler", 3000, 3, 100)]);
  state.players.forEach((p) => (p.gamesAtLastCheckpoint = 100));
  const rules = makeRules([{ at: T1, cutLine: 10, minGames: 5 }]);

  const { state: next } = applyCheckpoint(state, rules, 0, new Date(T1));
  assert.equal(next.players.find((p) => p.id === "grinder")!.lives, 3, "played 20 games");
  assert.equal(next.players.find((p) => p.id === "idler")!.lives, 2, "played 0 games");
});

test("the games baseline advances with each checkpoint", () => {
  const state = makeState([player("a", 4000, 3, 110)]);
  state.players[0]!.gamesAtLastCheckpoint = 100;
  const rules = makeRules([{ at: T1, cutLine: 10, minGames: 5 }]);
  const { state: next } = applyCheckpoint(state, rules, 0, new Date(T1));
  assert.equal(next.players[0]!.gamesAtLastCheckpoint, 110);
});

// ---------------------------------------------------------------- missing data

test("missing rank data is forgiven by default", () => {
  const state = makeState([player("a", 4000), player("offline", null)]);
  const rules = makeRules([{ at: T1, cutLine: 10 }]);
  const { state: next } = applyCheckpoint(state, rules, 0, new Date(T1));
  assert.equal(next.players.find((p) => p.id === "offline")!.lives, 3);
});

test("missing rank data costs a life when penaliseMissingRank is on", () => {
  const state = makeState([player("a", 4000), player("offline", null)]);
  const rules = makeRules([{ at: T1, cutLine: 10 }], { penaliseMissingRank: true });
  const { state: next } = applyCheckpoint(state, rules, 0, new Date(T1));
  assert.equal(next.players.find((p) => p.id === "offline")!.lives, 2);
});

// ---------------------------------------------------------------- schedule gen

test("generated schedules tighten to a single survivor", () => {
  const schedule = generateSchedule({
    start: new Date(T1),
    intervalHours: 24,
    count: 10,
    fieldSize: 40,
  });
  assert.equal(schedule.length, 10);
  assert.equal(schedule.at(-1)!.cutLine, 1);
  const lines = schedule.map((c) => c.cutLine);
  assert.deepEqual(lines, [...lines].sort((a, b) => b - a), "cut lines never loosen");
});

// ---------------------------------------------------------------- metatft

test("region codes map to Riot platform ids", () => {
  assert.equal(toPlatform("vn"), "VN2");
  assert.equal(toPlatform("NA"), "NA1");
  assert.equal(toPlatform("EUW1"), "EUW1", "platform ids pass through");
  assert.throws(() => toPlatform("nowhere"), /Unknown region/);
});

test("the request url matches the endpoint shape", () => {
  const url = buildUrl({ gameName: "Raikugen", tagLine: "four", region: "VN" }, "TFTSet17");
  assert.equal(
    url,
    "https://api.metatft.com/public/profile/lookup_by_riotid/VN2/Raikugen/four" +
      "?source=profile&tft_set=TFTSet17&include_revival_matches=false",
  );
});

test("names with spaces and unicode are url encoded", () => {
  const url = buildUrl({ gameName: "Big Bad", tagLine: "NA 1", region: "NA" }, "TFTSet17");
  assert.ok(url.includes("/NA1/Big%20Bad/NA%201?"));
});

test("a live profile payload parses into a rank and recent placements", async () => {
  const body = JSON.parse(await readFile(resolve(ROOT, "fixtures/profile.json"), "utf8"));
  const { rank, recentPlacements } = parseProfile(body, { tftSet: "TFTSet17", queueId: 1100 });

  assert.equal(rank.text, "GRANDMASTER I 742 LP");
  assert.equal(rank.numeric, 3542);
  assert.equal(rank.numGames, 450);

  // Only ranked (1100) games from the current set, newest first.
  assert.deepEqual(recentPlacements.map((m) => m.placement), [2, 7]);
});

test("master+ ratings are LP plus 2800", async () => {
  const body = JSON.parse(await readFile(resolve(ROOT, "fixtures/profile.json"), "utf8"));
  const { rank } = parseProfile(body, { tftSet: "TFTSet17", queueId: 1100 });
  assert.equal(rank.numeric - 2800, 742, "matches the LP in rating_text");
});

test("a payload with no ranked block is rejected rather than silently zeroed", () => {
  assert.throws(
    () => parseProfile({ summoner: { riot_id: "x#1" } }, { tftSet: "TFTSet17", queueId: 1100 }),
    /no ranked rating/,
  );
});
