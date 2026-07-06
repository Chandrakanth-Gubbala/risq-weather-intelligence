# Data Sources

RisQ uses public weather and alert APIs where possible. The app is designed to show degraded states when provider data is unavailable.

## Forecast

Primary:

- Open-Meteo Forecast API

Fallbacks:

- NOAA/NWS point forecast for U.S. locations
- met.no locationforecast
- embedded representative sample data only if external network access is blocked or all providers fail

Forecast variables used by the dashboard include temperature, apparent temperature, wind speed, precipitation, humidity, cloud cover, and daily forecast values.

## Alerts

Active severe and extreme alert polygons come from:

- NOAA/NWS active alerts API

The dashboard renders alert geometries on the map and uses alert timing in SkyScout responses when relevant.

## Historical Trends

Historical trend panels use:

- Open-Meteo Archive API

The app aggregates historical daily values into yearly trend summaries where enough valid days are available.

## Geocoding

SkyScout resolves named U.S. places with:

- Open-Meteo Geocoding API
- OpenStreetMap Nominatim fallback
- U.S. Census geocoding fallback

## Map Tiles

The map uses Leaflet with CARTO/OpenStreetMap tiles. Tile availability can vary by network and browser policy.

## Removed Or Unavailable Layers

The following were intentionally removed or not included because the live data path was unavailable, weak, or too easy to misrepresent:

- AQI
- river discharge or flood signal
- drought
- soil moisture
- solar potential
- wind power density
- old heat-stress proxy layer

Those metrics should only be added back after a provider audit, UI caveat, and scoring review.

## Data Honesty Policy

The app should not fabricate replacement weather values. If a provider fails:

- null values render as unavailable
- source health changes
- SkyScout names missing evidence
- static demo data is labeled when used

## Operational Caution

This dashboard is advisory. It should not be used as the only source for emergency, safety, dispatch, financial, compliance, medical, or legal decisions. Always follow official weather services and local authorities for safety-critical calls.
