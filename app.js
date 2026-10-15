const SITES = {
  enlin: {
    label: "ENLIN",
    baseUrl: "https://truckmonitoring-bffa5-default-rtdb.asia-southeast1.firebasedatabase.app",
    dailyPath: "daily_movements",
  },
  bacao: {
    label: "BACAO",
    // Add BACAO Firebase Realtime Database URL here when available.
    // Example: https://your-bacao-project-default-rtdb.asia-southeast1.firebasedatabase.app
    baseUrl: "",
    dailyPath: "daily_movements",
  },
};

const $ = (id) => document.getElementById(id);
let currentView = "dashboardView";
let dashboardTimer = null;
let weatherTimer = null;
let liveClockTimer = null;
let dashboardStreams = [];
let dashboardStreamDay = "";
let dashboardRealtimeReady = false;
const realtimeBuckets = { enlin: {}, bacao: {} };
let realtimeRenderTimer = null;

const WEATHER_SITE = {
  // Shared operating-area weather for ENLIN + BACAO.
  latitude: 14.3522,
  longitude: 120.8821,
};

function firebaseUrl(site, path = "") {
  return `${site.baseUrl.replace(/\/$/, "")}/${path}.json`;
}

async function requestSite(site, path) {
  if (!site.baseUrl) return null;
  const response = await fetch(firebaseUrl(site, path), { cache: "no-store" });
  if (!response.ok) throw new Error(`${site.label} Firebase ${response.status}`);
  return response.json();
}

function localDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function shiftDateKey(dateKey, days) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + days);
  return localDateKey(date);
}

function dateKeyFromIso(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : localDateKey(date);
}

function prettyDate(dateKey) {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-PH", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

function timeOnly(date = new Date()) {
  return date.toLocaleTimeString("en-PH", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "Asia/Manila",
  });
}

function updateLiveClock() {
  const asOfTime = $("asOfText")?.querySelector(".as-of-time");
  if (asOfTime) asOfTime.textContent = timeOnly();
}

function startLiveClock() {
  clearInterval(liveClockTimer);
  updateLiveClock();
  liveClockTimer = setInterval(updateLiveClock, 1000);
}

function showToast(message, type = "success") {
  const toast = $("toast");
  toast.textContent = message;
  toast.className = `toast show${type === "error" ? " error" : ""}`;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.className = "toast"; }, 2600);
}

function recordsFromObject(data) {
  return data ? Object.entries(data).map(([id, record]) => ({ id, ...record })) : [];
}

function dedupeRecords(records) {
  const map = new Map();
  records.forEach((record) => map.set(record.id, record));
  return [...map.values()];
}

function getIntervalMinutes(record) {
  const start = Number(record.timeInEpoch) || new Date(record.timeIn || "").getTime();
  const end = Number(record.timeOutEpoch) || new Date(record.timeOut || "").getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.floor((end - start) / 60000);
}

async function getDailyBucket(site, dateKey) {
  if (!site.baseUrl) return [];
  return recordsFromObject(await requestSite(site, `${site.dailyPath}/${dateKey}`));
}

function streamUrl(site, dateKey) {
  return firebaseUrl(site, `${site.dailyPath}/${dateKey}`);
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function applyRealtimeEvent(currentValue, payload, eventType) {
  const path = payload?.path ?? "/";
  const incoming = payload?.data;

  if (path === "/") {
    if (eventType === "patch") {
      const base = currentValue && typeof currentValue === "object" ? cloneJson(currentValue) : {};
      if (incoming && typeof incoming === "object") Object.assign(base, incoming);
      return base;
    }
    return incoming && typeof incoming === "object" ? cloneJson(incoming) : {};
  }

  const root = currentValue && typeof currentValue === "object" ? cloneJson(currentValue) : {};
  const parts = path.split("/").filter(Boolean);
  let cursor = root;

  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (!cursor[key] || typeof cursor[key] !== "object") cursor[key] = {};
    cursor = cursor[key];
  }

  const last = parts[parts.length - 1];
  if (!last) return root;

  if (eventType === "patch" && incoming && typeof incoming === "object") {
    const existing = cursor[last] && typeof cursor[last] === "object" ? cursor[last] : {};
    cursor[last] = { ...existing, ...incoming };
  } else if (incoming === null) {
    delete cursor[last];
  } else {
    cursor[last] = cloneJson(incoming);
  }

  return root;
}

function scheduleRealtimeRender() {
  clearTimeout(realtimeRenderTimer);
  realtimeRenderTimer = setTimeout(() => renderRealtimeDashboard(), 80);
}

function renderRealtimeSite(prefix, site, today, yesterday) {
  const status = $(`${prefix}Status`);
  if (!site.baseUrl) {
    setDashboardValues(prefix, 0, 0, 0);
    status.textContent = "Source pending";
    status.className = "site-status pending";
    return;
  }

  const todayRecords = recordsFromObject(realtimeBuckets[prefix][today] || {});
  const yesterdayRecords = recordsFromObject(realtimeBuckets[prefix][yesterday] || {});
  const combined = dedupeRecords([...todayRecords, ...yesterdayRecords]);
  const delivery = todayRecords.filter((r) => r.inBare === false).length;
  const pullout = combined.filter((r) => r.outBare === false && dateKeyFromIso(r.timeOut) === today).length;
  const passThrough = todayRecords.filter(isPassThrough).length;

  setDashboardValues(prefix, delivery, pullout, passThrough);
  status.textContent = "Live";
  status.className = "site-status ready";
}

function renderRealtimeDashboard() {
  const today = localDateKey();
  const yesterday = shiftDateKey(today, -1);
  $("todayLabel").textContent = prettyDate(today);
  const asOfTime = $("asOfText")?.querySelector(".as-of-time");
  if (asOfTime) asOfTime.textContent = timeOnly();
  renderRealtimeSite("enlin", SITES.enlin, today, yesterday);
  renderRealtimeSite("bacao", SITES.bacao, today, yesterday);
}

function closeDashboardStreams() {
  dashboardStreams.forEach((stream) => {
    try { stream.close(); } catch (_) {}
  });
  dashboardStreams = [];
  dashboardRealtimeReady = false;
}

function openBucketStream(prefix, site, dateKey) {
  if (!site.baseUrl || typeof EventSource === "undefined") return null;
  const status = $(`${prefix}Status`);
  const source = new EventSource(streamUrl(site, dateKey));

  const handle = (eventType) => (event) => {
    try {
      const payload = JSON.parse(event.data);
      realtimeBuckets[prefix][dateKey] = applyRealtimeEvent(
        realtimeBuckets[prefix][dateKey] || {},
        payload,
        eventType
      );
      dashboardRealtimeReady = true;
      scheduleRealtimeRender();
    } catch (error) {
      console.error("Realtime parse error", error);
    }
  };

  source.addEventListener("put", handle("put"));
  source.addEventListener("patch", handle("patch"));
  source.onopen = () => {
    if (status) {
      status.textContent = "Live";
      status.className = "site-status ready";
    }
  };
  source.onerror = () => {
    if (status && site.baseUrl) {
      status.textContent = "Reconnecting…";
      status.className = "site-status pending";
    }
  };
  dashboardStreams.push(source);
  return source;
}

async function seedRealtimeBuckets(today, yesterday) {
  await Promise.all(Object.entries(SITES).map(async ([prefix, site]) => {
    if (!site.baseUrl) return;
    try {
      const [todayData, yesterdayData] = await Promise.all([
        requestSite(site, `${site.dailyPath}/${today}`),
        requestSite(site, `${site.dailyPath}/${yesterday}`),
      ]);
      realtimeBuckets[prefix][today] = todayData || {};
      realtimeBuckets[prefix][yesterday] = yesterdayData || {};
    } catch (error) {
      console.error(error);
    }
  }));
  renderRealtimeDashboard();
}

async function startDashboardRealtime({ force = false } = {}) {
  const today = localDateKey();
  const yesterday = shiftDateKey(today, -1);
  if (!force && dashboardStreams.length && dashboardStreamDay === today) return;

  closeDashboardStreams();
  dashboardStreamDay = today;
  await seedRealtimeBuckets(today, yesterday);

  if (typeof EventSource === "undefined") {
    startDashboardAutoRefresh();
    return;
  }

  Object.entries(SITES).forEach(([prefix, site]) => {
    if (!site.baseUrl) return;
    openBucketStream(prefix, site, today);
    openBucketStream(prefix, site, yesterday);
  });
}

function isPassThrough(record) {
  return record?.passThrough === true ||
    String(record?.passThrough ?? "").toLowerCase() === "true" ||
    String(record?.movementType ?? "").toUpperCase() === "PASS THROUGH";
}

const dashboardTotals = {
  enlin: { delivery: 0, pullout: 0, passThrough: 0 },
  bacao: { delivery: 0, pullout: 0, passThrough: 0 },
};

function updateCombinedDashboard() {
  const delivery = dashboardTotals.enlin.delivery + dashboardTotals.bacao.delivery;
  const pullout = dashboardTotals.enlin.pullout + dashboardTotals.bacao.pullout;
  const passThrough = dashboardTotals.enlin.passThrough + dashboardTotals.bacao.passThrough;
  $("combinedDeliveryCount").textContent = delivery;
  $("combinedPulloutCount").textContent = pullout;
  $("combinedPassThroughCount").textContent = passThrough;
  $("combinedTotalTransactions").textContent = delivery + pullout;
}

function setDashboardValues(prefix, delivery, pullout, passThrough = 0) {
  $(`${prefix}DeliveryCount`).textContent = delivery;
  $(`${prefix}PulloutCount`).textContent = pullout;
  $(`${prefix}PassThroughCount`).textContent = passThrough;
  $(`${prefix}TotalTransactions`).textContent = delivery + pullout;
  dashboardTotals[prefix] = { delivery, pullout, passThrough };
  updateCombinedDashboard();
}

async function loadSiteDashboard(prefix, site, today, yesterday) {
  const status = $(`${prefix}Status`);
  if (!site.baseUrl) {
    setDashboardValues(prefix, 0, 0, 0);
    status.textContent = "Source pending";
    status.className = "site-status pending";
    return;
  }

  try {
    const [todayRecords, yesterdayRecords] = await Promise.all([
      getDailyBucket(site, today),
      getDailyBucket(site, yesterday),
    ]);
    const combined = dedupeRecords([...todayRecords, ...yesterdayRecords]);
    const delivery = todayRecords.filter((r) => r.inBare === false).length;
    const pullout = combined.filter((r) => r.outBare === false && dateKeyFromIso(r.timeOut) === today).length;
    const passThrough = todayRecords.filter(isPassThrough).length;
    setDashboardValues(prefix, delivery, pullout, passThrough);
    status.textContent = "Connected";
    status.className = "site-status ready";
  } catch (error) {
    console.error(error);
    setDashboardValues(prefix, 0, 0, 0);
    status.textContent = "Connection error";
    status.className = "site-status error";
  }
}

async function loadDashboard({ silent = false } = {}) {
  const today = localDateKey();
  const yesterday = shiftDateKey(today, -1);
  const refreshBtn = $("refreshBtn");
  if (!silent) refreshBtn.classList.add("loading");
  $("todayLabel").textContent = prettyDate(today);
  const asOf = $("asOfText");
  const asOfTime = asOf?.querySelector(".as-of-time");
  if (asOfTime) asOfTime.textContent = timeOnly();

  try {
    await Promise.all([
      loadSiteDashboard("enlin", SITES.enlin, today, yesterday),
      loadSiteDashboard("bacao", SITES.bacao, today, yesterday),
    ]);
  } finally {
    refreshBtn.classList.remove("loading");
  }
}

function resetReport(prefix) {
  $(`${prefix}Under20Count`).textContent = "—";
  $(`${prefix}Range21to40Count`).textContent = "—";
  $(`${prefix}Range41to60Count`).textContent = "—";
}

function setReport(prefix, records) {
  const completed = records.filter((r) => r.status === "CLOSED" && r.timeOut);
  let under20 = 0, range21to40 = 0, range41to60 = 0, other = 0;
  completed.forEach((record) => {
    const minutes = getIntervalMinutes(record);
    if (minutes === null) other++;
    else if (minutes < 20) under20++;
    else if (minutes >= 21 && minutes <= 40) range21to40++;
    else if (minutes >= 41 && minutes <= 60) range41to60++;
    else other++;
  });
  $(`${prefix}Under20Count`).textContent = under20;
  $(`${prefix}Range21to40Count`).textContent = range21to40;
  $(`${prefix}Range41to60Count`).textContent = range41to60;
}

async function loadSiteReport(prefix, site, dateKey) {
  resetReport(prefix);
  const status = prefix === "bacao" ? $("bacaoReportStatus") : null;
  if (!site.baseUrl) {
    setReport(prefix, []);
    if (status) { status.textContent = "Source pending"; status.className = "site-status pending"; }
    return;
  }
  try {
    const records = await getDailyBucket(site, dateKey);
    setReport(prefix, records);
    if (status) { status.textContent = "Connected"; status.className = "site-status ready"; }
  } catch (error) {
    console.error(error);
    setReport(prefix, []);
    if (status) { status.textContent = "Connection error"; status.className = "site-status error"; }
  }
}

async function loadReport() {
  const selectedDate = $("reportDate").value || localDateKey();
  $("reportDate").value = selectedDate;
  $("reportDateText").textContent = prettyDate(selectedDate);
  $("refreshBtn").classList.add("loading");
  try {
    await Promise.all([
      loadSiteReport("enlin", SITES.enlin, selectedDate),
      loadSiteReport("bacao", SITES.bacao, selectedDate),
    ]);
  } finally {
    $("refreshBtn").classList.remove("loading");
  }
}

function weatherCodeInfo(code) {
  const map = {
    0: ["☀️", "Clear sky"], 1: ["🌤️", "Mainly clear"], 2: ["⛅", "Partly cloudy"], 3: ["☁️", "Overcast"],
    45: ["🌫️", "Fog"], 48: ["🌫️", "Rime fog"], 51: ["🌦️", "Light drizzle"], 53: ["🌦️", "Drizzle"], 55: ["🌧️", "Heavy drizzle"],
    61: ["🌦️", "Light rain"], 63: ["🌧️", "Rain"], 65: ["🌧️", "Heavy rain"], 80: ["🌦️", "Rain showers"], 81: ["🌧️", "Rain showers"], 82: ["⛈️", "Heavy showers"],
    95: ["⛈️", "Thunderstorm"], 96: ["⛈️", "Thunderstorm with hail"], 99: ["⛈️", "Severe thunderstorm"],
  };
  return map[code] || ["🌤️", "Current conditions"];
}

async function fetchWeather(prefix, cfg) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", cfg.latitude);
  url.searchParams.set("longitude", cfg.longitude);
  url.searchParams.set("current", "temperature_2m,apparent_temperature,weather_code,wind_speed_10m");
  url.searchParams.set("hourly", "precipitation_probability");
  url.searchParams.set("forecast_days", "1");
  url.searchParams.set("timezone", "Asia/Manila");
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Weather ${response.status}`);
  const data = await response.json();
  const current = data.current || {};
  const [icon, condition] = weatherCodeInfo(Number(current.weather_code));
  const nowIso = current.time;
  let rain = "—";
  if (nowIso && data.hourly?.time?.length) {
    const idx = data.hourly.time.findIndex((t) => t === nowIso);
    if (idx >= 0) rain = `${data.hourly.precipitation_probability?.[idx] ?? 0}%`;
    else {
      const hour = nowIso.slice(0, 13);
      const hidx = data.hourly.time.findIndex((t) => t.slice(0,13) === hour);
      if (hidx >= 0) rain = `${data.hourly.precipitation_probability?.[hidx] ?? 0}%`;
    }
  }
  $(`${prefix}WeatherIcon`).textContent = icon;
  $(`${prefix}Temp`).textContent = `${Math.round(current.temperature_2m ?? 0)}°`;
  $(`${prefix}Condition`).textContent = condition;
  $(`${prefix}Feels`).textContent = `${Math.round(current.apparent_temperature ?? current.temperature_2m ?? 0)}°`;
  $(`${prefix}Rain`).textContent = rain;
  $(`${prefix}Wind`).textContent = `${Math.round(current.wind_speed_10m ?? 0)} km/h`;
  $(`${prefix}WeatherCard`).classList.remove("weather-error");
}

async function loadWeather({ silent = false } = {}) {
  const label = $("weatherUpdated");
  if (!silent && label) label.textContent = "Updating…";
  try {
    await fetchWeather("ops", WEATHER_SITE);
  } catch (error) {
    console.error(error);
    $("opsCondition").textContent = "Weather temporarily unavailable";
    $("opsWeatherCard").classList.add("weather-error");
  }
  if (label) label.textContent = `Updated ${new Date().toLocaleTimeString("en-PH", { hour: "2-digit", minute: "2-digit" })}`;
}

function startWeatherAutoRefresh() {
  clearInterval(weatherTimer);
  weatherTimer = setInterval(() => {
    if (!document.hidden) loadWeather({ silent: true });
  }, 10 * 60 * 1000);
}

function startDashboardAutoRefresh() {
  clearInterval(dashboardTimer);
  dashboardTimer = setInterval(() => {
    const today = localDateKey();
    if (today !== dashboardStreamDay) {
      startDashboardRealtime({ force: true });
      return;
    }
    if (currentView === "dashboardView" && !document.hidden && !dashboardRealtimeReady) {
      loadDashboard({ silent: true });
    }
  }, 5 * 60 * 1000);
}

document.querySelectorAll(".nav-btn").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
    button.classList.add("active");
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active-view"));
    currentView = button.dataset.view;
    $(currentView).classList.add("active-view");
    if (currentView === "dashboardView") {
      renderRealtimeDashboard();
      startDashboardRealtime();
    } else loadReport();
  });
});

$("refreshBtn").addEventListener("click", () => {
  if (currentView === "dashboardView") {
    startDashboardRealtime({ force: true });
    loadWeather();
  } else {
    loadReport();
  }
});
$("reportDate").addEventListener("change", loadReport);
$("todayBtn").addEventListener("click", () => { $("reportDate").value = localDateKey(); loadReport(); });
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && currentView === "dashboardView") {
    if (localDateKey() !== dashboardStreamDay) startDashboardRealtime({ force: true });
    else renderRealtimeDashboard();
    loadWeather({ silent: true });
  }
});

$("reportDate").value = localDateKey();
startDashboardRealtime({ force: true });
loadWeather();
startDashboardAutoRefresh();
startWeatherAutoRefresh();
startLiveClock();
