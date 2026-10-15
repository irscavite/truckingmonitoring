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
  return date.toLocaleTimeString("en-PH", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
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

const dashboardTotals = {
  enlin: { delivery: 0, pullout: 0 },
  bacao: { delivery: 0, pullout: 0 },
};

function updateCombinedDashboard() {
  const delivery = dashboardTotals.enlin.delivery + dashboardTotals.bacao.delivery;
  const pullout = dashboardTotals.enlin.pullout + dashboardTotals.bacao.pullout;
  $("combinedDeliveryCount").textContent = delivery;
  $("combinedPulloutCount").textContent = pullout;
  $("combinedTotalTransactions").textContent = delivery + pullout;
}

function setDashboardValues(prefix, delivery, pullout) {
  $(`${prefix}DeliveryCount`).textContent = delivery;
  $(`${prefix}PulloutCount`).textContent = pullout;
  $(`${prefix}TotalTransactions`).textContent = delivery + pullout;
  dashboardTotals[prefix] = { delivery, pullout };
  updateCombinedDashboard();
}

async function loadSiteDashboard(prefix, site, today, yesterday) {
  const status = $(`${prefix}Status`);
  if (!site.baseUrl) {
    setDashboardValues(prefix, 0, 0);
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
    setDashboardValues(prefix, delivery, pullout);
    status.textContent = "Connected";
    status.className = "site-status ready";
  } catch (error) {
    console.error(error);
    setDashboardValues(prefix, 0, 0);
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
  $("asOfText").textContent = `As of ${timeOnly()}`;

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
  $(`${prefix}CompletedCount`).textContent = "—";
  $(`${prefix}OtherCount`).textContent = "—";
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
  $(`${prefix}CompletedCount`).textContent = completed.length;
  $(`${prefix}OtherCount`).textContent = other;
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

function startDashboardAutoRefresh() {
  clearInterval(dashboardTimer);
  dashboardTimer = setInterval(() => {
    if (currentView === "dashboardView" && !document.hidden) loadDashboard({ silent: true });
  }, 60000);
}

document.querySelectorAll(".nav-btn").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
    button.classList.add("active");
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active-view"));
    currentView = button.dataset.view;
    $(currentView).classList.add("active-view");
    if (currentView === "dashboardView") loadDashboard();
    else loadReport();
  });
});

$("refreshBtn").addEventListener("click", () => currentView === "dashboardView" ? loadDashboard() : loadReport());
$("reportDate").addEventListener("change", loadReport);
$("todayBtn").addEventListener("click", () => { $("reportDate").value = localDateKey(); loadReport(); });
document.addEventListener("visibilitychange", () => { if (!document.hidden && currentView === "dashboardView") loadDashboard({ silent: true }); });

$("reportDate").value = localDateKey();
loadDashboard();
startDashboardAutoRefresh();
