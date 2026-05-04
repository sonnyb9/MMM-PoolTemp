#!/usr/bin/env python3

import json
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path


DB_PATH = Path("/home/pi/.openclaw/data/pool-model.db")
DEFAULT_LOOKBACK_DAYS = 7
DEFAULT_SEASONAL_LOOKBACK_DAYS = 120


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
    model_version = normalize_model_version(request.get("modelVersion"))

    if not DB_PATH.exists():
        print(json.dumps({
            "generatedAt": utc_now().isoformat().replace("+00:00", "Z"),
            "rolling": {"general": {"biasF": 0.0, "sampleCount": 0}, "byHorizon": {}},
            "seasonalByMonth": {},
        }))
        return 0

    connection = sqlite3.connect(DB_PATH)
    try:
        rows = fetch_error_rows(connection, model_version)
    finally:
        connection.close()

    now = utc_now()
    rolling_rows = filter_rows_since(rows, now - timedelta(days=lookback_days))
    seasonal_rows = filter_rows_since(rows, now - timedelta(days=seasonal_lookback_days))

    payload = {
        "generatedAt": now.isoformat().replace("+00:00", "Z"),
        "rolling": aggregate_bias(rolling_rows),
        "seasonalByMonth": aggregate_seasonal(seasonal_rows),
    }
    print(json.dumps(payload))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
