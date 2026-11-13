import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import process from "node:process";

const host = process.env.TAURI_DEV_HOST;

/** Browser UI mock only: fetch free providers server-side (avoids browser CORS on cache headers). */
function browserProxy(): Plugin {
  const routes: Record<string, string> = {
    "/proxy/open-meteo": "https://api.open-meteo.com",
    "/proxy/rainviewer-api": "https://api.rainviewer.com",
    "/proxy/rainviewer-tiles": "https://tilecache.rainviewer.com",
    "/proxy/carto": "https://basemaps.cartocdn.com",
    "/proxy/goes": "https://cdn.star.nesdis.noaa.gov",
    "/proxy/nws": "https://api.weather.gov",
    "/proxy/usgs": "https://earthquake.usgs.gov",
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

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), browserProxy()],
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
