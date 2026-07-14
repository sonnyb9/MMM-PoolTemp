#!/usr/bin/env python3

import json
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


DB_PATH = Path("/home/pi/.openclaw/data/pool-model.db")
DEFAULT_LOOKBACK_DAYS = 7
DEFAULT_SEASONAL_LOOKBACK_DAYS = 120
DEFAULT_SAME_DAY_LOOKBACK_DAYS = 45
DEFAULT_TIME_ZONE = "America/New_York"


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def parse_request() -> dict:
    if sys.stdin.isatty():
        return {}

    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError:
        return {}

    return payload if isinstance(payload, dict) else {}


def normalize_days(value, default: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return max(1, parsed)


def normalize_model_version(value) -> str | None:
    text = str(value or "").strip()
    return text or None


def normalize_time_zone(value) -> ZoneInfo:
    text = str(value or DEFAULT_TIME_ZONE).strip() or DEFAULT_TIME_ZONE
    try:
        return ZoneInfo(text)
    except ZoneInfoNotFoundError:
        return ZoneInfo(DEFAULT_TIME_ZONE)


def parse_utc_timestamp(value: str) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None

    if text.endswith("Z"):
        text = text[:-1] + "+00:00"

    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None

    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def fetch_error_rows(connection: sqlite3.Connection, model_version: str | None) -> list[sqlite3.Row]:
    connection.row_factory = sqlite3.Row
    query = """
        WITH daily_actuals AS (
            SELECT
                substr(captured_at, 1, 10) AS target_date,
                AVG(water_temp_f) AS actual_mean_f,
                COUNT(*) AS reading_count
            FROM sensor_readings
            GROUP BY substr(captured_at, 1, 10)
        ),
        dated_predictions AS (
            SELECT
                target_date,
                substr(captured_at, 1, 10) AS prediction_date,
                MAX(captured_at) AS chosen_captured_at
            FROM model_predictions
            WHERE display_mode = 'calendar'
              AND substr(captured_at, 1, 10) < target_date
            GROUP BY target_date, substr(captured_at, 1, 10)
        )
        SELECT
            mp.target_date,
            mp.captured_at,
            mp.predicted_mean_f,
            da.actual_mean_f,
            da.reading_count,
            CAST(julianday(mp.target_date) - julianday(substr(mp.captured_at, 1, 10)) AS INTEGER) AS horizon_days
        FROM dated_predictions dp
        JOIN model_predictions mp
          ON mp.target_date = dp.target_date
         AND mp.captured_at = dp.chosen_captured_at
        JOIN daily_actuals da
          ON da.target_date = mp.target_date
        WHERE mp.predicted_mean_f IS NOT NULL
          AND da.actual_mean_f IS NOT NULL
          AND da.reading_count > 0
          AND (? IS NULL OR mp.model_version = ?)
        ORDER BY mp.target_date DESC, mp.captured_at DESC
    """
    return list(connection.execute(query, (model_version, model_version)))


def fetch_same_day_rows(connection: sqlite3.Connection, model_version: str | None) -> list[sqlite3.Row]:
    connection.row_factory = sqlite3.Row
    query = """
        WITH daily_actuals AS (
            SELECT
                substr(captured_at, 1, 10) AS target_date,
                AVG(water_temp_f) AS actual_mean_f,
                MAX(water_temp_f) AS actual_high_f,
                MIN(water_temp_f) AS actual_low_f,
                COUNT(*) AS reading_count
            FROM sensor_readings
            GROUP BY substr(captured_at, 1, 10)
        )
        SELECT
            mp.target_date,
            mp.captured_at,
            mp.predicted_mean_f,
            mp.predicted_high_f,
            mp.predicted_low_f,
            da.actual_mean_f,
            da.actual_high_f,
            da.actual_low_f,
            da.reading_count
        FROM model_predictions mp
        JOIN daily_actuals da
          ON da.target_date = mp.target_date
        WHERE mp.display_mode = 'calendar'
          AND mp.target_date = substr(mp.captured_at, 1, 10)
          AND mp.predicted_mean_f IS NOT NULL
          AND mp.predicted_high_f IS NOT NULL
          AND mp.predicted_low_f IS NOT NULL
          AND da.reading_count >= 10
          AND (? IS NULL OR mp.model_version = ?)
        ORDER BY mp.captured_at DESC
    """
    return list(connection.execute(query, (model_version, model_version)))


def aggregate_bias(rows: list[sqlite3.Row]) -> dict:
    if not rows:
        return {"general": {"biasF": 0.0, "sampleCount": 0}, "byHorizon": {}}

    total_error = 0.0
    general_count = 0
    horizon_buckets: dict[str, list[float]] = {}

    for row in rows:
        error_f = float(row["actual_mean_f"]) - float(row["predicted_mean_f"])
        total_error += error_f
        general_count += 1
        horizon_key = str(int(row["horizon_days"]))
        horizon_buckets.setdefault(horizon_key, []).append(error_f)

    by_horizon = {}
    for horizon_key, errors in horizon_buckets.items():
        by_horizon[horizon_key] = {
            "biasF": round(sum(errors) / len(errors), 4),
            "sampleCount": len(errors),
        }

    return {
        "general": {
            "biasF": round(total_error / general_count, 4),
            "sampleCount": general_count,
        },
        "byHorizon": by_horizon,
    }


def filter_rows_since(rows: list[sqlite3.Row], since_dt: datetime) -> list[sqlite3.Row]:
    filtered = []
    for row in rows:
        try:
            target_dt = datetime.fromisoformat(str(row["target_date"]) + "T00:00:00+00:00")
        except ValueError:
            continue
        if target_dt >= since_dt:
            filtered.append(row)
    return filtered


def filter_same_day_rows_since(rows: list[sqlite3.Row], since_dt: datetime) -> list[sqlite3.Row]:
    filtered = []
    for row in rows:
        captured_at = parse_utc_timestamp(row["captured_at"])
        if captured_at is not None and captured_at >= since_dt:
            filtered.append(row)
    return filtered


def aggregate_same_day_by_capture_hour(rows: list[sqlite3.Row], time_zone: ZoneInfo) -> dict:
    buckets: dict[str, list[sqlite3.Row]] = {}
    for row in rows:
        captured_at = parse_utc_timestamp(row["captured_at"])
        if captured_at is None:
            continue

        local_hour = captured_at.astimezone(time_zone).hour
        buckets.setdefault(str(local_hour), []).append(row)

    aggregated = {}
    for hour_key, hour_rows in buckets.items():
        mean_errors = []
        high_errors = []
        low_errors = []
        for row in hour_rows:
            mean_errors.append(float(row["actual_mean_f"]) - float(row["predicted_mean_f"]))
            high_errors.append(float(row["actual_high_f"]) - float(row["predicted_high_f"]))
            low_errors.append(float(row["actual_low_f"]) - float(row["predicted_low_f"]))

        aggregated[hour_key] = {
            "meanBiasF": round(sum(mean_errors) / len(mean_errors), 4),
            "highBiasF": round(sum(high_errors) / len(high_errors), 4),
            "lowBiasF": round(sum(low_errors) / len(low_errors), 4),
            "sampleCount": len(hour_rows),
        }

    return aggregated


def aggregate_seasonal(rows: list[sqlite3.Row]) -> dict:
    month_buckets: dict[str, list[sqlite3.Row]] = {}
    for row in rows:
        target_date = str(row["target_date"])
        if len(target_date) < 7:
            continue
        month_buckets.setdefault(target_date[5:7], []).append(row)

    seasonal = {}
    for month_key, month_rows in month_buckets.items():
        seasonal[month_key] = aggregate_bias(month_rows)
    return seasonal


def main() -> int:
    request = parse_request()
    lookback_days = normalize_days(request.get("lookbackDays"), DEFAULT_LOOKBACK_DAYS)
    seasonal_lookback_days = normalize_days(
        request.get("seasonalLookbackDays"),
        DEFAULT_SEASONAL_LOOKBACK_DAYS,
    )
    same_day_lookback_days = normalize_days(
        request.get("sameDayLookbackDays"),
        DEFAULT_SAME_DAY_LOOKBACK_DAYS,
    )
    time_zone = normalize_time_zone(request.get("timeZone"))
    model_version = normalize_model_version(request.get("modelVersion"))

    if not DB_PATH.exists():
        print(json.dumps({
            "generatedAt": utc_now().isoformat().replace("+00:00", "Z"),
            "rolling": {"general": {"biasF": 0.0, "sampleCount": 0}, "byHorizon": {}},
            "seasonalByMonth": {},
            "sameDayTimeZone": str(time_zone),
            "sameDayByCaptureHour": {},
        }))
        return 0

    connection = sqlite3.connect(DB_PATH)
    try:
        rows = fetch_error_rows(connection, model_version)
        same_day_rows = fetch_same_day_rows(connection, model_version)
    finally:
        connection.close()

    now = utc_now()
    rolling_rows = filter_rows_since(rows, now - timedelta(days=lookback_days))
    seasonal_rows = filter_rows_since(rows, now - timedelta(days=seasonal_lookback_days))
    recent_same_day_rows = filter_same_day_rows_since(same_day_rows, now - timedelta(days=same_day_lookback_days))

    payload = {
        "generatedAt": now.isoformat().replace("+00:00", "Z"),
        "rolling": aggregate_bias(rolling_rows),
        "seasonalByMonth": aggregate_seasonal(seasonal_rows),
        "sameDayTimeZone": str(time_zone),
        "sameDayByCaptureHour": aggregate_same_day_by_capture_hour(recent_same_day_rows, time_zone),
    }
    print(json.dumps(payload))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
