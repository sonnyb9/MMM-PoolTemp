# AI Context

## Purpose

`MMM-PoolTemp` is a standalone MagicMirror module for predicting pool temperature with the smallest reasonable footprint. It is intentionally designed around local notifications and existing data sources instead of direct API calls.

## Locked scope for v1

- Weather source comes from the existing local Lutz forecast already displayed in MagicMirror
- No additional weather API queries
- Manual water temperature anchor in config
- Optional local ambient air anchor in config or sensor payload
- TV instance shows a compact 2-day card below `MMM-STStatus`
- Server instance is calendar-only on page 2 and feeds predictions into `MMM-CalendarExt3`
- Predictor is lightweight and heuristic, not a heavy physical simulation

## Current environment assumptions

- User has dual MagicMirror instances
- `magicmirror-server` uses `config.js`
- `MagicMirror-TV` uses `config-tv.js`
- Shared local weather is already handled through `MMM-SharedWeather`
- Current local pool details:
  - About 10,000 gallons
  - Roughly 11.5 ft x 24 ft
  - About 4.5 ft average depth
  - White fiberglass shell
  - In-ground
  - Full overhead sun
  - No cover
  - No heater
  - No screen enclosure
- Initial calibration snapshot used for development:
  - Current water temp: 79.3 F
  - Local ambient air near pool: 86.6 F
  - Last 24h range: 79.3 F to 74.6 F

## Why the architecture looks like this

The module is intentionally frontend-only for v1.

- It keeps installation and failure modes simple
- It avoids duplicate provider traffic
- It stays resilient when network conditions are noisy
- It is easy to upgrade later with a sensor-backed input

`MMM-SharedWeather` already deduplicates upstream weather requests, but it does not directly expose its cached data to sibling modules. Because of that, this repo includes a small bridge patch so `MMM-SharedWeather` can emit local MagicMirror notifications carrying the already-fetched payload.

The predictor now also supports a hotter local-air input when the pool microclimate runs warmer than the general weather feed. That can come from `manualAmbientAirTempF` in config or from a future sensor payload.

## Future SmartThings path

The user asked whether Samsung API polling is already continuous. The answer was yes: `MMM-STStatus` currently polls while MagicMirror is running. Because of that, the preferred future sensor design is to reuse that existing polling path instead of adding new pool-specific Samsung API calls.

Recommended future shape:

- `MMM-STStatus` emits normalized device data on a MagicMirror notification
- `MMM-PoolTemp` subscribes to that notification
- Pool config switches from `temperatureSource: "manual"` to `temperatureSource: "smartthings"`
- Selection should be by SmartThings device id, not label
- Ambient air should be passed through too when the device payload includes it
- `.cache.json` should be treated as an optional startup fallback, not the primary integration surface

## If returning later

Check these first:

1. Is `MMM-SharedWeather` still the local weather source for both instances?
2. Has the broadcast bridge patch been applied to `MMM-SharedWeather`?
3. Has the month-view `MMM-CalendarExt3` config been given the `eventTransformer` and `manipulateDateCell` hook?
4. Is the module still intended to stay frontend-only?
5. Is the pool still uncovered and unheated?
6. Has a SmartThings or Zigbee pool sensor been added since the last pass?

## Likely next improvements

- Swap manual anchor for SmartThings sensor anchor
- Promote local ambient air from manual config to sensor-fed ambient input
- Add optional stale-sensor fallback logic
- Add explicit calibration knobs if the heuristic consistently overshoots or undershoots
- Optionally persist the most recent computed prediction locally if startup latency becomes annoying
- Add unit tests for the predictor if the model grows beyond the current simple heuristic
