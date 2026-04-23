/* global Module, Log */

Module.register("MMM-PoolTemp", {
	defaults: {
		displayMode: "card",
		cardDays: 2,
		calendarDays: 5,
		weatherNotification: "POOLTEMP_WEATHER_DATA",
		sensorNotification: "STSTATUS_DEVICE_DATA",
		weatherLocationName: "Lutz",
		temperatureSource: "manual",
		manualWaterTempF: 74.6,
		manualAmbientAirTempF: null,
		manualObservedLowF: 74.6,
		manualObservedHighF: 76.9,
		smartthingsDeviceId: null,
		labels: {
			now: "Pool",
			waiting: "Waiting for forecast data",
			today: "Today",
			tomorrow: "Tomorrow",
			unknown: "Unknown"
		},
		pool: {
			gallons: 10000,
			surfaceAreaSqFt: 276,
			averageDepthFt: 4.5,
			inGround: true,
			shellColor: "white",
			shellMaterial: "fiberglass",
			screenEnclosed: false,
			sunExposure: "full",
			covered: false,
			heated: false
		},
		model: {
			airCoupling: 0.18,
			solarGainBase: 0.055,
			overnightLossBase: 0.05,
			rainPenaltyMax: 0.6,
			dayChangeClampF: 3.0,
			localAmbientCarryForward: 0.18
		}
	},

	start () {
		this.currentWeather = null;
		this.forecastArray = [];
		this.predictions = [];
		this.lastWeatherAt = null;
		this.lastCalendarDigest = "";
		this.sensorWaterTempF = null;
		this.sensorAmbientAirTempF = null;
		this.activeWaterTempF = this.config.manualWaterTempF;
	},

	getStyles () {
		return [this.file("MMM-PoolTemp.css")];
	},

	notificationReceived (notification, payload) {
		if (notification === this.config.weatherNotification) {
			this.handleWeatherNotification(payload);
		}

		if (notification === this.config.sensorNotification) {
			this.handleSensorNotification(payload);
		}
	},

	handleWeatherNotification (payload) {
		if (!payload || typeof payload !== "object") {
			return;
		}

		const locationName = String(payload.locationName || "");
		if (this.config.weatherLocationName && locationName && !locationName.includes(this.config.weatherLocationName)) {
			return;
		}

		const type = String(payload.type || "").toLowerCase();
		if (type === "current" && payload.data) {
			this.currentWeather = payload.data;
		}

		if ((type === "forecast" || type === "daily") && Array.isArray(payload.data)) {
			this.forecastArray = payload.data.slice();
		}

		this.lastWeatherAt = new Date();
		this.recalculate();
	},

	handleSensorNotification (payload) {
		if (!payload || !Array.isArray(payload.devices) || !this.config.smartthingsDeviceId) {
			return;
		}

		const device = payload.devices.find((entry) => entry && entry.id === this.config.smartthingsDeviceId);
		if (!device) {
			return;
		}

		const nextTemp = this.numberOrNull(
			device.temperature,
			device.capabilities && device.capabilities.temperature,
			device.primaryCapability === "temperature" ? device.primaryState : null
		);

		if (nextTemp === null) {
			return;
		}

		this.sensorWaterTempF = nextTemp;
		this.sensorAmbientAirTempF = this.numberOrNull(
			device.ambientTemperature,
			device.airTemperature,
			device.capabilities && device.capabilities.ambientTemperature,
			device.capabilities && device.capabilities.airTemperature,
			device.capabilities && device.capabilities.outdoorTemperature
		);

		if (this.config.temperatureSource === "smartthings" || this.sensorAmbientAirTempF !== null) {
			this.recalculate();
		}
	},

	recalculate () {
		const baseWaterTempF = this.resolveWaterTempF();
		if (baseWaterTempF === null || this.forecastArray.length === 0) {
			this.predictions = [];
			this.broadcastCalendarEvents();
			this.updateDom(300);
			return;
		}

		const recentRangeF = this.calculateRecentRangeF();
		let rollingMeanF = baseWaterTempF;
		const predictions = [];

		for (const [index, forecast] of this.forecastArray.slice(0, this.config.calendarDays).entries()) {
			const prediction = this.predictDay({
				previousMeanF: rollingMeanF,
				forecast,
				recentRangeF,
				dayIndex: index,
				currentWeather: this.currentWeather
			});

			predictions.push(prediction);
			rollingMeanF = prediction.meanF;
		}

		this.activeWaterTempF = baseWaterTempF;
		this.predictions = predictions;
		this.broadcastCalendarEvents();
		this.updateDom(300);
	},

	resolveWaterTempF () {
		if (this.config.temperatureSource === "smartthings" && this.sensorWaterTempF !== null) {
			return this.sensorWaterTempF;
		}

		return this.numberOrNull(this.config.manualWaterTempF);
	},

	calculateRecentRangeF () {
		const lowF = this.numberOrNull(this.config.manualObservedLowF);
		const highF = this.numberOrNull(this.config.manualObservedHighF);
		if (lowF === null || highF === null) {
			return 2.0;
		}

		return Math.max(1.0, highF - lowF);
	},

	resolveAmbientAirTempF (currentWeather) {
		return this.numberOrNull(
			this.sensorAmbientAirTempF,
			this.config.manualAmbientAirTempF,
			currentWeather && currentWeather.temperature
		);
	},

	predictDay ({ previousMeanF, forecast, recentRangeF, dayIndex, currentWeather }) {
		const minAirF = this.numberOrNull(forecast.minTemperature, forecast.temperature, previousMeanF);
		const maxAirF = this.numberOrNull(forecast.maxTemperature, minAirF, previousMeanF);
		const meanAirF = (minAirF + maxAirF) / 2;
		const precipProbability = this.numberOrNull(forecast.precipitationProbability, 0);
		const weatherType = String(forecast.weatherType || "");
		const weatherCurrentAirF = this.numberOrNull(currentWeather && currentWeather.temperature);
		const localCurrentAirF = this.resolveAmbientAirTempF(currentWeather);
		const currentAirF = this.numberOrNull(localCurrentAirF, weatherCurrentAirF);
		const sunFactor = this.getSunFactor(weatherType, precipProbability);
		const exposureFactor = this.getExposureFactor();
		const shellFactor = this.getShellFactor();

		const airTermF = (meanAirF - previousMeanF) * this.config.model.airCoupling;
		const solarTermF = Math.max(0, maxAirF - 74) *
			this.config.model.solarGainBase *
			sunFactor *
			exposureFactor *
			shellFactor;
		const overnightTermF = Math.max(0, 72 - minAirF) *
			this.config.model.overnightLossBase *
			this.getOvernightLossFactor();
		const rainTermF = (precipProbability / 100) *
			this.config.model.rainPenaltyMax *
			(this.config.pool.covered ? 0.2 : 1.0);
		const rawDayChangeF = airTermF + solarTermF - overnightTermF - rainTermF;
		const dayChangeF = this.clamp(rawDayChangeF, -this.config.model.dayChangeClampF, this.config.model.dayChangeClampF);

		let meanF = previousMeanF + dayChangeF;
		const airSwingF = Math.max(0, maxAirF - minAirF);
		const swingF = this.clamp(
			(recentRangeF * 0.55) +
			(Math.max(0, airSwingF - 8) * 0.05) +
			(sunFactor * 0.35) -
			((precipProbability / 100) * 0.25),
			1.2,
			3.4
		);

		let lowF = meanF - (swingF / 2);
		let highF = meanF + (swingF / 2);

		if (dayIndex === 0) {
			const now = new Date();
			const hour = now.getHours() + (now.getMinutes() / 60);
			const sunWindowFactor = hour < 12 ? 1.0 : (hour < 15 ? 0.8 : (hour < 18 ? 0.45 : 0.15));
			const observedRetentionFactor = hour < 12 ? 0.28 : (hour < 15 ? 0.52 : (hour < 18 ? 0.78 : 0.58));
			const localAirBiasF = Math.max(0, currentAirF - this.numberOrNull(weatherCurrentAirF, currentAirF));
			const effectiveMaxAirF = Math.max(maxAirF, currentAirF);
			const baselineAirF = Math.max(
				this.activeWaterTempF,
				this.numberOrNull(currentAirF, minAirF, this.activeWaterTempF)
			);
			const intradayWarmupF = Math.max(0, effectiveMaxAirF - baselineAirF) *
				0.28 *
				sunFactor *
				exposureFactor *
				shellFactor *
				sunWindowFactor;
			const observedLiftF = Math.max(0, this.activeWaterTempF - meanF);
			const retainedHeatF = intradayWarmupF * observedRetentionFactor;
			const localAmbientCarryF = localAirBiasF *
				this.config.model.localAmbientCarryForward *
				sunFactor *
				exposureFactor;

			meanF = Math.max(
				meanF + (observedLiftF * observedRetentionFactor) + localAmbientCarryF,
				this.activeWaterTempF + retainedHeatF
			);

			lowF = Math.min(lowF, this.activeWaterTempF);
			highF = Math.max(
				highF,
				this.activeWaterTempF,
				this.activeWaterTempF + intradayWarmupF
			);
		}

		return {
			date: forecast.date,
			label: this.formatDayLabel(forecast.date, dayIndex),
			meanF,
			lowF,
			highF,
			trend: (meanF - previousMeanF) > 0.25 ? "warming" : ((meanF - previousMeanF) < -0.25 ? "cooling" : "steady"),
			poolTempF: Math.round(meanF),
			poolRangeLowF: Math.round(lowF),
			poolRangeHighF: Math.round(highF),
			poolRangeHighDisplayF: dayIndex === 0 ? Math.max(highF, this.activeWaterTempF) : Math.round(highF),
			maxAirF: Math.round(maxAirF),
			minAirF: Math.round(minAirF),
			precipProbability: Math.round(precipProbability),
			weatherType
		};
	},

	getSunFactor (weatherType, precipProbability) {
		const normalized = weatherType.toLowerCase();
		let factor = 0.95;

		if (normalized.includes("clear") || normalized.includes("sunny")) {
			factor = 1.05;
		} else if (normalized.includes("partly")) {
			factor = 0.95;
		} else if (normalized.includes("cloud")) {
			factor = 0.75;
		} else if (normalized.includes("fog") || normalized.includes("rain") || normalized.includes("snow") || normalized.includes("sleet") || normalized.includes("thunder")) {
			factor = 0.5;
		}

		factor -= (precipProbability / 100) * 0.25;
		return this.clamp(factor, 0.2, 1.05);
	},

	getExposureFactor () {
		if (this.config.pool.sunExposure === "partial") {
			return 0.78;
		}

		if (this.config.pool.sunExposure === "low") {
			return 0.58;
		}

		return 1.0;
	},

	getShellFactor () {
		const color = String(this.config.pool.shellColor || "").toLowerCase();
		if (color.includes("dark") || color.includes("black")) {
			return 1.08;
		}

		if (color.includes("white")) {
			return 0.9;
		}

		return 0.97;
	},

	getOvernightLossFactor () {
		let factor = 1.0;

		if (!this.config.pool.screenEnclosed) {
			factor += 0.08;
		}

		if (!this.config.pool.covered) {
			factor += 0.12;
		}

		return factor;
	},

	broadcastCalendarEvents () {
		if (!this.usesCalendarMode()) {
			return;
		}

		if (this.predictions.length === 0) {
			if (this.lastCalendarDigest !== "[]") {
				this.lastCalendarDigest = "[]";
				this.sendNotification("CALENDAR_EVENTS", []);
			}
			return;
		}

		const events = this.predictions.slice(0, this.config.calendarDays).map((prediction) => {
			const startDate = this.getLocalMidnight(prediction.date);
			const endDate = new Date(startDate.getTime() + (24 * 60 * 60 * 1000));
			const isWarm = prediction.poolTempF >= 80;

			return {
				title: `Pool Temp: ${prediction.poolTempF}\u00b0`,
				fullDayEvent: true,
				startDate: startDate.valueOf(),
				endDate: endDate.valueOf(),
				calendarName: "Pool Temp",
				class: `pooltemp-forecast ${isWarm ? "pooltemp-warm" : "pooltemp-cool"}`,
				color: isWarm ? "#ffb3b3" : "#9ed0ff",
				description: `Pool Temp: ${prediction.poolTempF}\u00b0`,
				location: "",
				symbol: [],
				poolTempF: prediction.poolTempF,
				poolTempHtml: `Pool Temp: <span class="${isWarm ? "mmm-pooltemp-warm" : "mmm-pooltemp-cool"}">${prediction.poolTempF}\u00b0</span>`,
				skip: false
			};
		});

		const digest = JSON.stringify(events);
		if (digest === this.lastCalendarDigest) {
			return;
		}

		this.lastCalendarDigest = digest;
		this.sendNotification("CALENDAR_EVENTS", events);
	},

	getDom () {
		const wrapper = document.createElement("div");
		wrapper.className = "mmm-pooltemp";

		if (!this.usesCardMode()) {
			wrapper.classList.add("mmm-pooltemp-hidden");
			return wrapper;
		}

		const card = document.createElement("div");
		card.className = "mmm-pooltemp-card";
		wrapper.appendChild(card);

		const summary = document.createElement("div");
		summary.className = "mmm-pooltemp-summary";
		card.appendChild(summary);

		const summaryLeft = document.createElement("div");
		summary.appendChild(summaryLeft);

		const summaryLabel = document.createElement("div");
		summaryLabel.className = "mmm-pooltemp-label";
		summaryLabel.textContent = this.config.labels.now;
		summaryLeft.appendChild(summaryLabel);

		const summaryNow = document.createElement("div");
		summaryNow.className = `mmm-pooltemp-now ${this.activeWaterTempF >= 80 ? "mmm-pooltemp-warm" : "mmm-pooltemp-cool"}`;
		summaryNow.textContent = `${this.formatTemperature(this.activeWaterTempF || this.config.manualWaterTempF, 1)}\u00b0`;
		summaryLeft.appendChild(summaryNow);

		const summarySource = document.createElement("div");
		summarySource.className = "mmm-pooltemp-source";
		summarySource.textContent = this.config.temperatureSource === "smartthings" && this.sensorWaterTempF !== null
			? "Sensor anchored"
			: "Manual anchored";
		summary.appendChild(summarySource);

		const days = document.createElement("div");
		days.className = "mmm-pooltemp-days";
		card.appendChild(days);

		if (this.predictions.length === 0) {
			const waiting = document.createElement("div");
			waiting.className = "mmm-pooltemp-day";
			waiting.textContent = this.config.labels.waiting;
			days.appendChild(waiting);
			return wrapper;
		}

		for (const prediction of this.predictions.slice(0, this.config.cardDays)) {
			const day = document.createElement("div");
			day.className = "mmm-pooltemp-day";
			days.appendChild(day);

			const header = document.createElement("div");
			header.className = "mmm-pooltemp-day-header";
			day.appendChild(header);

			const label = document.createElement("div");
			label.className = "mmm-pooltemp-day-label";
			label.textContent = prediction.label;
			header.appendChild(label);

			const trend = document.createElement("div");
			trend.className = "mmm-pooltemp-day-trend";
			trend.textContent = prediction.trend;
			header.appendChild(trend);

			const range = document.createElement("div");
			range.className = "mmm-pooltemp-range";
			const highDisplay = prediction.label === this.config.labels.today
				? this.formatTemperature(prediction.poolRangeHighDisplayF, 1)
				: this.formatTemperature(prediction.poolRangeHighDisplayF, 0);
			range.innerHTML = `<span class="mmm-pooltemp-range-high ${prediction.poolRangeHighDisplayF >= 80 ? "mmm-pooltemp-warm" : "mmm-pooltemp-cool"}">${highDisplay}\u00b0</span> / <span class="mmm-pooltemp-range-low">${prediction.poolRangeLowF}\u00b0</span>`;
			day.appendChild(range);

			const meta = document.createElement("div");
			meta.className = "mmm-pooltemp-meta";
			meta.textContent = `Air ${prediction.maxAirF}\u00b0 / ${prediction.minAirF}\u00b0`;
			day.appendChild(meta);
		}

		return wrapper;
	},

	usesCardMode () {
		return this.config.displayMode === "card" || this.config.displayMode === "both";
	},

	usesCalendarMode () {
		return this.config.displayMode === "calendar" || this.config.displayMode === "both";
	},

	formatDayLabel (dateValue, dayIndex) {
		if (dayIndex === 0) {
			return this.config.labels.today;
		}

		if (dayIndex === 1) {
			return this.config.labels.tomorrow;
		}

		if (!dateValue) {
			return this.config.labels.unknown;
		}

		try {
			return new Date(dateValue).toLocaleDateString(config.language || "en-US", { weekday: "short" });
		} catch (error) {
			Log.warn("[MMM-PoolTemp] Failed to format forecast date:", error);
			return this.config.labels.unknown;
		}
	},

	getLocalMidnight (dateValue) {
		const date = new Date(dateValue);
		return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
	},

	clamp (value, min, max) {
		return Math.min(max, Math.max(min, value));
	},

	formatTemperature (value, decimals = 0) {
		const parsed = Number(value);
		if (!Number.isFinite(parsed)) {
			return "--";
		}

		return parsed.toFixed(decimals);
	},

	numberOrNull (...values) {
		for (const value of values) {
			const parsed = Number(value);
			if (Number.isFinite(parsed)) {
				return parsed;
			}
		}

		return null;
	}
});
