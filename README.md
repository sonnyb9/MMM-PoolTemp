# MMM-PoolTemp

`MMM-PoolTemp` is a lightweight MagicMirror module that predicts pool temperature from forecast data you already have locally. It does not call a weather API and is designed to work with a shared-forecast setup so it does not make your rate-limit situation worse.

The current intended deployment is:

- `mm-tv`: compact 2-day card below `MMM-STStatus`
- `mm` page 2: calendar-only integration inside `MMM-CalendarExt3`

## Design goals

- No direct weather API traffic
- No new Samsung API traffic
- Manual water-temp calibration fallback
- Live SmartThings pool-temperature support
- One prediction engine with two presentation modes

## Current architecture

The module expects an in-browser weather notification payload from a local bridge, computes pool predictions client-side, and can optionally persist model-run snapshots through its node helper.

- Weather input: `POOLTEMP_WEATHER_DATA`
- Optional sensor input: `STSTATUS_DEVICE_DATA`
- Calendar output: synthetic `CALENDAR_EVENTS`
- Optional persistence output: `POOL_MODEL_RUN`

## Optional durable model logging

If `/home/pi/.openclaw/scripts/log_pool_model_run.py` is present, the module node helper will forward deduplicated model-run snapshots into the local pool-model SQLite database.

This records:

- anchor water temperature
- sensor trend and stale state
- forecast digest seen by the model
- per-day predicted pool ranges

The intended companion tables are:

- `model_runs`
- `model_predictions`

This repo includes example patch files for the bridge pieces:

- [integrations/mmm-sharedweather-bridge.patch](./integrations/mmm-sharedweather-bridge.patch)
- [integrations/mmm-ststatus-broadcast.patch](./integrations/mmm-ststatus-broadcast.patch)

## What the model uses

The predictor is intentionally simple. It uses:

- Current measured water temperature as the anchor
- Optional local ambient air temperature near the pool when available
- Recent observed water-temperature range to size the daily swing
- Forecast air min/max
- Forecast precipitation probability
- Broad weather type and sun exposure
- Pool profile assumptions like cover, enclosure, shell color, and full sun

It is meant to be directionally useful, not physically exact.

## Installation

Clone or pull this repo into your MagicMirror modules directory:

```bash
cd ~/MagicMirror/modules
git clone https://github.com/YOUR-ACCOUNT/MMM-PoolTemp.git
```

There are no runtime dependencies.

## Basic TV config

Use `displayMode: "card"` on the TV instance.

If you have a local ambient reading near the pool, include it. That helps the day-0 and next-day model run warmer when the pool microclimate is hotter than the general weather feed.

```js
{
  module: "MMM-PoolTemp",
  position: "middle_center",
  classes: "tv__1 half-width",
  config: {
    displayMode: "card",
    weatherNotification: "POOLTEMP_WEATHER_DATA",
    weatherLocationName: "Lutz",
    temperatureSource: "manual",
    manualWaterTempF: 79.3,
    manualAmbientAirTempF: 86.6,
    manualObservedLowF: 74.6,
    manualObservedHighF: 79.3
  }
}
```

## Server page 2 config

Use `displayMode: "calendar"` so the module does not render a visible card and only feeds synthetic pool events into `MMM-CalendarExt3`.

```js
{
  module: "MMM-PoolTemp",
  position: "top_bar",
  classes: "p__2",
  config: {
    displayMode: "calendar",
    weatherNotification: "POOLTEMP_WEATHER_DATA",
    weatherLocationName: "Lutz",
    temperatureSource: "manual",
    manualWaterTempF: 79.3,
    manualAmbientAirTempF: 86.6,
    manualObservedLowF: 74.6,
    manualObservedHighF: 79.3
  }
}
```

## Local Ambient Air Input

If you have a thermometer near the pool that also reports ambient air, set:

```js
manualAmbientAirTempF: 86.6,
```

The module will prefer that local ambient reading for same-day heating when it is available, and it will carry a smaller portion of that warm local bias into the next day. If you omit it, the module falls back to the weather feed's current air temperature.

## Recommended CalendarExt3 styling hook

`MMM-PoolTemp` already emits synthetic all-day calendar events. If you do nothing else, they should still appear. If you want the cleaner month-view line you described, use `eventTransformer` plus `manipulateDateCell`.

Example:

```js
{
  module: "MMM-CalendarExt3",
  position: "middle_center",
  header: "Month View",
  classes: "MonthView p__2",
  config: {
    instanceId: "month1",
    calendarSet: ["iCloud", "US Holidays", "Rays", "Pool Temp"],
    weeksInView: 4,
    eventTransformer: (event) => {
      if (event.calendarName === "Pool Temp" && typeof event.poolTempF === "number") {
        event.skip = true;
      }
      return event;
    },
    manipulateDateCell: (cellDom, events) => {
      const poolEvent = Array.isArray(events)
        ? events.find((event) => event.calendarName === "Pool Temp" && typeof event.poolTempF === "number")
        : null;

      if (!poolEvent || cellDom.querySelector(".pooltemp-inline")) {
        return;
      }

      const footer = cellDom.querySelector(".cellFooter");
      if (!footer) {
        return;
      }

      const row = document.createElement("div");
      row.className = "pooltemp-inline";
      row.innerHTML = poolEvent.poolTempHtml;
      footer.appendChild(row);
    }
  }
}
```

Add matching CSS in `config/custom.css` if you want that month-view line to look polished:

```css
.MMM-CalendarExt3 .pooltemp-inline {
  margin: 0 4px 2px;
  font-size: 0.72em;
  line-height: 1.2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: #fff;
}

.MMM-CalendarExt3 .pooltemp-inline .mmm-pooltemp-warm {
  color: #ffb3b3;
}

.MMM-CalendarExt3 .pooltemp-inline .mmm-pooltemp-cool {
  color: #9ed0ff;
}
```

Important: `Pool Temp` must be included in `calendarSet` or CalendarExt3 will filter the synthetic events out before `eventTransformer` and `manipulateDateCell` can see them.

## Required SharedWeather bridge

The module does not pull from `MMM-SharedWeather` directly because that module does not natively rebroadcast its cached data to sibling modules. Use the included patch to add a small bridge notification.

After patching `MMM-SharedWeather`, add `broadcastNotifications` to one local current-weather instance and one local forecast instance:

```js
config: {
  weatherProvider: "yr",
  lat: 28.143189,
  lon: -82.54473,
  broadcastNotifications: ["POOLTEMP_WEATHER_DATA"]
}
```

You only need the Lutz instances to broadcast for this module.

## SmartThings sensor input

`MMM-PoolTemp` supports SmartThings-backed water temperature now. The recommended approach is:

- Keep `MMM-STStatus` as the SmartThings poller
- Enable its frontend rebroadcast with `broadcastDeviceData: true`
- Hide the pool sensor from the visible SmartThings table with `hiddenDevices` if you do not want an extra row
- Point `MMM-PoolTemp` at that device with `temperatureSource: "smartthings"` and `smartthingsDeviceId`

Example:

```js
{
  module: "MMM-STStatus",
  position: "middle_center",
  config: {
    devices: [
      { id: "pool-sensor-uuid", name: "Pool Sensor" }
    ],
    hiddenDevices: ["pool-sensor-uuid"],
    broadcastDeviceData: true,
    broadcastNotification: "STSTATUS_DEVICE_DATA"
  }
},
{
  module: "MMM-PoolTemp",
  position: "middle_center",
  classes: "tv__1 half-width",
  config: {
    displayMode: "card",
    weatherNotification: "POOLTEMP_WEATHER_DATA",
    weatherLocationName: "Lutz",
    temperatureSource: "smartthings",
    smartthingsDeviceId: "pool-sensor-uuid",
    manualWaterTempF: 79.3,
    manualObservedLowF: 74.6,
    manualObservedHighF: 79.3
  }
}
```

The manual values remain useful as fallback calibration, but the live SmartThings sensor becomes the active temperature anchor when present.

When SmartThings temperature timestamps are available through `MMM-STStatus`, `MMM-PoolTemp` keeps using the last successful sensor reading even after it goes stale instead of dropping back to an older manual anchor. The TV card explicitly shows `Stale data` while it is holding the last known sensor value. `manualWaterTempF` is only used when SmartThings is configured but no sensor reading has been received yet.

The model can also apply an automatic hybrid correction layer backed by the local pool-model SQLite history:

- A seasonal baseline bias for the forecast month
- A shorter rolling residual correction on top of that baseline

This is bounded on purpose so the model can adapt to drift and changing seasons without becoming twitchy from a small number of recent readings.

The relevant model knobs are:

- `sensorStaleHours`
- `staleSensorFallbackHours`
- `autoCorrectionEnabled`
- `autoCorrectionLookbackDays`
- `autoCorrectionSeasonalLookbackDays`
- `autoCorrectionMinSamples`
- `autoCorrectionMinSeasonalSamples`
- `maxAutoCorrectionF`
- `maxSeasonalCorrectionF`

## Scripts

Syntax check:

```bash
npm run check
```
