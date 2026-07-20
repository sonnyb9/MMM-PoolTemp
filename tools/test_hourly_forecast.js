const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

let definition;
const source = fs.readFileSync(path.join(__dirname, "..", "MMM-PoolTemp.js"), "utf8");
vm.runInNewContext(source, {
	Module: {
		register: (name, moduleDefinition) => {
			assert.equal(name, "MMM-PoolTemp");
			definition = moduleDefinition;
		}
	},
	Log: { warn: () => {} },
	config: { language: "en-US" },
	Intl,
	Date,
	Math,
	Number,
	String,
	Array,
	Object,
	JSON,
	console
});

function makeModule (overrides = {}) {
	const subject = Object.create(definition);
	subject.config = {
		...definition.defaults,
		...overrides,
		model: { ...definition.defaults.model, ...(overrides.model || {}) },
		pool: { ...definition.defaults.pool, ...(overrides.pool || {}) },
		labels: { ...definition.defaults.labels, ...(overrides.labels || {}) }
	};
	subject.currentWeather = { temperature: 25 };
	subject.forecastArray = [{
		date: "2026-07-14",
		minTemperature: 23,
		maxTemperature: 33,
		precipitationProbability: 20,
		weatherType: "partlycloudy-day"
	}];
	subject.hourlyArray = [];
	subject.activeWaterTempF = 79;
	subject.sensorAmbientAirTempF = null;
	subject.modelCorrection = null;
	return subject;
}

function hourlyEntry (date, temperature, precipitationProbability = 0, weatherType = "clearsky-day") {
	return { date, temperature, precipitationProbability, weatherType };
}

const subject = makeModule({
	timeZone: "America/New_York",
	weatherTemperatureUnit: "celsius",
	hourlyMinRemainingHours: 3
});
subject.hourlyArray = [
	hourlyEntry("2026-07-14T11:00:00Z", 24),
	hourlyEntry("2026-07-14T12:00:00Z", 25, 10),
	hourlyEntry("2026-07-14T13:00:00Z", 27, 20),
	hourlyEntry("2026-07-14T14:00:00Z", 29, 30),
	hourlyEntry("2026-07-15T12:00:00Z", 30, 40)
];

const summary = subject.summarizeRemainingHourlyForecast("2026-07-14", new Date("2026-07-14T12:30:00Z"));
assert.ok(summary);
assert.equal(summary.hourCount, 3);
assert.equal(summary.date, "2026-07-14");
assert.equal(summary.minTemperature, 77);
assert.equal(summary.maxTemperature, 84.2);
assert.equal(summary.meanTemperature, 80.6);
assert.equal(summary.meanPrecipitationProbability, 20);
assert.equal(summary.dominantWeatherType, "clearsky-day");

subject.hourlyArray = subject.hourlyArray.slice(0, 2);
assert.equal(
	subject.summarizeRemainingHourlyForecast("2026-07-14", new Date("2026-07-14T12:30:00Z")),
	null
);

const baseline = { lowF: 78, meanF: 80, highF: 82 };
const bounded = subject.boundHourlyCandidate(baseline, {
	...baseline,
	lowF: 74,
	meanF: 84,
	highF: 87
});
assert.equal(bounded.lowF, 76.5);
assert.equal(bounded.meanF, 81.5);
assert.equal(bounded.highF, 83.5);

const deltaSubject = makeModule({
	hourlyForecastMode: "observe",
	weatherTemperatureUnit: "fahrenheit",
	hourlyMaxAirDeltaWeight: 0.45,
	hourlyMeanAirDeltaWeight: 0.10
});
deltaSubject.summarizeRemainingHourlyForecast = () => ({
	date: "2026-07-14",
	hourCount: 6,
	firstHour: "2026-07-14T14:00:00.000Z",
	lastHour: "2026-07-14T19:00:00.000Z",
	minTemperature: 82,
	maxTemperature: 88,
	meanTemperature: 85,
	meanPrecipitationProbability: 10,
	dominantWeatherType: "clearsky-day"
});
const deltaBaseline = {
	date: "2026-07-14",
	label: "Today",
	lowF: 78,
	meanF: 80,
	highF: 82,
	minAirF: 75,
	maxAirF: 90
};
const negativeDelta = deltaSubject.buildHourlyObservation({
	date: "2026-07-14",
	minTemperature: 75,
	maxTemperature: 90,
	precipitationProbability: 20
}, deltaBaseline);
assert.equal(negativeDelta.adjustment.components.maxAirDeltaF, -2);
assert.equal(negativeDelta.adjustment.components.meanAirDeltaF, 2.5);
assert.equal(negativeDelta.adjustment.rawHighDeltaF, -0.65);
assert.equal(negativeDelta.adjustment.appliedHighDeltaF, -0.65);
assert.equal(negativeDelta.adjustment.highWasClamped, false);
assert.equal(negativeDelta.candidate.highF, 81.35);

deltaSubject.summarizeRemainingHourlyForecast = () => ({
	date: "2026-07-14",
	hourCount: 4,
	firstHour: "2026-07-14T14:00:00.000Z",
	lastHour: "2026-07-14T17:00:00.000Z",
	minTemperature: 90,
	maxTemperature: 96,
	meanTemperature: 94,
	meanPrecipitationProbability: 0,
	dominantWeatherType: "clearsky-day"
});
const positiveDelta = deltaSubject.buildHourlyObservation({
	date: "2026-07-14",
	minTemperature: 75,
	maxTemperature: 90,
	precipitationProbability: 20
}, deltaBaseline);
assert.equal(positiveDelta.adjustment.rawHighDeltaF, 3.85);
assert.equal(positiveDelta.adjustment.appliedHighDeltaF, 1.5);
assert.equal(positiveDelta.adjustment.highWasClamped, true);
assert.equal(positiveDelta.candidate.highF, 83.5);
assert.deepEqual(JSON.parse(JSON.stringify(positiveDelta.adjustment.daily)), {
	minAirF: 75,
	maxAirF: 90,
	meanAirF: 82.5,
	precipitationProbability: 20
});

assert.equal(makeModule({ hourlyForecastMode: "observe" }).getHourlyForecastMode(), "observe");
assert.equal(makeModule({ hourlyForecastMode: "active" }).getHourlyForecastMode(), "active");
assert.equal(makeModule({ hourlyForecastMode: "invalid" }).getHourlyForecastMode(), "off");

const notificationModule = makeModule();
notificationModule.requestModelCorrection = () => {};
notificationModule.recalculate = () => {};
notificationModule.handleWeatherNotification({
	type: "hourly",
	locationName: "Lutz",
	data: [hourlyEntry("2026-07-14T12:00:00Z", 25)]
});
assert.equal(notificationModule.hourlyArray.length, 1);

function runRecalculation (mode) {
	const recalculation = makeModule({
		hourlyForecastMode: mode,
		hourlyMinRemainingHours: 1,
		weatherTemperatureUnit: "fahrenheit",
		manualWaterTempF: 79,
		manualObservedLowF: 77,
		manualObservedHighF: 80
	});
	const nextHour = new Date(Date.now() + (60 * 60 * 1000));
	recalculation.forecastArray = [{
		date: recalculation.getLocalDateKey(nextHour),
		minTemperature: 75,
		maxTemperature: 91,
		precipitationProbability: 20,
		weatherType: "partlycloudy-day"
	}];
	recalculation.hourlyArray = [hourlyEntry(nextHour.toISOString(), 88, 10)];
	recalculation.currentWeather = { temperature: 84 };
	recalculation.activeWaterTempF = 79;
	recalculation.sensorWaterTempF = null;
	recalculation.sensorLastUpdatedAt = null;
	recalculation.lastGoodSensorWaterTempF = null;
	recalculation.lastGoodSensorUpdatedAt = null;
	recalculation.sensorAmbientAirTempF = null;
	recalculation.lastPersistDigest = "";
	recalculation.lastCalendarDigest = "";
	recalculation.persistModelRun = () => {};
	recalculation.broadcastCalendarEvents = () => {};
	recalculation.updateDom = () => {};
	recalculation.recalculate();
	return recalculation.predictions[0];
}

const observedPrediction = runRecalculation("observe");
assert.equal(observedPrediction.hourlyObservation.applied, false);
assert.doesNotThrow(() => JSON.stringify(observedPrediction));

const activePrediction = runRecalculation("active");
assert.equal(activePrediction.hourlyObservation.applied, true);
assert.doesNotThrow(() => JSON.stringify(activePrediction));

console.log("hourly forecast behavior: pass");
