#!/usr/bin/env python3
"""Compare observed hourly candidates with the daily same-day baseline."""

from __future__ import annotations

import argparse
import json
import sqlite3
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from statistics import mean
from zoneinfo import ZoneInfo


DEFAULT_DB = Path("/home/pi/.openclaw/data/pool-model.db")
DEFAULT_MODEL = "pooltemp-2026-07-20-hourly-delta-v2"
PERIODS = (("morning", 7, 11), ("midday", 12, 15), ("afternoon", 16, 21))


def parse_time(value: str) -> datetime:
	return datetime.fromisoformat(value.replace("Z", "+00:00"))


def load_samples(connection, model_version, time_zone, start_date=None, end_date=None,
		start_hour=7, end_hour=21):
	tz = ZoneInfo(time_zone)
	groups = defaultdict(list)
	query = "SELECT captured_at, raw_payload_json FROM model_runs ORDER BY captured_at"
	for captured_at, raw_json in connection.execute(query):
		try:
			payload = json.loads(raw_json)
		except (TypeError, json.JSONDecodeError):
			continue
		if payload.get("modelVersion") != model_version:
			continue
		predictions = payload.get("predictions") or []
		if not predictions:
			continue
		prediction = predictions[0]
		observation = prediction.get("hourlyObservation") or {}
		candidate = observation.get("candidate") or {}
		adjustment = observation.get("adjustment") or {}
		baseline = prediction.get("highF")
		candidate_high = candidate.get("highF")
		date_key = str(prediction.get("date") or "")[:10]
		if not date_key or baseline is None or candidate_high is None:
			continue
		local_capture = parse_time(captured_at).astimezone(tz)
		hour = local_capture.hour
		if hour < start_hour or hour > end_hour:
			continue
		if start_date and date_key < start_date:
			continue
		if end_date and date_key > end_date:
			continue
		groups[(date_key, hour)].append({
			"baseline": float(baseline),
			"candidate": float(candidate_high),
			"clamped": bool(adjustment.get("highWasClamped", False)),
		})

	samples = []
	for (date_key, hour), rows in sorted(groups.items()):
		samples.append({
			"date": date_key,
			"hour": hour,
			"baseline": mean(row["baseline"] for row in rows),
			"candidate": mean(row["candidate"] for row in rows),
			"clampRate": mean(1 if row["clamped"] else 0 for row in rows),
			"runCount": len(rows),
		})
	return samples


def load_actuals(connection, start_date, end_date, time_zone):
	tz = ZoneInfo(time_zone)
	actuals = defaultdict(list)
	for captured_at, sensor_timestamp, water_temp_f in connection.execute(
			"SELECT captured_at, sensor_timestamp, water_temp_f FROM sensor_readings"):
		timestamp = sensor_timestamp or captured_at
		try:
			date_key = parse_time(timestamp).astimezone(tz).date().isoformat()
		except (TypeError, ValueError):
			continue
		if start_date <= date_key <= end_date:
			actuals[date_key].append(float(water_temp_f))
	return {date_key: max(values) for date_key, values in actuals.items()}


def summarize(rows):
	if not rows:
		return None
	baseline_errors = [row["baseline"] - row["actual"] for row in rows]
	candidate_errors = [row["candidate"] - row["actual"] for row in rows]
	wins = sum(abs(candidate) < abs(baseline) - 1e-9 for baseline, candidate in zip(baseline_errors, candidate_errors))
	losses = sum(abs(candidate) > abs(baseline) + 1e-9 for baseline, candidate in zip(baseline_errors, candidate_errors))
	return {
		"samples": len(rows),
		"baselineMaeF": mean(abs(value) for value in baseline_errors),
		"candidateMaeF": mean(abs(value) for value in candidate_errors),
		"maeChangeF": mean(abs(value) for value in candidate_errors) - mean(abs(value) for value in baseline_errors),
		"baselineBiasF": mean(baseline_errors),
		"candidateBiasF": mean(candidate_errors),
		"baselineMaxAbsErrorF": max(abs(value) for value in baseline_errors),
		"candidateMaxAbsErrorF": max(abs(value) for value in candidate_errors),
		"wins": wins,
		"losses": losses,
		"ties": len(rows) - wins - losses,
		"clampRate": mean(row["clampRate"] for row in rows),
	}


def analyze(connection, model_version=DEFAULT_MODEL, time_zone="America/New_York",
		start_date=None, end_date=None, start_hour=7, end_hour=21):
	samples = load_samples(connection, model_version, time_zone, start_date, end_date, start_hour, end_hour)
	if not samples:
		return {"modelVersion": model_version, "completeDates": [], "overall": None, "periods": {}, "days": []}
	start = start_date or min(row["date"] for row in samples)
	end = end_date or max(row["date"] for row in samples)
	actuals = load_actuals(connection, start, end, time_zone)
	complete_dates = sorted(set(row["date"] for row in samples) & set(actuals))
	rows = [{**row, "actual": actuals[row["date"]]} for row in samples if row["date"] in actuals]
	periods = {}
	for name, first_hour, last_hour in PERIODS:
		periods[name] = summarize([row for row in rows if first_hour <= row["hour"] <= last_hour])
	days = []
	for date_key in complete_dates:
		day_rows = [row for row in rows if row["date"] == date_key]
		days.append({"date": date_key, "actualHighF": actuals[date_key], **(summarize(day_rows) or {})})
	return {
		"modelVersion": model_version,
		"timeZone": time_zone,
		"captureHours": [start_hour, end_hour],
		"completeDates": complete_dates,
		"overall": summarize(rows),
		"periods": periods,
		"days": days,
	}


def format_markdown(result):
	lines = [f"# Hourly activation gate: `{result['modelVersion']}`", ""]
	if not result["overall"]:
		return "\n".join(lines + ["No complete observations matched the requested gate."])
	overall = result["overall"]
	lines.extend([
		f"Complete dates: {', '.join(result['completeDates'])}",
		f"Capture hours: {result['captureHours'][0]:02d}:00-{result['captureHours'][1]:02d}:59 ({result['timeZone']})",
		"",
		"| Scope | Samples | Baseline MAE | Candidate MAE | Change | W/L/T | Clamp rate |",
		"|---|---:|---:|---:|---:|---:|---:|",
	])
	for name, metrics in [("overall", overall), *result["periods"].items()]:
		if not metrics:
			continue
		lines.append(
			f"| {name} | {metrics['samples']} | {metrics['baselineMaeF']:.3f} F | "
			f"{metrics['candidateMaeF']:.3f} F | {metrics['maeChangeF']:+.3f} F | "
			f"{metrics['wins']}/{metrics['losses']}/{metrics['ties']} | {metrics['clampRate']:.1%} |"
		)
	lines.extend(["", "| Date | Actual high | Baseline MAE | Candidate MAE | W/L/T |", "|---|---:|---:|---:|---:|"])
	for day in result["days"]:
		lines.append(
			f"| {day['date']} | {day['actualHighF']:.1f} F | {day['baselineMaeF']:.3f} F | "
			f"{day['candidateMaeF']:.3f} F | {day['wins']}/{day['losses']}/{day['ties']} |"
		)
	return "\n".join(lines)


def main():
	parser = argparse.ArgumentParser()
	parser.add_argument("--db", type=Path, default=DEFAULT_DB)
	parser.add_argument("--model-version", default=DEFAULT_MODEL)
	parser.add_argument("--time-zone", default="America/New_York")
	parser.add_argument("--start-date")
	parser.add_argument("--end-date")
	parser.add_argument("--start-hour", type=int, default=7)
	parser.add_argument("--end-hour", type=int, default=21)
	parser.add_argument("--format", choices=("markdown", "json"), default="markdown")
	args = parser.parse_args()
	with sqlite3.connect(args.db) as connection:
		result = analyze(connection, args.model_version, args.time_zone, args.start_date,
			args.end_date, args.start_hour, args.end_hour)
	print(json.dumps(result, indent=2) if args.format == "json" else format_markdown(result))


if __name__ == "__main__":
	main()
