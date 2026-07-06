# RisQ

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Chandrakanth-Gubbala/risq-weather-intelligence)

**Know weather risk before it hits.**

RisQ is an interactive U.S. weather risk intelligence dashboard. It combines a Leaflet map, custom canvas heat interpolation, live forecast signals, NOAA/NWS alerts, ranked regions, local detail panels, comparison tools, and a weather-aware assistant named SkyScout.

The project is a prototype, but it is built to be honest about data quality: if a provider fails, the UI degrades visibly instead of inventing weather values.

## What You Will See

- A dark full-viewport U.S. map with interpolated weather-risk surfaces.
- Layer controls for forecast stress score, heat index, temperature, fire weather, wind, humidity, cloud cover, and cooling degree days.
- A ranked list of highest-risk regions for the active layer and forecast time.
- A compact forecast timeline for hourly and 16-day views.
- NOAA/NWS severe-alert polygons drawn directly on the map.
- A Details panel for selected regions with local metrics, top drivers, active alerts, and forecast summaries.
- A Compare workflow for pinning regions side by side.
- SkyScout, a warm weather assistant that answers map-aware questions about places, routes, outdoor planning, delivery weather risk, clothing comfort, stargazing suitability, and dashboard interpretation.

## SkyScout

SkyScout is the bottom-right assistant. It uses the current dashboard context, selected region, map center, visible points, alerts, forecast evidence, and the user's question.

It can help with:

- "How are the next 4 days looking in Houston?"
- "Will it be too hot in Rochester next week, and what should I wear?"
- "Would it be wise to travel from Rochester to New York City tomorrow?"
- "Which visible area is better for stargazing tonight?"
- "Can I expect weather-related food delivery delays around 8 PM?"
- "Why does this region look risky?"

It cannot see private package tracking, traffic, staffing, exact courier routing, road closures, business SLAs, or emergency response data. For those cases it gives a weather-only answer and names the missing external data.

The assistant works in two modes:

- Deterministic mode: no API key required. Uses local planning and weather rules.
- Optional LLM mode: set `OPENAI_API_KEY` on the server to let OpenAI write more natural final responses from verified dashboard facts.

The browser never receives the OpenAI key.

## Data Sources

Primary forecast and archive data:

- Open-Meteo Forecast API
- Open-Meteo Geocoding API
- Open-Meteo Archive API

Fallback and alert sources:

- NOAA/NWS `api.weather.gov` points, forecasts, and active alerts
- met.no locationforecast as a secondary weather fallback
- OpenStreetMap Nominatim and U.S. Census geocoding as location fallbacks

Map:

- Leaflet
- CARTO/OpenStreetMap map tiles

See [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md) for source details and caveats.

## Important Limitations

This dashboard is advisory and modeled. It is not for emergency, dispatch, financial, compliance, medical, legal, or operational safety decisions.

Known limits:

- The forecast stress score is a prototype composite.
- Heat, fire weather, wind, humidity, cloud cover, and cooling demand are derived from available forecast variables.
- AQI, river discharge, flood signal, drought, soil moisture, solar potential, and wind-power-density layers are not included because their live data paths were unavailable or too weak for honest scoring in this prototype.
- SkyScout can answer weather-exposure questions, but it cannot infer non-weather business outcomes without the relevant operational data.

## Run Locally

```bash
npm install
npm run dev
```

Open the local URL printed by the server, usually:

```txt
http://127.0.0.1:5173/
```

On Windows PowerShell, use:

```bash
npm.cmd install
npm.cmd run dev
```

Direct `file://` opening is not guaranteed because browser origin, module loading, storage, and network behavior can break the app.

## Optional LLM Setup

Create a local `.env` or set environment variables before starting the server:

```bash
OPENAI_API_KEY=your_api_key_here
OPENAI_MODEL=gpt-5.4-mini
```

PowerShell:

```powershell
$env:OPENAI_API_KEY="your_api_key_here"
$env:OPENAI_MODEL="gpt-5.4-mini"
npm.cmd run dev
```

Without `OPENAI_API_KEY`, SkyScout still runs with deterministic fallback rules.

## Deploy Publicly

This is a full-stack Node app because `/api/forecast`, `/api/alerts`, `/api/trends`, and `/api/chat` are served by the Node proxy. GitHub Pages alone is not enough for the full dashboard.

Recommended deployment:

1. Push this repository to GitHub.
2. Create a Render Web Service from the repository.
3. Use:
   - Build command: `npm ci && npm run build`
   - Start command: `npm start`
4. Optional: set `OPENAI_API_KEY` and `OPENAI_MODEL` as Render environment variables.

The included [render.yaml](render.yaml) can be used as a Render blueprint.

## Project Structure

```txt
risq-weather-intelligence/
  server/                 Node server, provider proxy, SkyScout API
  src/
    data/                 API client, normalization, derived metrics, regions
    map/                  Leaflet setup, heat canvas, alert polygons, markers
    ui/                   Sidebar, timeline, details, compare, assistant UI
    main.ts               App orchestration
    styles.css            Dashboard styling
  docs/                   Architecture, deployment, and data-source notes
  index.html
  package.json
  render.yaml
```

## More Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Data Sources](docs/DATA_SOURCES.md)
- [Deployment](docs/DEPLOYMENT.md)

