import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import process from "node:process";

const host = process.env.TAURI_DEV_HOST;

/** Browser UI mock only: fetch free weather providers server-side (avoids browser egress/CORS). */
function weatherBrowserProxy(): Plugin {
  const routes: Record<string, string> = {
    "/proxy/open-meteo": "https://api.open-meteo.com",
    "/proxy/rainviewer-api": "https://api.rainviewer.com",
    "/proxy/rainviewer-tiles": "https://tilecache.rainviewer.com",
    "/proxy/carto": "https://basemaps.cartocdn.com",
    "/proxy/goes": "https://cdn.star.nesdis.noaa.gov",
  };

  return {
    name: "weather-browser-proxy",
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
            "user-agent": "CommandCenter-browser-mock/0.1",
            accept: req.headers.accept ?? "*/*",
          };
          const upstreamRes = await fetch(upstream, { headers });
          res.statusCode = upstreamRes.status;
          const contentType = upstreamRes.headers.get("content-type");
          if (contentType) res.setHeader("content-type", contentType);
          res.setHeader("cache-control", "public, max-age=60");
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
  plugins: [react(), weatherBrowserProxy()],
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
