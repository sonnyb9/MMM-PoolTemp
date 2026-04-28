const { spawn } = require("node:child_process");
const NodeHelper = require("node_helper");
const Log = require("logger");

const PYTHON_BIN = "python3";
const LOGGER_SCRIPT = "/home/pi/.openclaw/scripts/log_pool_model_run.py";

module.exports = NodeHelper.create({
	socketNotificationReceived (notification, payload) {
		if (notification !== "POOL_MODEL_RUN" || !payload || typeof payload !== "object") {
			return;
		}

		this.persistModelRun(payload);
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
	}
});
