# Architecture

Climate Risk Monitor is a Vite + TypeScript frontend served by a small Node HTTP server. The server is intentionally part of the app because provider calls, caching, API fallbacks, and optional OpenAI calls should not run directly in the browser.

## Runtime Flow

```txt
Browser UI
  -> same-origin /api routes
  -> Node provider proxy
  -> weather, alert, geocoding, archive, and optional OpenAI APIs
  -> normalized dashboard models
  -> map layers, rankings, details, compare tray, and SkyScout
```

## Frontend

The frontend lives in `src/`.

- `src/main.ts` wires the dashboard state, map, sidebar, timeline, details, compare tray, and SkyScout.
- `src/data/` contains browser API calls, normalization, derived metrics, regions, and cache helpers.
- `src/map/` contains Leaflet setup, custom canvas heat interpolation, alert polygons, and selected-region markers.
- `src/ui/` contains the app controls and panels.
- `src/styles.css` contains the visual system, responsive layout, collapsed sidebar, details overlay, timeline, and assistant styling.

## Backend

The backend lives in `server/index.mjs`.

It provides:

- `/api/health`
- `/api/forecast`
- `/api/alerts`
- `/api/trends`
- `/api/chat`

The server handles:

- provider retries and fallbacks
- hourly in-memory caching
- geocoding
- forecast provider normalization
- active alert retrieval
- optional OpenAI calls
- static production serving from `dist/`

## SkyScout Flow

SkyScout follows a guarded pipeline:

1. Receive the user question plus dashboard context.
2. Normalize messy wording, typos, locations, time references, and intent.
3. Decide whether the question is weather/dashboard-related.
4. Identify needed weather variables and any missing user facts.
5. Ask a follow-up when the user needs to provide missing context.
6. Fetch or reuse verified forecast, alert, route, map, or visible-region evidence.
7. Build a deterministic advisory.
8. If `OPENAI_API_KEY` exists, ask OpenAI to write a warmer final answer using only verified evidence.
9. Fall back to deterministic wording if OpenAI is unavailable.

The assistant is allowed to be warm and conversational, but it is not allowed to invent missing facts. When the dashboard can only answer part of a business question, SkyScout names the missing external data.

## Map Rendering

The map uses:

- Leaflet for map controls and interaction.
- CARTO/OpenStreetMap tiles.
- A custom canvas heat layer for the interpolated risk surface.
- NOAA/NWS alert polygons as GeoJSON overlays.
- Domain-aware interpolation so CONUS, Alaska, and Hawaii do not blend into each other.

## Deployment Shape

The production command is:

```bash
npm run build
npm start
```

`npm start` runs the Node server in production mode and serves the built Vite files from `dist/`.

