# Deployment

RisQ is a Node-served Vite app. Use a platform that can run a Node web service.

## Why Not GitHub Pages Only?

GitHub Pages can host static files, but this dashboard needs a server for:

- `/api/forecast`
- `/api/alerts`
- `/api/trends`
- `/api/chat`
- provider fallbacks and caching
- keeping `OPENAI_API_KEY` out of the browser

For the full app, use Render, Railway, Fly.io, or another Node host.

## Render

This repository includes `render.yaml`.

Recommended settings:

```txt
Build command: npm ci && npm run build
Start command: npm start
```

Environment variables:

```txt
NODE_VERSION=24
OPENAI_API_KEY=optional
OPENAI_MODEL=optional
```

Without `OPENAI_API_KEY`, SkyScout still works through deterministic fallback logic.

## Local Production Smoke Test

```bash
npm run build
npm start
```

Then open:

```txt
http://127.0.0.1:5173/api/health
```

Expected response:

```json
{"ok":true,"cacheEntries":0}
```

## Production Notes

- The server binds to `0.0.0.0` in production mode so cloud hosts can route traffic to it.
- The app uses hourly in-memory caching. Cache is reset when the process restarts.
- If hosted on a free tier, first load may be slow after the service sleeps.
- Provider rate limits or outages can still cause degraded dashboard states.
