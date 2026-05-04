const path = require("node:path");
const { spawn } = require("node:child_process");
const NodeHelper = require("node_helper");
const Log = require("logger");

const PYTHON_BIN = "python3";
const LOGGER_SCRIPT = "/home/pi/.openclaw/scripts/log_pool_model_run.py";
const FEEDBACK_SCRIPT = path.join(__dirname, "tools", "pool_model_feedback.py");

module.exports = NodeHelper.create({
	socketNotificationReceived (notification, payload) {
		if (notification === "REQUEST_MODEL_CORRECTION") {
			this.sendModelCorrection(payload);
			return;
		}

		if (notification === "POOL_MODEL_RUN" && payload && typeof payload === "object") {
			this.persistModelRun(payload);
		}
	},

	persistModelRun (payload) {
		const child = spawn(PYTHON_BIN, [LOGGER_SCRIPT], {
			stdio: ["pipe", "pipe", "pipe"]
		});

		let stdout = "";
		let stderr = "";

		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});

		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});

		child.on("error", (error) => {
			Log.error("[MMM-PoolTemp] Failed to launch pool model logger:", error);
		});

		child.on("close", (code) => {
			if (code !== 0) {
				Log.error(`[MMM-PoolTemp] Pool model logger exited with code ${code}: ${stderr || stdout}`);
				return;
			}

			if (stdout.trim()) {
				Log.info(`[MMM-PoolTemp] ${stdout.trim()}`);
			}
		});

		child.stdin.end(`${JSON.stringify(payload)}\n`);
	},

	sendModelCorrection (payload) {
		const identifier = payload && typeof payload === "object" ? payload.identifier : null;
		const child = spawn(PYTHON_BIN, [FEEDBACK_SCRIPT], {
			stdio: ["pipe", "pipe", "pipe"]
		});

		let stdout = "";
		let stderr = "";

		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});

		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});

		child.on("error", (error) => {
			Log.error("[MMM-PoolTemp] Failed to launch model feedback helper:", error);
		});

		child.on("close", (code) => {
			if (code !== 0) {
				Log.error(`[MMM-PoolTemp] Model feedback helper exited with code ${code}: ${stderr || stdout}`);
				return;
			}

			try {
				const parsed = JSON.parse(stdout);
				this.sendSocketNotification("MODEL_CORRECTION", {
					identifier,
					correction: parsed
				});
			} catch (error) {
				Log.error("[MMM-PoolTemp] Failed to parse model feedback helper output:", error, stdout);
			}
		});

		child.stdin.end(`${JSON.stringify(payload || {})}\n`);
	}
});
