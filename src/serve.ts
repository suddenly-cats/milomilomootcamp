/**
 * Tiny static file server for local development: `npm run serve`.
 * In production you do not need this — web/ is a plain static directory that
 * any host (GitHub Pages, Netlify, S3, nginx) can serve as-is.
 */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { ROOT } from "./store.ts";

const WEB = resolve(ROOT, "web");
const PORT = Number(process.env.PORT ?? 5173);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    // normalize + prefix check keeps ../ out of the served tree
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    let file = join(WEB, rel);
    if (!file.startsWith(WEB)) {
      res.writeHead(403).end("forbidden");
      return;
    }

    const info = await stat(file).catch(() => null);
    if (!info || info.isDirectory()) file = join(file, "index.html");

    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  }
});

server.listen(PORT, () => {
  console.log(`leaderboard at http://localhost:${PORT}`);
});
