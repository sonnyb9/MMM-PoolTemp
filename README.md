# MMM-PoolTemp

`MMM-PoolTemp` is a lightweight MagicMirror module that predicts pool temperature from forecast data you already have locally. It does not call a weather API, does not need a `node_helper`, and is designed to work with a shared-forecast setup so it does not make your rate-limit situation worse.

The current intended deployment is:

- `MagicMirror-TV`: compact 2-day card below `MMM-STStatus`
- `magicmirror-server` page 2: calendar-only integration inside `MMM-CalendarExt3`

## Design goals

- No direct weather API traffic
- No new Samsung API traffic
- Manual water-temp calibration now
- Clean future upgrade path for a SmartThings or Zigbee temperature sensor later
- One prediction engine with two presentation modes

## Current architecture

The module expects an in-browser weather notification payload from a local bridge, then computes pool predictions client-side.

- Weather input: `POOLTEMP_WEATHER_DATA`
- Future sensor input: `STSTATUS_DEVICE_DATA`
- Calendar output: synthetic `CALENDAR_EVENTS`

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
    calendarSet: ["iCloud", "US Holidays", "Rays"],
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

      const body = cellDom.querySelector(".cellBody");
      if (!body) {
        return;
      }

      const row = document.createElement("div");
      row.className = "pooltemp-inline";
      row.innerHTML = poolEvent.poolTempHtml;
      body.appendChild(row);
    }
  }
}
```

Add matching CSS in `config/custom.css` if you want that month-view line to look polished:

```css
.MMM-CalendarExt3 .pooltemp-inline {
  margin: 2px 4px 0;
  font-size: 0.72em;
  line-height: 1.2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.MMM-CalendarExt3 .pooltemp-inline .mmm-pooltemp-warm {
  color: #ffb3b3;
}

.MMM-CalendarExt3 .pooltemp-inline .mmm-pooltemp-cool {
  color: #9ed0ff;
}
```

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

## Future SmartThings sensor path

This repo is intentionally ready for a future SmartThings-backed pool sensor, but it does not require one today.

Recommended future approach:

- Keep `MMM-STStatus` as the Samsung API poller
- Add a lightweight frontend broadcast from `MMM-STStatus`
- Let `MMM-PoolTemp` subscribe to `STSTATUS_DEVICE_DATA`
- Set `temperatureSource: "smartthings"` and `smartthingsDeviceId`
- Optionally pass through local ambient temperature too if the device provides it

That reuses existing SmartThings polling instead of adding more API traffic.

## Scripts

Syntax check:

```bash
npm run check
```
