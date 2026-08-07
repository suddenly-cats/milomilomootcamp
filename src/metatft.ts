/**
 * MetaTFT data source.
 *
 * The player pages on metatft.com are a client-rendered React app, so the rank
 * is not in the served HTML. This hits the JSON endpoint the site's own
 * frontend calls, which is both lighter and far more stable than DOM scraping.
 *
 *   GET https://api.metatft.com/public/profile/lookup_by_riotid/{PLATFORM}/{gameName}/{tagLine}
 *         ?source=profile&tft_set={SET}&include_revival_matches=false
 *
 * Note the two shape changes from the browser URL: metatft.com/player/vn/Name-tag
 * uses a friendly region and a dash, the API uses a platform id and a slash.
 */

import type { MatchResult, RankSnapshot, RosterEntry } from "./types.ts";

const API_BASE = "https://api.metatft.com/public/profile/lookup_by_riotid";

/** Friendly region code -> Riot platform id used in the API path. */
const PLATFORM_BY_REGION: Record<string, string> = {
  NA: "NA1",
  EUW: "EUW1",
  EUNE: "EUN1",
  KR: "KR",
  BR: "BR1",
  JP: "JP1",
  LAN: "LA1",
  LAS: "LA2",
  OCE: "OC1",
  TR: "TR1",
  RU: "RU",
  PH: "PH2",
  SG: "SG2",
  TH: "TH2",
  TW: "TW2",
  VN: "VN2",
  ME: "ME1",
};

export function toPlatform(region: string): string {
  const key = region.trim().toUpperCase();
  // Allow passing a platform id directly (e.g. "VN2").
  if (Object.values(PLATFORM_BY_REGION).includes(key)) return key;
  const platform = PLATFORM_BY_REGION[key];
  if (!platform) {
    throw new Error(
      `Unknown region "${region}". Expected one of: ${Object.keys(PLATFORM_BY_REGION).join(", ")}`,
    );
  }
  return platform;
}

export function playerId(entry: Pick<RosterEntry, "gameName" | "tagLine">): string {
  return `${entry.gameName}#${entry.tagLine}`;
}

/** The subset of the MetaTFT response we actually depend on. */
interface MetaTftResponse {
  summoner?: { riot_id?: string; puuid?: string; is_profile_hidden?: boolean };
  ranked?: {
    num_games?: number;
    rating_text?: string;
    rating_numeric?: number;
  };
  matches?: {
    riot_match_id?: string;
    placement?: number;
    match_timestamp?: number;
    queue_id?: number;
    tft_set?: string;
  }[];
}

export interface ProfileReading {
  rank: RankSnapshot;
  recentPlacements: MatchResult[];
}

export interface FetchOptions {
  tftSet: string;
  queueId: number;
  /** Milliseconds before a single attempt is aborted. */
  timeoutMs?: number;
  /** How many times to retry on network error / 5xx / 429. */
  retries?: number;
  /** Injected for testing. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export function buildUrl(entry: RosterEntry, tftSet: string): string {
  const platform = toPlatform(entry.region);
  const path = [platform, entry.gameName, entry.tagLine]
    .map((part) => encodeURIComponent(part))
    .join("/");
  const query = new URLSearchParams({
    source: "profile",
    tft_set: tftSet,
    include_revival_matches: "false",
  });
  return `${API_BASE}/${path}?${query}`;
}

/**
 * Turns a raw MetaTFT payload into our internal shape.
 * Exported separately from the network call so it can be tested against fixtures.
 */
export function parseProfile(
  body: MetaTftResponse,
  opts: { tftSet: string; queueId: number; readAt?: string },
): ProfileReading {
  const ranked = body.ranked;
  if (!ranked || typeof ranked.rating_numeric !== "number") {
    throw new Error("response contained no ranked rating");
  }

  const rank: RankSnapshot = {
    text: ranked.rating_text ?? "UNRANKED",
    numeric: ranked.rating_numeric,
    numGames: ranked.num_games ?? 0,
    readAt: opts.readAt ?? new Date().toISOString(),
  };

  const recentPlacements: MatchResult[] = (body.matches ?? [])
    .filter(
      (m) =>
        m.queue_id === opts.queueId &&
        m.tft_set === opts.tftSet &&
        typeof m.placement === "number" &&
        typeof m.match_timestamp === "number",
    )
    .map((m) => ({
      matchId: m.riot_match_id ?? "",
      placement: m.placement as number,
      timestamp: m.match_timestamp as number,
    }))
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 10);

  return { rank, recentPlacements };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fetches and parses one player's profile, retrying transient failures. */
export async function fetchProfile(
  entry: RosterEntry,
  opts: FetchOptions,
): Promise<ProfileReading> {
  const {
    tftSet,
    queueId,
    timeoutMs = 15_000,
    retries = 3,
    fetchImpl = fetch,
  } = opts;
  const url = buildUrl(entry, tftSet);
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(Math.min(1000 * 2 ** (attempt - 1), 8000));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        signal: controller.signal,
        headers: {
          accept: "application/json",
          // Identify ourselves rather than pretending to be a browser.
          "user-agent": "boxbox-survivor/0.1 (leaderboard poller)",
        },
      });

      if (res.status === 404) {
        // A bad Riot ID will never succeed, so do not burn retries on it.
        throw new Error(`player not found on MetaTFT (404) — check the Riot ID and region`);
      }
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`HTTP ${res.status}`);
        continue;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const body = (await res.json()) as MetaTftResponse;
      return parseProfile(body, { tftSet, queueId });
    } catch (err) {
      if (err instanceof Error && err.message.includes("404")) throw err;
      lastError = err;
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(
    `failed after ${retries + 1} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

/**
 * Formats a numeric rating back into readable text.
 * Master and above is confirmed as LP + 2800. Below that, each of the seven
 * sub-Master tiers spans 400 (four divisions of 100), which lands exactly on
 * 2800 at Master — consistent, but inferred rather than observed.
 */
const SUB_MASTER_TIERS = [
  "IRON",
  "BRONZE",
  "SILVER",
  "GOLD",
  "PLATINUM",
  "EMERALD",
  "DIAMOND",
];
const MASTER_FLOOR = 2800;

export function formatRating(numeric: number): string {
  if (numeric >= MASTER_FLOOR) {
    const lp = numeric - MASTER_FLOOR;
    // MetaTFT reports the apex tier in rating_text; without the ladder cutoffs
    // we cannot recompute GM/Challenger, so prefer the stored text when present.
    return `MASTER+ ${lp} LP`;
  }
  const tierIndex = Math.floor(numeric / 400);
  const withinTier = numeric % 400;
  const division = 4 - Math.floor(withinTier / 100);
  const lp = withinTier % 100;
  const tier = SUB_MASTER_TIERS[Math.max(0, Math.min(tierIndex, 6))];
  return `${tier} ${"IV".repeat(0) || ""}${romanDivision(division)} ${lp} LP`;
}

function romanDivision(d: number): string {
  return ["", "I", "II", "III", "IV"][d] ?? "";
}
