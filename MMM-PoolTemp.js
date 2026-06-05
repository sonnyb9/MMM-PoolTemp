/* global Module, Log */

Module.register("MMM-PoolTemp", {
	defaults: {
		displayMode: "card",
		cardDays: 2,
		calendarDays: 5,
		weatherNotification: "POOLTEMP_WEATHER_DATA",
		sensorNotification: "STSTATUS_DEVICE_DATA",
		weatherLocationName: "Lutz",
		weatherTemperatureUnit: "auto",
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
			localAmbientCarryForward: 0.18,
			sensorStaleHours: 4,
			staleSensorFallbackHours: 48,
			autoCorrectionEnabled: true,
			autoCorrectionMinSamples: 2,
			autoCorrectionLookbackDays: 7,
			autoCorrectionSeasonalLookbackDays: 120,
			autoCorrectionMinSeasonalSamples: 3,
			maxAutoCorrectionF: 2.5,
			maxSeasonalCorrectionF: 2.0,
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
		this.sensorLastUpdatedAt = null;
		this.lastGoodSensorWaterTempF = null;
		this.lastGoodSensorUpdatedAt = null;
		this.activeWaterTempF = this.config.manualWaterTempF;
		this.lastPersistDigest = "";
		this.modelCorrection = null;
		this.lastCorrectionRequestAt = 0;
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

	socketNotificationReceived (notification, payload) {
		if (notification !== "MODEL_CORRECTION" || !payload || typeof payload !== "object") {
			return;
		}

		if (payload.identifier && payload.identifier !== this.identifier) {
			return;
		}

		this.modelCorrection = payload.correction || null;
		if (this.forecastArray.length > 0) {
			this.recalculate();
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
		this.requestModelCorrection(false);
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

		const sensorTimestamp = this.parseTimestamp(
			device.temperatureUpdatedAt,
			device.capabilities && device.capabilities.temperatureUpdatedAt,
			payload.timestamp
		);

		this.sensorWaterTempF = nextTemp;
		this.sensorLastUpdatedAt = sensorTimestamp;
		this.lastGoodSensorWaterTempF = nextTemp;
		this.lastGoodSensorUpdatedAt = sensorTimestamp instanceof Date ? sensorTimestamp : new Date();
		this.sensorAmbientAirTempF = this.numberOrNull(
			device.ambientTemperature,
			device.airTemperature,
			device.capabilities && device.capabilities.ambientTemperature,
			device.capabilities && device.capabilities.airTemperature,
			device.capabilities && device.capabilities.outdoorTemperature
		);

		if (this.config.temperatureSource === "smartthings" || this.sensorAmbientAirTempF !== null) {
			this.requestModelCorrection(false);
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
		this.persistModelRun({
			baseWaterTempF,
			recentRangeF,
			sensorTrend: null,
			predictions
		});
		this.broadcastCalendarEvents();
		this.updateDom(300);
	},

	resolveWaterTempF () {
		if (this.config.temperatureSource === "smartthings") {
			if (this.sensorWaterTempF !== null && !this.isSensorReadingStale()) {
				return this.sensorWaterTempF;
			}

			if (this.lastGoodSensorWaterTempF !== null) {
				return this.lastGoodSensorWaterTempF;
			}
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
			this.normalizeWeatherTemperature(currentWeather && currentWeather.temperature)
		);
	},

	predictDay ({ previousMeanF, forecast, recentRangeF, dayIndex, currentWeather }) {
		const minAirF = this.numberOrNull(
			this.normalizeWeatherTemperature(forecast.minTemperature),
			this.normalizeWeatherTemperature(forecast.temperature),
			previousMeanF
		);
		const maxAirF = this.numberOrNull(
			this.normalizeWeatherTemperature(forecast.maxTemperature),
			minAirF,
			previousMeanF
		);
		const meanAirF = (minAirF + maxAirF) / 2;
		const precipProbability = this.numberOrNull(forecast.precipitationProbability, 0);
		const weatherType = String(forecast.weatherType || "");
		const weatherCurrentAirF = this.numberOrNull(
			this.normalizeWeatherTemperature(currentWeather && currentWeather.temperature)
		);
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
		const correctionBiasF = this.resolveAdaptiveCorrectionBias(dayIndex, forecast && forecast.date);

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

		if (dayIndex > 0 && correctionBiasF !== 0) {
			meanF += correctionBiasF;
			lowF += correctionBiasF;
			highF += correctionBiasF;
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

	isSensorReadingStale () {
		if (!(this.sensorLastUpdatedAt instanceof Date) || Number.isNaN(this.sensorLastUpdatedAt.getTime())) {
			return true;
		}

		const staleMs = this.config.model.sensorStaleHours * 60 * 60 * 1000;
		return (Date.now() - this.sensorLastUpdatedAt.getTime()) > staleMs;
	},

	isSensorReadingWithinFallbackWindow () {
		if (!(this.sensorLastUpdatedAt instanceof Date) || Number.isNaN(this.sensorLastUpdatedAt.getTime())) {
			return false;
		}

		const fallbackHours = this.numberOrNull(this.config.model.staleSensorFallbackHours);
		if (fallbackHours === null || fallbackHours <= 0) {
			return false;
		}

		const fallbackMs = fallbackHours * 60 * 60 * 1000;
		return (Date.now() - this.sensorLastUpdatedAt.getTime()) <= fallbackMs;
	},

	requestModelCorrection (force = false) {
		if (!this.config.model.autoCorrectionEnabled) {
			return;
		}

		const now = Date.now();
		const refreshMs = 10 * 60 * 1000;
		if (!force && (now - this.lastCorrectionRequestAt) < refreshMs) {
			return;
		}

		this.lastCorrectionRequestAt = now;
		this.sendSocketNotification("REQUEST_MODEL_CORRECTION", {
			identifier: this.identifier,
			modelVersion: "pooltemp-2026-05-03-phase6-hybrid",
			lookbackDays: this.numberOrNull(this.config.model.autoCorrectionLookbackDays, 7),
			seasonalLookbackDays: this.numberOrNull(this.config.model.autoCorrectionSeasonalLookbackDays, 120)
		});
	},

	resolveAdaptiveCorrectionBias (dayIndex, forecastDate) {
		if (!this.config.model.autoCorrectionEnabled || dayIndex <= 0 || !this.modelCorrection) {
			return 0;
		}

		const horizonKey = String(dayIndex);
		const minSamples = this.numberOrNull(this.config.model.autoCorrectionMinSamples, 2);
		const minSeasonalSamples = this.numberOrNull(this.config.model.autoCorrectionMinSeasonalSamples, 3);
		const maxRollingF = this.numberOrNull(this.config.model.maxAutoCorrectionF, 2.5);
		const maxSeasonalF = this.numberOrNull(this.config.model.maxSeasonalCorrectionF, 2.0);
		const seasonalEntry = this.resolveSeasonalCorrectionEntry(horizonKey, forecastDate);
		const rollingEntry = this.resolveRollingCorrectionEntry(horizonKey);

		let seasonalBiasF = 0;
		if (seasonalEntry && Number(seasonalEntry.sampleCount) >= minSeasonalSamples) {
			seasonalBiasF = this.clamp(this.numberOrNull(seasonalEntry.biasF, 0), -maxSeasonalF, maxSeasonalF);
		}

		let rollingResidualF = 0;
		if (rollingEntry && Number(rollingEntry.sampleCount) >= minSamples) {
			const rollingBiasF = this.numberOrNull(rollingEntry.biasF, 0);
			rollingResidualF = this.clamp(rollingBiasF - seasonalBiasF, -maxRollingF, maxRollingF);
		}

		const biasF = seasonalBiasF + rollingResidualF;
		return this.roundNumber(biasF, 3) || 0;
	},

	resolveRollingCorrectionEntry (horizonKey) {
		if (!this.modelCorrection || !this.modelCorrection.rolling) {
			return null;
		}

		return (this.modelCorrection.rolling.byHorizon && this.modelCorrection.rolling.byHorizon[horizonKey]) ||
			this.modelCorrection.rolling.general ||
			null;
	},

	resolveSeasonalCorrectionEntry (horizonKey, forecastDate) {
		if (!this.modelCorrection || !this.modelCorrection.seasonalByMonth) {
			return null;
		}

		const monthKey = this.extractMonthKey(forecastDate);
		const monthEntry = this.modelCorrection.seasonalByMonth[monthKey];
		if (!monthEntry) {
			return null;
		}

		return (monthEntry.byHorizon && monthEntry.byHorizon[horizonKey]) ||
			monthEntry.general ||
			null;
	},

	extractMonthKey (forecastDate) {
		if (typeof forecastDate === "string" && forecastDate.length >= 7) {
			return forecastDate.slice(5, 7);
		}

		const date = forecastDate ? new Date(forecastDate) : new Date();
		if (Number.isNaN(date.getTime())) {
			return String(new Date().getMonth() + 1).padStart(2, "0");
		}

		return String(date.getMonth() + 1).padStart(2, "0");
	},

	parseTimestamp (...values) {
		for (const value of values) {
			if (!value) {
				continue;
			}

			const parsed = value instanceof Date ? value : new Date(value);
			if (!Number.isNaN(parsed.getTime())) {
				return parsed;
			}
		}

		return null;
	},

	getSunFactor (weatherType, precipProbability) {
		const normalized = weatherType.toLowerCase();
		let factor = 1.0;

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

	resolveWeatherTemperatureUnit () {
		const configured = String(this.config.weatherTemperatureUnit || "auto").toLowerCase();
		if (configured === "fahrenheit" || configured === "celsius") {
			return configured;
		}

		const candidates = [];
		if (this.currentWeather) {
			candidates.push(
				this.numberOrNull(this.currentWeather.temperature),
				this.numberOrNull(this.currentWeather.minTemperature),
				this.numberOrNull(this.currentWeather.maxTemperature)
			);
		}

		for (const forecast of this.forecastArray.slice(0, Math.min(this.forecastArray.length, 5))) {
			if (!forecast) {
				continue;
			}

			candidates.push(
				this.numberOrNull(forecast.minTemperature),
				this.numberOrNull(forecast.maxTemperature),
				this.numberOrNull(forecast.temperature)
			);
		}

		const temps = candidates.filter((value) => Number.isFinite(value));
		if (temps.length === 0) {
			return "fahrenheit";
		}

		const maxTemp = Math.max(...temps);
		const minTemp = Math.min(...temps);
		const warmWaterAnchorF = this.numberOrNull(
			this.sensorWaterTempF,
			this.config.manualWaterTempF,
			this.config.manualObservedHighF
		);

		if (maxTemp <= 45 && minTemp >= -30 && warmWaterAnchorF !== null && warmWaterAnchorF >= 55) {
			return "celsius";
		}

		return "fahrenheit";
	},

	normalizeWeatherTemperature (value) {
		const parsed = this.numberOrNull(value);
		if (parsed === null) {
			return null;
		}

		return this.resolveWeatherTemperatureUnit() === "celsius"
			? ((parsed * 9) / 5) + 32
			: parsed;
	},

	persistModelRun ({ baseWaterTempF, recentRangeF, sensorTrend, predictions }) {
		if (!Array.isArray(predictions) || predictions.length === 0) {
			return;
		}

		const capturedAt = new Date().toISOString();
		const waterTempSource = this.resolveWaterTempSource();
		const payload = {
			capturedAt,
			modelVersion: "pooltemp-2026-05-03-phase6-hybrid",
			displayMode: this.config.displayMode,
			weatherLocationName: this.config.weatherLocationName,
			waterTempSource,
			anchorWaterTempF: this.roundNumber(baseWaterTempF, 3),
			activeWaterTempF: this.roundNumber(this.activeWaterTempF, 3),
			sensorStale: this.isSensorReadingStale(),
			sensorTimestamp: this.sensorLastUpdatedAt instanceof Date ? this.sensorLastUpdatedAt.toISOString() : null,
			sensorTrendHours: this.roundNumber(sensorTrend && sensorTrend.hours, 3),
			trendPerHourF: this.roundNumber(sensorTrend && sensorTrend.perHourF, 4),
			trendDeltaF: this.roundNumber(sensorTrend && sensorTrend.deltaF, 3),
			recentRangeF: this.roundNumber(recentRangeF, 3),
			manualObservedLowF: this.numberOrNull(this.config.manualObservedLowF),
			manualObservedHighF: this.numberOrNull(this.config.manualObservedHighF),
			adaptiveCorrection: this.summarizeAdaptiveCorrection(),
			modelParams: { ...this.config.model },
			poolProfile: {
				...this.config.pool
			},
			currentWeather: this.summarizeCurrentWeather(),
			forecastDigest: this.summarizeForecastDigest(),
			inputDigest: this.buildInputDigest(baseWaterTempF, recentRangeF, sensorTrend, predictions),
			notes: this.buildModelRunNotes(waterTempSource, sensorTrend),
			predictions: predictions.map((prediction) => ({
				date: prediction.date,
				label: prediction.label,
				trend: prediction.trend,
				meanF: this.roundNumber(prediction.meanF, 4),
				lowF: this.roundNumber(prediction.lowF, 4),
				highF: this.roundNumber(prediction.highF, 4),
				maxAirF: prediction.maxAirF,
				minAirF: prediction.minAirF,
				precipProbability: prediction.precipProbability,
				weatherType: prediction.weatherType
			}))
		};

		const digest = JSON.stringify(payload.inputDigest);
		if (digest === this.lastPersistDigest) {
			return;
		}

		this.lastPersistDigest = digest;
		this.sendSocketNotification("POOL_MODEL_RUN", payload);
	},

	resolveWaterTempSource () {
		if (this.config.temperatureSource !== "smartthings") {
			return "manual";
		}

		if (this.sensorWaterTempF === null) {
			return "manual-fallback-no-sensor";
		}

		if (!this.isSensorReadingStale()) {
			return "smartthings";
		}

		return this.isSensorReadingWithinFallbackWindow()
			? "smartthings-stale-hold"
			: "manual-fallback-stale-sensor";
	},

	summarizeCurrentWeather () {
		if (!this.currentWeather || typeof this.currentWeather !== "object") {
			return {};
		}

		return {
			temperature: this.roundNumber(this.normalizeWeatherTemperature(this.currentWeather.temperature), 3),
			minTemperature: this.roundNumber(this.normalizeWeatherTemperature(this.currentWeather.minTemperature), 3),
			maxTemperature: this.roundNumber(this.normalizeWeatherTemperature(this.currentWeather.maxTemperature), 3),
			precipitationProbability: this.roundNumber(this.currentWeather.precipitationProbability, 3),
			weatherType: String(this.currentWeather.weatherType || "")
		};
	},

	summarizeForecastDigest () {
		return this.forecastArray.slice(0, this.config.calendarDays).map((forecast) => ({
			date: forecast && forecast.date ? String(forecast.date).slice(0, 10) : null,
			minTemperature: this.roundNumber(this.normalizeWeatherTemperature(forecast && forecast.minTemperature), 3),
			maxTemperature: this.roundNumber(this.normalizeWeatherTemperature(forecast && forecast.maxTemperature), 3),
			precipitationProbability: this.roundNumber(forecast && forecast.precipitationProbability, 3),
			weatherType: forecast ? String(forecast.weatherType || "") : ""
		}));
	},

	summarizeAdaptiveCorrection () {
		if (!this.modelCorrection || !this.config.model.autoCorrectionEnabled) {
			return {};
		}

		const monthKey = this.extractMonthKey(new Date());
		const seasonal = this.modelCorrection.seasonalByMonth && this.modelCorrection.seasonalByMonth[monthKey];
		return {
			rolling: this.modelCorrection.rolling || {},
			seasonalMonth: monthKey,
			seasonal: seasonal || {}
		};
	},

	buildInputDigest (baseWaterTempF, recentRangeF, sensorTrend, predictions) {
		return {
			weatherLocationName: this.config.weatherLocationName,
			displayMode: this.config.displayMode,
			waterTempSource: this.resolveWaterTempSource(),
			anchorWaterTempF: this.roundNumber(baseWaterTempF, 3),
			recentRangeF: this.roundNumber(recentRangeF, 3),
			adaptiveCorrection: this.summarizeAdaptiveCorrection(),
			sensorTimestamp: this.sensorLastUpdatedAt instanceof Date ? this.sensorLastUpdatedAt.toISOString() : null,
			sensorTrendPerHourF: this.roundNumber(sensorTrend && sensorTrend.perHourF, 4),
			sensorTrendHours: this.roundNumber(sensorTrend && sensorTrend.hours, 3),
			currentWeather: this.summarizeCurrentWeather(),
			forecastDigest: this.summarizeForecastDigest(),
			modelParams: { ...this.config.model },
			predictionDigest: predictions.map((prediction) => ({
				date: prediction.date,
				meanF: this.roundNumber(prediction.meanF, 4),
				lowF: this.roundNumber(prediction.lowF, 4),
				highF: this.roundNumber(prediction.highF, 4)
			}))
		};
	},

	buildModelRunNotes (waterTempSource, sensorTrend) {
		const correctionSummary = this.describeAdaptiveCorrection();
		const normalizedWeatherNote = this.resolveWeatherTemperatureUnit() === "celsius"
			? "weather temperatures normalized from celsius to fahrenheit"
			: "";

		if (normalizedWeatherNote && correctionSummary) {
			return `${normalizedWeatherNote}; ${correctionSummary}`;
		}

		if (normalizedWeatherNote) {
			return normalizedWeatherNote;
		}

		if (waterTempSource === "smartthings-stale-hold") {
			return "sensor stale, holding last successful sensor reading";
		}

		if (waterTempSource === "manual-fallback-stale-sensor") {
			return "sensor stale beyond fallback window, manual fallback";
		}

		if (waterTempSource === "manual-fallback-no-sensor") {
			return "smartthings requested but no sensor reading available";
		}

		if (correctionSummary) {
			return correctionSummary;
		}

		if (sensorTrend && Number.isFinite(sensorTrend.perHourF) && sensorTrend.perHourF > 0.05) {
			return "warming trend bias applied";
		}

		if (sensorTrend && Number.isFinite(sensorTrend.perHourF) && sensorTrend.perHourF < -0.05) {
			return "cooling trend bias applied";
		}

		return "";
	},

	describeAdaptiveCorrection () {
		if (!this.config.model.autoCorrectionEnabled || !this.modelCorrection) {
			return "";
		}

		const minSamples = this.numberOrNull(this.config.model.autoCorrectionMinSamples, 2);
		const minSeasonalSamples = this.numberOrNull(this.config.model.autoCorrectionMinSeasonalSamples, 3);
		const rolling = this.modelCorrection.rolling && this.modelCorrection.rolling.general;
		const monthKey = this.extractMonthKey(new Date());
		const seasonalMonth = this.modelCorrection.seasonalByMonth && this.modelCorrection.seasonalByMonth[monthKey];
		const parts = [];

		if (seasonalMonth && Number(seasonalMonth.general && seasonalMonth.general.sampleCount) >= minSeasonalSamples) {
			const seasonalBias = this.roundNumber(seasonalMonth.general.biasF, 2);
			if (seasonalBias !== null && Math.abs(seasonalBias) >= 0.2) {
				parts.push(`seasonal ${seasonalBias > 0 ? "+" : ""}${seasonalBias}F`);
			}
		}

		if (rolling && Number(rolling.sampleCount) >= minSamples) {
			const seasonalBias = this.numberOrNull(seasonalMonth && seasonalMonth.general && seasonalMonth.general.biasF, 0);
			const rollingBias = this.numberOrNull(rolling.biasF, 0);
			const rollingResidual = this.roundNumber(rollingBias - seasonalBias, 2);
			if (rollingResidual !== null && Math.abs(rollingResidual) >= 0.2) {
				parts.push(`rolling ${rollingResidual > 0 ? "+" : ""}${rollingResidual}F`);
			}
		}

		return parts.length > 0 ? `auto correction ${parts.join(", ")}` : "";
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
			const displayPoolTempF = prediction.label === this.config.labels.today
				? Math.round(this.activeWaterTempF)
				: prediction.poolTempF;
			const isWarm = displayPoolTempF >= 80;

			return {
				title: `Pool Temp: ${displayPoolTempF}\u00b0`,
				fullDayEvent: true,
				startDate: startDate.valueOf(),
				endDate: endDate.valueOf(),
				calendarName: "Pool Temp",
				class: `pooltemp-forecast ${isWarm ? "pooltemp-warm" : "pooltemp-cool"}`,
				color: isWarm ? "#ffb3b3" : "#9ed0ff",
				description: `Pool Temp: ${displayPoolTempF}\u00b0`,
				location: "",
				symbol: [],
				poolTempF: displayPoolTempF,
				poolTempHtml: `Pool Temp: <span class="${isWarm ? "mmm-pooltemp-warm" : "mmm-pooltemp-cool"}">${displayPoolTempF}\u00b0</span>`,
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
		summarySource.textContent = this.describeWaterTempSource();
		summary.appendChild(summarySource);

		if (this.isDisplayingStaleSensorData()) {
			const staleWarning = document.createElement("div");
			staleWarning.className = "mmm-pooltemp-alert";
			staleWarning.textContent = "Stale data";
			summary.appendChild(staleWarning);
		}

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

	roundNumber (value, decimals = 0) {
		const parsed = Number(value);
		if (!Number.isFinite(parsed)) {
			return null;
		}

		return Number(parsed.toFixed(decimals));
	},

	numberOrNull (...values) {
		for (const value of values) {
			const parsed = Number(value);
			if (Number.isFinite(parsed)) {
				return parsed;
			}
		}

		return null;
	},

	isDisplayingStaleSensorData () {
		return this.resolveWaterTempSource() === "smartthings-stale-hold";
	},

	describeWaterTempSource () {
		const waterTempSource = this.resolveWaterTempSource();

		if (waterTempSource === "smartthings") {
			return "Sensor anchored";
		}

		if (waterTempSource === "smartthings-stale-hold") {
			return "Sensor stale, holding last reading";
		}

		if (waterTempSource === "manual-fallback-no-sensor") {
			return "No sensor reading yet, manual fallback";
		}

		return "Manual anchored";
	}
});
