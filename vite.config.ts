import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import type { IncomingMessage, ServerResponse } from "node:http";
import process from "node:process";
import { captionFailureText, transcribeClip } from "./scripts/local-captions.mjs";

const host = process.env.TAURI_DEV_HOST;

/** Browser UI mock only: fetch free providers server-side (avoids browser CORS on cache headers). */
function browserProxy(): Plugin {
  const routes: Record<string, string> = {
    "/proxy/open-meteo": "https://api.open-meteo.com",
    "/proxy/rainviewer-api": "https://api.rainviewer.com",
    "/proxy/rainviewer-tiles": "https://tilecache.rainviewer.com",
    "/proxy/goes": "https://cdn.star.nesdis.noaa.gov",
    "/proxy/nws": "https://api.weather.gov",
    "/proxy/usgs": "https://earthquake.usgs.gov",
    "/proxy/photon": "https://photon.komoot.io",
    "/proxy/nominatim": "https://nominatim.openstreetmap.org",
    "/proxy/geocode": "https://geocoding-api.open-meteo.com",
    "/proxy/ipwho": "https://ipwho.is",
  };

  return {
    name: "browser-data-proxy",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? "";
        const match = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
        if (!match) {
          next();
          return;
        }
        const [prefix, target] = match;
        const upstream = target + url.slice(prefix.length);
        try {
          const headers: Record<string, string> = {
            "user-agent":
              prefix === "/proxy/usgs"
                ? "CommandCenter/0.1 (personal USGS earthquake feed; +https://github.com/nlaero/CommandCenter)"
                : prefix === "/proxy/nominatim" || prefix === "/proxy/photon"
                  ? "CommandCenter/0.1 (personal location lookup; +https://github.com/nlaero/CommandCenter)"
                  : "CommandCenter-browser-mock/0.1",
            accept: req.headers.accept ?? "*/*",
          };
          const ifNoneMatch = req.headers["if-none-match"];
          const ifModifiedSince = req.headers["if-modified-since"];
          if (typeof ifNoneMatch === "string") headers["if-none-match"] = ifNoneMatch;
          if (typeof ifModifiedSince === "string") headers["if-modified-since"] = ifModifiedSince;
          const upstreamRes = await fetch(upstream, { headers });
          res.statusCode = upstreamRes.status;
          for (const name of [
            "content-type",
            "cache-control",
            "etag",
            "expires",
            "last-modified",
            "retry-after",
            "age",
          ]) {
            const value = upstreamRes.headers.get(name);
            if (value) res.setHeader(name, value);
          }
          if (upstreamRes.status === 304) {
            res.end();
            return;
          }
          const buf = Buffer.from(await upstreamRes.arrayBuffer());
          res.end(buf);
        } catch (err) {
          res.statusCode = 502;
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              error: "proxy fetch failed",
              message: err instanceof Error ? err.message : String(err),
              upstream,
            }),
          );
        }
      });
    },
  };
}

/**
 * Browser mock only. Forwards /proxy/auth/* to the URL in `x-cc-auth-base`
 * so the sign-in screen can talk to auth-server without CORS.
 * Optional `CC_AUTH_BASE` seeds an empty localStorage at the default URL
 * (used for local UI runs; tests never call the tailnet host).
 */
function authDevProxy(): Plugin {
  return {
    name: "auth-dev-proxy",
    transformIndexHtml() {
      const base = process.env.CC_AUTH_BASE?.trim();
      if (!base) return;
      const state = {
        version: 1,
        activeBoardId: "home",
        layout: { cols: 48, rowHeight: 12, margin: [4, 4] },
        boards: [{ id: "home", title: "Home", panels: [] }],
        sources: {},
        editMode: false,
        auth: {
          enabled: true,
          baseUrl: base,
          allowInsecureHttp: true,
          caFile: null,
          tlsPinSha256: null,
        },
      };
      return [
        {
          tag: "script",
          injectTo: "head-prepend",
          children: `try{if(!localStorage.getItem("command-center.app-state.v1")){localStorage.removeItem("command-center.auth-tokens.v1");localStorage.setItem("command-center.app-state.v1",${JSON.stringify(JSON.stringify(state))});}}catch(e){}`,
        },
      ];
    },
    configureServer(server) {
      server.middlewares.use("/proxy/auth", (req, res) => {
        void proxyAuth(req, res).catch((err) => {
          if (res.writableEnded) return;
          res.statusCode = 502;
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              error: "bad_request",
              message: err instanceof Error ? err.message : String(err),
            }),
          );
        });
      });
    },
  };
}

async function proxyAuth(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const header = req.headers["x-cc-auth-base"];
  const base = Array.isArray(header) ? header[0] : header;
  if (!base) {
    res.statusCode = 400;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "bad_request" }));
    return;
  }
  let target: URL;
  try {
    target = new URL(base);
  } catch {
    res.statusCode = 400;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "bad_request" }));
    return;
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    res.statusCode = 400;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "bad_request" }));
    return;
  }
  const path = req.url ?? "/";
  const upstream = new URL(path, target.origin);
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks);
  const headers: Record<string, string> = { accept: "application/json" };
  const contentType = req.headers["content-type"];
  if (typeof contentType === "string") headers["content-type"] = contentType;
  const authorization = req.headers.authorization;
  if (typeof authorization === "string") headers.authorization = authorization;
  const upstreamRes = await fetch(upstream, {
    method: req.method,
    headers,
    body: body.length ? body : undefined,
  });
  res.statusCode = upstreamRes.status;
  const responseType = upstreamRes.headers.get("content-type");
  if (responseType) res.setHeader("content-type", responseType);
  const buf = Buffer.from(await upstreamRes.arrayBuffer());
  res.end(buf);
}

/** Browser dev stand-in for the desktop transcribe_media_local command. */
function captionProxy(): Plugin {
  return {
    name: "local-caption-proxy",
    configureServer(server) {
      server.middlewares.use("/proxy/transcribe", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }
        const chunks: Buffer[] = [];
        let tooBig = false;
        req.on("data", (chunk: Buffer) => {
          chunks.push(Buffer.from(chunk));
          if (chunks.reduce((sum, part) => sum + part.length, 0) > 65_536) tooBig = true;
        });
        req.on("end", () => {
          void (async () => {
            if (tooBig) {
              res.statusCode = 413;
              res.setHeader("content-type", "application/json");
              res.end(JSON.stringify({ message: "That caption request was too large." }));
              return;
            }
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
                sourceUrl?: string;
                clipId?: string;
                timelineStart?: number;
                seekSec?: number;
                durationSec?: number;
              };
              const result = await transcribeClip(body);
              res.statusCode = 200;
              res.setHeader("content-type", "application/json");
              res.setHeader("cache-control", "no-store");
              res.end(JSON.stringify(result));
            } catch (err) {
              if (res.writableEnded) return;
              res.statusCode = 400;
              res.setHeader("content-type", "application/json");
              res.setHeader("cache-control", "no-store");
              res.end(
                JSON.stringify({
                  message: captionFailureText(err),
                }),
              );
            }
          })();
        });
      });
    },
  };
}

const MEDIA_MAX_BYTES = 32 * 1024 * 1024;
const MEDIA_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 CommandCenter/0.1";

/** Same-origin fetch for HLS playlists and segments. Camera hosts often omit CORS. */
function mediaProxy(): Plugin {
  return {
    name: "camera-media-proxy",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const raw = req.url ?? "";
        if (!raw.startsWith("/proxy/media")) {
          next();
          return;
        }
        void proxyMedia(req, res).catch((err) => {
          if (res.writableEnded) return;
          res.statusCode = 502;
          res.setHeader("content-type", "application/json");
          res.setHeader("cache-control", "no-store");
          res.end(
            JSON.stringify({
              message: err instanceof Error ? err.message : "Couldn't reach that stream.",
            }),
          );
        });
      });
    },
  };
}

async function proxyMedia(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
  const target = parsed.searchParams.get("u")?.trim() ?? "";
  let upstreamUrl: URL;
  try {
    upstreamUrl = new URL(target);
  } catch {
    throw new Error("Enter an http or https link.");
  }
  if (upstreamUrl.protocol !== "http:" && upstreamUrl.protocol !== "https:") {
    throw new Error("Enter an http or https link.");
  }
  const headers: Record<string, string> = { accept: "*/*", "user-agent": MEDIA_UA };
  const range = req.headers.range;
  if (typeof range === "string" && range.startsWith("bytes=")) headers.range = range;
  const upstream = await fetch(upstreamUrl, { headers, redirect: "follow" });
  if (!upstream.ok) {
    res.statusCode = upstream.status;
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify({ message: `The stream replied HTTP ${upstream.status}.` }));
    return;
  }
  const advertised = Number(upstream.headers.get("content-length") ?? "0");
  if (Number.isFinite(advertised) && advertised > MEDIA_MAX_BYTES) {
    res.statusCode = 413;
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify({ message: "That response is too large to play." }));
    return;
  }
  const reader = upstream.body?.getReader();
  if (!reader) throw new Error("Couldn't reach that stream.");
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MEDIA_MAX_BYTES) {
      await reader.cancel();
      res.statusCode = 413;
      res.setHeader("content-type", "application/json");
      res.setHeader("cache-control", "no-store");
      res.end(JSON.stringify({ message: "That response is too large to play." }));
      return;
    }
    chunks.push(Buffer.from(value));
  }
  res.statusCode = upstream.status;
  const contentType = upstream.headers.get("content-type");
  if (contentType) res.setHeader("content-type", contentType);
  res.setHeader("x-cc-final-url", upstream.url);
  res.setHeader("cache-control", "no-store");
  const contentRange = upstream.headers.get("content-range");
  if (contentRange) res.setHeader("content-range", contentRange);
  res.end(Buffer.concat(chunks));
}

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), browserProxy(), authDevProxy(), mediaProxy(), captionProxy()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
