#!/usr/bin/env python3
import json
import sqlite3
import unittest

import hourly_activation_gate as gate


class ActivationGateTest(unittest.TestCase):
	def test_deduplicates_capture_hour_and_uses_daily_sensor_max(self):
		connection = sqlite3.connect(":memory:")
		connection.execute("CREATE TABLE model_runs (captured_at TEXT, raw_payload_json TEXT)")
		connection.execute("CREATE TABLE sensor_readings (captured_at TEXT, sensor_timestamp TEXT, water_temp_f REAL)")
		for captured_at, baseline, candidate, clamped in (
			("2026-07-21T11:05:00Z", 80, 81, False),
			("2026-07-21T11:45:00Z", 82, 83, True),
			("2026-07-21T16:05:00Z", 84, 84, False),
		):
			payload = {
				"modelVersion": gate.DEFAULT_MODEL,
				"predictions": [{"date": "2026-07-21", "highF": baseline,
					"hourlyObservation": {"candidate": {"highF": candidate},
						"adjustment": {"highWasClamped": clamped}}}],
			}
			connection.execute("INSERT INTO model_runs VALUES (?, ?)", (captured_at, json.dumps(payload)))
		for timestamp, temperature in (("2026-07-21T15:00:00Z", 82), ("2026-07-21T20:00:00Z", 84)):
			connection.execute("INSERT INTO sensor_readings VALUES (?, ?, ?)", (timestamp, timestamp, temperature))
		result = gate.analyze(connection)
		self.assertEqual(result["completeDates"], ["2026-07-21"])
		self.assertEqual(result["overall"]["samples"], 2)
		self.assertAlmostEqual(result["overall"]["baselineMaeF"], 1.5)
		self.assertAlmostEqual(result["overall"]["candidateMaeF"], 1.0)
		self.assertAlmostEqual(result["overall"]["clampRate"], 0.25)
		self.assertEqual(result["overall"]["wins"], 1)
		self.assertEqual(result["overall"]["losses"], 0)
		self.assertEqual(result["overall"]["ties"], 1)


if __name__ == "__main__":
	unittest.main()
