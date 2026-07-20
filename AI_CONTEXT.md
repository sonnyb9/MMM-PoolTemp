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
- `mm` uses `config.js`
- `mm-tv` uses `config-tv.js`
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

`MMM-SharedWeather` deduplicates upstream weather requests and can rebroadcast its cached normalized payloads to sibling modules. This repo retains the original bridge patch for older SharedWeather installations.

The predictor now also supports a hotter local-air input when the pool microclimate runs warmer than the general weather feed. That can come from `manualAmbientAirTempF` in config or from a future sensor payload.

As of 2026-07-10, the predictor also uses local model history to correct same-day forecasts by capture hour. This was added because morning calendar forecasts were tracking the live early-morning sensor value too closely. Calendar mode now displays today's corrected forecast high while the card still shows the live pool temperature separately.

As of 2026-07-14, the module supports shared hourly weather in `off`, `observe`, and `active` modes. The initial deployment uses `observe`: it records a bounded same-day hourly candidate but does not change the display. Yr current, daily, and hourly data come from the same cached SharedWeather response. Do not add direct hourly API traffic from this module.

The first observation gate on 2026-07-20 rejected activation because v1 behaved like a persistent upward adjustment and saturated its clamp frequently. The v2 candidate (`pooltemp-2026-07-20-hourly-delta-v2`) instead applies a conservative weighted difference between daily and remaining-hour air forecasts to the completed daily pool baseline. It persists raw and bounded adjustment components for analysis and deliberately leaves the existing learned same-day correction unchanged. Keep both instances in `observe` until at least seven complete v2 days pass the automated gate in `tools/hourly_activation_gate.py`.

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
7. Does the weather provider expose hourly data through the shared weather cache without increasing provider throttling risk?

## Likely next improvements

- Swap manual anchor for SmartThings sensor anchor
- Promote local ambient air from manual config to sensor-fed ambient input
- Add optional stale-sensor fallback logic
- Add explicit calibration knobs if the heuristic consistently overshoots or undershoots
- Review persisted v2 hourly observation candidates after at least seven complete days with `tools/hourly_activation_gate.py`, then decide whether to switch from `observe` to `active`
- Optionally persist the most recent computed prediction locally if startup latency becomes annoying
- Add unit tests for the predictor if the model grows beyond the current simple heuristic
