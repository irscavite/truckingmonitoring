/* ENLIN only. All date/hour groupings below use Philippine time (Asia/Manila). */
const CONFIG = {
  baseUrl: "https://truckmonitoring-bffa5-default-rtdb.asia-southeast1.firebasedatabase.app",
  dailyPath: "daily_movements",
  activePath: "active_trucks",
  historyDays: 30,          // Historical IN buckets considered for OUT today.
  historyRefreshMs: 15 * 60 * 1000,
  pollMs: 2 * 60 * 1000,
  // Weather location: change latitude/longitude and label to the actual ENLIN yard.
  weather: { label: "Rosario, Cavite", latitude: 14.4151, longitude: 120.8533 },
  weatherRefreshMs: 15 * 60 * 1000,
};
const $ = (id) => document.getElementById(id);
const NS = "http://www.w3.org/2000/svg";
const phDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit" });
const phHour = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Manila", hour: "2-digit", hourCycle: "h23" });
const phDateTime = new Intl.DateTimeFormat("en-PH", {
  timeZone: "Asia/Manila", year: "numeric", month: "short", day: "numeric",
  hour: "numeric", minute: "2-digit", hour12: true,
});
const phTime = new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", hour: "numeric", minute: "2-digit", hour12: true });
const phPrettyDay = new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", weekday: "long", month: "long", day: "numeric", year: "numeric" });
const state = {
  day: "", buckets: Object.create(null), active: null, activeLoaded: false,
  loadedDays: new Set(), historyLoaded: false, historyError: false,
  lastSync: null, statusError: false, streams: [], liveStreams: new Set(),
  requestId: 0, backfillBusy: false, backfillToken: 0, lastBackfill: 0,
  delayedDayRefresh: new Set(), dayRefreshTimer: null, chartScrollInitialized: false, selectedTurnaroundBand: null,
};

function dayKey(value = Date.now()) {
  // en-CA normally formats YYYY-MM-DD; formatToParts works regardless of browser locale.
  const fields = Object.fromEntries(phDay.formatToParts(value).filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}
function hourOf(value) { return Number(phHour.format(value)); }
function shiftedDay(key, offset) {
  const [y, m, d] = key.split("-").map(Number);
  return dayKey(new Date(Date.UTC(y, m - 1, d + offset, 12)));
}
function parseTimestamp(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" || /^\d{10,13}$/.test(String(value))) {
    const v = Number(value);
    if (!Number.isFinite(v) || v <= 0) return null;
    const millis = v < 1e12 ? v * 1000 : v;
    return Number.isFinite(millis) ? millis : null;
  }
  if (typeof value !== "string") return null;
  const input = value.trim();
  if (!input) return null;
  // Local timestamps without a timezone are ENLIN/Philippine local time.
  const match = input.match(/^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)(?::(\d\d)(?:\.\d+)?)?$/);
  if (match) {
    const [, y, mo, d, h, mi, s] = match;
    const result = Date.UTC(+y, +mo - 1, +d, +h - 8, +mi, +(s || 0));
    return Number.isFinite(result) ? result : null;
  }
  const result = Date.parse(input);
  return Number.isFinite(result) ? result : null;
}
function timeIn(record) { return parseTimestamp(record?.timeInEpoch) ?? parseTimestamp(record?.timeIn); }
function timeOut(record) { return parseTimestamp(record?.timeOutEpoch) ?? parseTimestamp(record?.timeOut); }
function isPassThrough(record) {
  return record?.passThrough === true || String(record?.passThrough ?? "").toLowerCase() === "true" ||
    String(record?.movementType ?? "").toUpperCase() === "PASS THROUGH";
}
function recordsFromObject(data) {
  if (!data || typeof data !== "object") return [];
  return Object.entries(data).filter(([, value]) => value && typeof value === "object")
    .map(([id, value]) => ({ ...value, id }));
}
function activeCount(data) {
  if (!data || typeof data !== "object") return 0;
  return Object.values(data).filter((record) => {
    if (record == null || record === false) return false;
    if (typeof record !== "object") return Boolean(record);
    const status = String(record.status ?? "").toUpperCase();
    return !["CLOSED", "OUT", "EXITED", "DELETED", "CANCELLED"].includes(status) && !timeOut(record);
  }).length;
}
function firebaseUrl(path, params = {}) {
  const url = new URL(`${CONFIG.baseUrl.replace(/\/$/, "")}/${path}.json`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}
async function requestData(path, params = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(firebaseUrl(path, params), { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error(`Firebase returned HTTP ${response.status} for ${path}`);
    return await response.json();
  } finally { clearTimeout(timeout); }
}
function makeStatus(text, cls) {
  const node = $("enlinStatus");
  node.textContent = text;
  node.className = `site-status ${cls}`;
}
function storeSync() { state.lastSync = Date.now(); }
function readableCount(value) { return value == null ? "—" : value.toLocaleString("en-PH"); }
function setText(id, value) { $(id).textContent = String(value); }
function setAsOf() {
  const formatted = state.lastSync == null ? "—" : phDateTime.format(state.lastSync);
  setText("headerAsOf", `As of ${formatted}`);
  setText("dwellAsOf", `As of ${state.lastSync == null ? "—" : phTime.format(state.lastSync)}`);
  setText("turnaroundAsOf", `As of ${formatted}`);
}
function allKnownRecords() {
  const result = new Map();
  for (const [day, bucket] of Object.entries(state.buckets)) {
    if (day > state.day || !state.loadedDays.has(day)) continue;
    for (const record of recordsFromObject(bucket)) result.set(record.id, record);
  }
  return [...result.values()];
}
function summarize() {
  const todayRecords = state.loadedDays.has(state.day) ? recordsFromObject(state.buckets[state.day]) : null;
  // IN is counted by IN date, OUT independently by actual OUT date.
  // A truck arriving yesterday and leaving after midnight contributes to today's OUT only.
  const dailyRecords = (todayRecords || []).filter((r) => {
    const stamp = timeIn(r);
    return stamp == null || dayKey(stamp) === state.day;
  });
  const allRecords = allKnownRecords();
  const exitRecords = allRecords.filter((r) => {
    const stamp = timeOut(r);
    return stamp != null && dayKey(stamp) === state.day;
  });
  const inflow = Array(24).fill(0);
  const outflow = Array(24).fill(0);
  const passThroughHourly = Array(24).fill(0);
  let inToday = null, outToday = null, passThrough = null, transactionTrucks = null;
  if (todayRecords) {
    inToday = dailyRecords.length;
    passThrough = 0;
    for (const record of dailyRecords) {
      const stamp = timeIn(record);
      if (isPassThrough(record)) {
        passThrough++;
        if (stamp != null) passThroughHourly[hourOf(stamp)]++;
      }
      if (stamp != null) inflow[hourOf(stamp)]++;
    }
    transactionTrucks = inToday - passThrough;
  }
  // Today's OUT includes exits from earlier IN dates. Older buckets are fetched in background.
  if (todayRecords && state.loadedDays.has(shiftedDay(state.day, -1))) {
    outToday = exitRecords.length;
    for (const record of exitRecords) outflow[hourOf(timeOut(record))]++;
  }
  // Today's Remaining Inside is *only* the selected day's IN cohort still without an OUT.
  // Do not subtract yesterday's IN exiting today from this figure.
  const insideNow = todayRecords == null ? null : dailyRecords.filter((r) => timeOut(r) == null).length;
  const nowHour = hourOf(Date.now());
  const insideHourly = Array(24).fill(null);
  if (todayRecords) {
    let running = 0;
    const cohortOutHourly = Array(24).fill(0);
    for (const record of dailyRecords) {
      const stamp = timeOut(record);
      if (stamp != null && dayKey(stamp) === state.day) cohortOutHourly[hourOf(stamp)]++;
    }
    for (let hour = 0; hour <= nowHour; hour++) {
      running += inflow[hour] - cohortOutHourly[hour];
      insideHourly[hour] = Math.max(0, running);
    }
  }
  const durations = exitRecords.map((r) => {
    const start = timeIn(r), end = timeOut(r);
    return start == null || end == null || end < start ? null : (end - start) / 60000;
  }).filter((v) => v != null);
  const avgMinutes = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null;
  const turnaroundCounts = Array(5).fill(0);
  const turnaroundRecords = Array.from({ length: 5 }, () => []);
  for (const record of exitRecords) {
    const start = timeIn(record), end = timeOut(record);
    if (start == null || end == null || end < start) continue;
    const minutes = (end - start) / 60000;
    const group = minutes <= 10 ? 0 : minutes <= 20 ? 1 : minutes <= 40 ? 2 : minutes <= 60 ? 3 : 4;
    turnaroundCounts[group]++;
    turnaroundRecords[group].push({ record, start, end, minutes });
  }
  for (const band of turnaroundRecords) band.sort((a, b) => b.minutes - a.minutes);
  return { inToday, outToday, passThrough, transactionTrucks, insideNow, inflow, outflow, passThroughHourly, insideHourly, avgMinutes, dwellSample: durations.length, turnaroundCounts, turnaroundRecords, nowHour };
}
function formatDuration(value) {
  if (value == null) return "—";
  const total = Math.round(value);
  const hours = Math.floor(total / 60), minutes = total % 60;
  return hours ? `${hours} hr ${minutes} min` : `${minutes} min`;
}
function svgElement(name, attrs, parent, text) {
  const element = document.createElementNS(NS, name);
  Object.entries(attrs || {}).forEach(([key, value]) => element.setAttribute(key, String(value)));
  if (text != null) element.textContent = String(text);
  parent.appendChild(element);
  return element;
}
function niceMax(n) {
  if (n <= 0) return 4;
  const magnitude = 10 ** Math.floor(Math.log10(n));
  const fraction = n / magnitude;
  return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * magnitude;
}
function renderChart(stats) {
  const svg = $("hourlyChart");
  svg.replaceChildren();
  const width = 1376, height = 312, left = 56, right = 61, top = 35, bottom = 266;
  const plotWidth = width - left - right, plotHeight = bottom - top;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const usable = state.loadedDays.has(state.day);
  const flowMax = niceMax(Math.max(...stats.inflow, ...stats.outflow, ...stats.passThroughHourly));
  const occupancyMax = niceMax(Math.max(0, ...stats.insideHourly.filter((n) => n != null)));
  const yFlow = (n) => bottom - n / flowMax * plotHeight;
  const yInside = (n) => bottom - n / occupancyMax * plotHeight;

  for (let tick = 0; tick <= 4; tick++) {
    const y = top + plotHeight * tick / 4;
    svgElement("line", { x1: left, y1: y, x2: width - right, y2: y, stroke: "#e5ebf4", "stroke-width": 1 }, svg);
    svgElement("text", { x: left - 10, y: y + 4, "text-anchor": "end", fill: "#3973b8", "font-size": 10, "font-weight": 650 }, svg, Math.round(flowMax * (4 - tick) / 4));
    if (stats.insideNow != null) {
      svgElement("text", { x: width - right + 10, y: y + 4, "text-anchor": "start", fill: "#8b56dc", "font-size": 10, "font-weight": 650 }, svg, Math.round(occupancyMax * (4 - tick) / 4));
    }
  }
  svgElement("text", { x: left, y: 16, fill: "#3973b8", "font-size": 10, "font-weight": 700 }, svg, "IN / OUT / PASS THROUGH");
  svgElement("text", { x: width - right, y: 16, "text-anchor": "end", fill: "#8b56dc", "font-size": 10, "font-weight": 700 }, svg, "INSIDE");
  const groupWidth = plotWidth / 24, barWidth = 10, gap = 2;
  for (let hour = 0; hour < 24; hour++) {
    const center = left + (hour + .5) * groupWidth;
    const future = hour > stats.nowHour;
    const colors = ["#2870e7", "#11a17b", "#dc2626", "#8153e2"];
    const series = [stats.inflow[hour], stats.outflow[hour], stats.passThroughHourly[hour], stats.insideHourly[hour]];
    const names = ["Truck IN", "Truck OUT", "Pass Through", "Truck Inside"];
    series.forEach((amount, index) => {
      if (future || !usable || amount == null) return;
      const y = index === 3 ? yInside(amount) : yFlow(amount);
      const x = center - ((4 * barWidth + 3 * gap) / 2) + index * (barWidth + gap);
      const bar = svgElement("rect", { x, y: amount === 0 ? bottom - 1 : y, width: barWidth, height: Math.max(1, bottom - y), rx: 3, fill: colors[index] }, svg);
      svgElement("title", {}, bar, `${String(hour).padStart(2, "0")}:00–${String((hour + 1) % 24).padStart(2, "0")}:00 • ${names[index]}: ${amount}`);
    });
    svgElement("text", { x: center, y: bottom + 18, "text-anchor": "middle", fill: future ? "#aab8cb" : "#52667f", "font-size": 10 }, svg, `${String(hour).padStart(2,"0")}:00`);
  }
  // Decorative labels are isolated from loading and calculating truck data.
  try {
    const bars = svg.querySelectorAll("rect");
    bars.forEach((bar) => {
      const title = bar.querySelector("title")?.textContent || "";
      const match = title.match(/: ([0-9]+)$/);
      if (!match) return;
      const value = Number(match[1]);
      if (!Number.isFinite(value) || value === 0) return;
      const x = Number(bar.getAttribute("x")) + Number(bar.getAttribute("width")) / 2;
      const y = Math.max(27, Number(bar.getAttribute("y")) - 5);
      svgElement("text", {x, y, "text-anchor":"middle", "font-size":11, "font-weight":700, fill:bar.getAttribute("fill"), "pointer-events":"none"}, svg, value);
    });
  } catch (labelError) { console.warn("Graph labels could not be drawn", labelError); }
  if (!usable) svgElement("text", { x: width / 2, y: 145, "text-anchor": "middle", fill: "#72839a", "font-size": 16 }, svg, "Waiting for today's movement records…");
  if (!state.chartScrollInitialized) {
    state.chartScrollInitialized = true;
    // Keep the latest recorded hours visible on narrow screens on initial load.
    requestAnimationFrame(() => {
      const wrapper = $("chartScroll");
      if (wrapper.scrollWidth > wrapper.clientWidth) {
        wrapper.scrollLeft = Math.max(0, (stats.nowHour - 8) / 24 * wrapper.scrollWidth);
      }
    });
  }
}
function renderTurnaround(stats) {
  const ready = state.loadedDays.has(state.day);
  const total = stats.dwellSample;
  setText("turnaroundTotal", ready ? readableCount(total) : "—");
  for (let i = 0; i < 5; i++) {
    const count = stats.turnaroundCounts[i];
    const fraction = total ? count / total : 0;
    setText(`turnaroundCount${i}`, ready ? readableCount(count) : "—");
    setText(`turnaroundPct${i}`, ready ? `${(fraction * 100).toFixed(1)}%` : "—");
    const bar = $(`turnaroundBar${i}`);
    bar.style.width = `${(fraction * 100).toFixed(2)}%`;
    bar.parentElement.setAttribute("aria-label", `${count} trucks: ${total ? (fraction * 100).toFixed(1) : 0}% of completed trucks`);
  }
  const missing = stats.outToday == null ? 0 : Math.max(0, stats.outToday - total);
  for (let i = 3; i <= 4; i++) {
    const btn = $(`turnaroundDetail${i}`);
    btn.disabled = !ready;
    btn.setAttribute("aria-label", `View ${stats.turnaroundCounts[i]} completed trucks in ${i === 3 ? "41 to 60 minutes" : "over 60 minutes"} range`);
  }
  if (state.selectedTurnaroundBand !== null) updateTurnaroundDetail(stats);
  setText("turnaroundNote", !ready
    ? "Waiting for today's truck movement records…"
    : !total
      ? "No completed trucks with valid IN/OUT times recorded yet today."
      : `${readableCount(total)} measured truck${total === 1 ? "" : "s"} that exited today.${missing ? ` ${readableCount(missing)} OUT record${missing === 1 ? "" : "s"} missing valid timestamps (excluded).` : ""}`);
}
const longStayRanges = { 3: "41–60 mins", 4: "Over 60 mins" };
function firstPresent(record, keys) {
  for (const key of keys) {
    const value = record?.[key];
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return "—";
}
function updateTurnaroundDetail(stats) {
  const group = state.selectedTurnaroundBand;
  if (group == null) return;
  const rows = stats.turnaroundRecords[group];
  setText("longStayTitle", `${longStayRanges[group]} • ${rows.length} truck${rows.length === 1 ? "" : "s"}`);
  setText("longStaySubtitle", `Completed trucks that exited ${phPrettyDay.format(new Date(`${state.day}T12:00:00+08:00`))}. Sorted by longest dwell time.`);
  const body = $("longStayTableBody");
  body.replaceChildren();
  if (!rows.length) {
    const tr = document.createElement("tr"), td = document.createElement("td");
    td.colSpan = 6;
    td.className = "long-stay-empty";
    td.textContent = "No completed trucks in this time range.";
    tr.append(td); body.append(tr);
    return;
  }
  for (const { record, start, end, minutes } of rows) {
    const tr = document.createElement("tr");
    const fields = [
      firstPresent(record, ["trucking", "truckingName", "truckingCompany", "company", "trucking_company", "Trucking"]),
      firstPresent(record, ["plateNo", "plateNumber", "plate", "plate_no", "plate_number", "PlateNo"]),
      phDateTime.format(start), phDateTime.format(end), formatDuration(minutes), isPassThrough(record) ? "Yes" : "No"
    ];
    for (let i = 0; i < fields.length; i++) {
      const td = document.createElement("td"); td.textContent = fields[i];
      if (i === 1 || i === 4) td.className = "long-stay-emphasis";
      if (i === 5) td.className = isPassThrough(record) ? "long-stay-pass-yes" : "long-stay-pass-no";
      tr.append(td);
    }
    body.append(tr);
  }
}
function closeLongStay() {
  state.selectedTurnaroundBand = null;
  $("longStayModal").hidden = true;
  document.body.classList.remove("modal-open");
  $("turnaroundDetail3").focus();
}
for (const group of [3, 4]) {
  $(`turnaroundDetail${group}`).addEventListener("click", () => {
    state.selectedTurnaroundBand = group;
    updateTurnaroundDetail(summarize());
    $("longStayModal").hidden = false;
    document.body.classList.add("modal-open");
    $("longStayClose").focus();
  });
}
$("longStayClose").addEventListener("click", closeLongStay);
$("longStayModal").addEventListener("click", event => {
  if (event.target === $("longStayModal")) closeLongStay();
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && !$("longStayModal").hidden) closeLongStay();
});

function render() {
  const stats = summarize();
  setText("truckInCount", readableCount(stats.inToday));
  setText("truckOutCount", readableCount(stats.outToday));
  setText("truckInsideCount", readableCount(stats.insideNow));
  setText("passThroughCount", readableCount(stats.passThrough));
  setText("transactionTruckCount", readableCount(stats.transactionTrucks));
  setText("chartDate", phPrettyDay.format(Date.now()));
  setText("averageDwellTime", formatDuration(stats.avgMinutes));
  setText("dwellSample", stats.dwellSample
    ? `Average of ${stats.dwellSample.toLocaleString("en-PH")} completed truck${stats.dwellSample === 1 ? "" : "s"} with an OUT today`
    : "No completed IN/OUT durations available today");
  setAsOf();
  renderChart(stats);
  renderTurnaround(stats);
  setText("sourceNote", "IN / Pass Through / Transactions: IN date. OUT: actual exit date (including previous-day arrivals). Remaining Inside: only today’s IN still inside. OUT may not equal today’s IN minus Remaining.");
  setText("chartNote", "IN uses entry date; OUT uses exit date, including overnight exits. Red Pass Through is part of today’s IN. Purple shows only trucks that entered today and remained inside at each hour.");
}

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function applyStreamEvent(existing, payload, eventType) {
  const path = payload?.path ?? "/";
  const incoming = payload?.data;
  if (path === "/") {
    if (eventType === "put") return incoming && typeof incoming === "object" ? clone(incoming) : {};
    const base = existing && typeof existing === "object" ? clone(existing) : {};
    if (incoming && typeof incoming === "object") for (const [k,v] of Object.entries(incoming)) { if (v === null) delete base[k]; else base[k] = clone(v); }
    return base;
  }
  const root = existing && typeof existing === "object" ? clone(existing) : {};
  const parts = path.split("/").filter(Boolean);
  let cursor = root;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cursor[parts[i]] || typeof cursor[parts[i]] !== "object") cursor[parts[i]] = {};
    cursor = cursor[parts[i]];
  }
  const key = parts[parts.length - 1];
  if (!key) return root;
  if (incoming === null) delete cursor[key];
  else if (eventType === "patch" && incoming && typeof incoming === "object" && cursor[key] && typeof cursor[key] === "object") {
    for (const [k,v] of Object.entries(incoming)) { if (v === null) delete cursor[key][k]; else cursor[key][k] = clone(v); }
  } else cursor[key] = clone(incoming);
  return root;
}
function historicInDay(record) {
  const stamp = timeIn(record);
  if (stamp != null) return dayKey(stamp);
  const text = String(record?.dateIn ?? record?.date ?? "");
  return /^\d{4}-\d\d-\d\d/.test(text) ? text.slice(0,10) : null;
}
function considerOldExits(before, after) {
  if (!before || typeof before !== "object" || !after || typeof after !== "object") return;
  for (const [key, previous] of Object.entries(before)) {
    if (Object.hasOwn(after, key)) continue;
    const day = historicInDay(previous);
    if (day && day < shiftedDay(state.day, -1)) state.delayedDayRefresh.add(day);
  }
  if (!state.delayedDayRefresh.size) return;
  clearTimeout(state.dayRefreshTimer);
  state.dayRefreshTimer = setTimeout(async () => {
    const days = [...state.delayedDayRefresh]; state.delayedDayRefresh.clear();
    await Promise.all(days.map(async (day) => {
      try {
        const result = await requestData(`${CONFIG.dailyPath}/${day}`);
        if (state.day >= day) { state.buckets[day] = result || {}; state.loadedDays.add(day); storeSync(); }
      } catch (error) { console.warn("Couldn't refresh older exit day", day, error); }
    }));
    render();
  }, 1700);
}
function closeStreams() {
  state.streams.forEach((stream) => stream.close());
  state.streams = [];
  state.liveStreams.clear();
}
function openStream(key, path, day, requestId) {
  if (typeof EventSource === "undefined") return;
  const stream = new EventSource(firebaseUrl(path));
  const onChange = (eventType) => (event) => {
    if (requestId !== state.requestId) return;
    try {
      const payload = JSON.parse(event.data);
      if (key === "active") {
        const before = state.active;
        state.active = applyStreamEvent(before, payload, eventType);
        state.activeLoaded = true;
        considerOldExits(before, state.active);
      } else {
        state.buckets[day] = applyStreamEvent(state.buckets[day], payload, eventType);
        state.loadedDays.add(day);
      }
      storeSync(); render();
    } catch (error) { console.error("Firebase stream parse error", error); }
  };
  stream.addEventListener("put", onChange("put"));
  stream.addEventListener("patch", onChange("patch"));
  stream.onopen = () => {
    if (requestId !== state.requestId) return;
    state.liveStreams.add(key);
    makeStatus(state.statusError ? "Partial data" : "Live", state.statusError ? "pending" : "ready");
  };
  stream.onerror = () => {
    if (requestId !== state.requestId) return;
    state.liveStreams.delete(key);
    if (!state.liveStreams.size) makeStatus("Reconnecting…", "pending");
  };
  state.streams.push(stream);
}

async function backfillHistory(requestId = state.requestId) {
  if (state.backfillBusy && state.backfillToken === requestId) return;
  state.backfillBusy = true;
  state.backfillToken = requestId;
  const startKey = shiftedDay(state.day, -CONFIG.historyDays);
  try {
    // One key-range request avoids reading the entire (ever-growing) Firebase database.
    const data = await requestData(CONFIG.dailyPath, { orderBy: '"$key"', startAt: JSON.stringify(startKey), endAt: JSON.stringify(state.day) });
    if (requestId !== state.requestId) return;
    if (data && typeof data === "object") {
      for (const [day, records] of Object.entries(data)) {
        if (day >= startKey && day < shiftedDay(state.day, -1)) {
          state.buckets[day] = records || {};
          state.loadedDays.add(day);
        }
      }
    }
    state.historyLoaded = true;
    state.historyError = false;
    state.lastBackfill = Date.now();
    storeSync(); render();
  } catch (error) {
    if (requestId !== state.requestId) return;
    console.warn("Historical range query failed; trying individual date buckets", error);
    // Some RTDB rules permit a date bucket read but not a parent-level range query.
    let loaded = 0, rejected = 0;
    const dates = Array.from({ length: CONFIG.historyDays - 1 }, (_, i) => shiftedDay(state.day, -i - 2));
    for (let offset = 0; offset < dates.length; offset += 5) {
      const group = dates.slice(offset, offset + 5);
      const results = await Promise.allSettled(group.map((date) => requestData(`${CONFIG.dailyPath}/${date}`)));
      if (requestId !== state.requestId) return;
      results.forEach((result, i) => {
        if (result.status === "fulfilled") {
          state.buckets[group[i]] = result.value || {};
          state.loadedDays.add(group[i]);
          loaded++;
        } else rejected++;
      });
      // Don't issue dozens more requests when permissions reject every date.
      if (offset === 0 && rejected === group.length) break;
    }
    state.historyLoaded = loaded === dates.length;
    state.historyError = !state.historyLoaded;
    if (loaded) storeSync();
    state.lastBackfill = Date.now();
    render();
  } finally {
    if (state.backfillToken === requestId) state.backfillBusy = false;
  }
}
async function loadInitial({ manual = false } = {}) {
  const requestId = ++state.requestId;
  closeStreams();
  clearTimeout(state.dayRefreshTimer);
  state.delayedDayRefresh.clear();
  const today = dayKey(), yesterday = shiftedDay(today, -1);
  if (today !== state.day) {
    state.day = today;
    state.buckets = Object.create(null);
    state.loadedDays = new Set();
    state.historyLoaded = false;
    state.historyError = false;
    state.lastBackfill = 0;
    state.lastSync = null;
    state.chartScrollInitialized = false;
  }
  makeStatus("Syncing…", "pending");
  const button = $("refreshBtn"); button.classList.add("loading"); button.disabled = true;
  const tasks = [
    { key: "today", path: `${CONFIG.dailyPath}/${today}`, day: today },
    { key: "yesterday", path: `${CONFIG.dailyPath}/${yesterday}`, day: yesterday },
    { key: "active", path: CONFIG.activePath },
  ];
  const responses = await Promise.allSettled(tasks.map((item) => requestData(item.path)));
  if (requestId !== state.requestId) return;
  let success = 0;
  responses.forEach((result, index) => {
    const item = tasks[index];
    if (result.status === "fulfilled") {
      if (item.key === "active") { state.active = result.value || {}; state.activeLoaded = true; }
      else { state.buckets[item.day] = result.value || {}; state.loadedDays.add(item.day); }
      success++; storeSync();
    } else console.error("Firebase read failed", item.path, result.reason);
  });
  state.statusError = success !== tasks.length;
  makeStatus(success === 0 ? "Connection error" : success < tasks.length ? "Partial data" : "Connected", success === tasks.length ? "ready" : success ? "pending" : "error");
  button.classList.remove("loading"); button.disabled = false;
  // Always explain the failed reads: a graph drawing error must never be called a connection error.
  const failedReads = responses.map((result, i) => result.status === "rejected"
    ? `${tasks[i].key}: ${result.reason?.name === "AbortError" ? "request timed out" : (result.reason?.message || "network request failed")}` : null).filter(Boolean);
  try { render(); } catch (renderError) {
    console.error("Dashboard render failed (Firebase responses already received):", renderError);
    const note = $("sourceNote");
    if (note) note.textContent = `Dashboard rendering error: ${renderError.message}. Firebase access may still be working.`;
  }
  if (failedReads.length) {
    const note = $("sourceNote");
    if (note) note.textContent = `Firebase reads failed — ${failedReads.join(" | ")}. Check browser Console and database access.`;
  }
  tasks.forEach((item) => openStream(item.key, item.path, item.day, requestId));
  // Old IN buckets are backfilled in the background so the first three counters can appear quickly.
  if (manual || !state.historyLoaded || Date.now() - state.lastBackfill > CONFIG.historyRefreshMs) backfillHistory(requestId);
}
async function pollRecent() {
  if (document.hidden) return;
  const today = dayKey();
  if (today !== state.day) { await loadInitial(); return; }
  // EventSource provides live updates; polling also handles browsers that cannot keep a stream open.
  if (state.liveStreams.size !== 3) { await loadInitial(); return; }
  if (!state.backfillBusy && Date.now() - state.lastBackfill > CONFIG.historyRefreshMs) backfillHistory();
}
$("refreshBtn").addEventListener("click", () => loadInitial({ manual: true }));
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    if (dayKey() !== state.day || state.liveStreams.size !== 3) loadInitial();
    else if (Date.now() - state.lastBackfill > CONFIG.historyRefreshMs) backfillHistory();
  }
});
setInterval(pollRecent, CONFIG.pollMs);
loadInitial();


// Clock updates independently from Firebase refresh and always uses Manila timezone.
const liveClockFormatter = new Intl.DateTimeFormat("en-PH", {
  timeZone: "Asia/Manila", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true,
});
function tickLiveClock() {
  const now = new Date();
  setText("runningClock", liveClockFormatter.format(now));
  setText("runningDate", phPrettyDay.format(now));
}
tickLiveClock();
setInterval(tickLiveClock, 1000);

// Free Open-Meteo current conditions: no Firebase reads/writes and no API key.
// WMO codes: https://open-meteo.com/en/docs
function weatherDescription(code) {
  if (code === 0) return ["Clear sky", "☀"];
  if ([1, 2].includes(code)) return ["Partly cloudy", "🌤"];
  if (code === 3) return ["Cloudy", "☁"];
  if ([45, 48].includes(code)) return ["Foggy", "🌫"];
  if ([51, 53, 55, 56, 57].includes(code)) return ["Drizzle", "🌦"];
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return ["Rainy", "🌧"];
  if ([71, 73, 75, 77, 85, 86].includes(code)) return ["Snow", "❄"];
  if ([95, 96, 99].includes(code)) return ["Thunderstorm", "⛈"];
  return ["Weather", "🌡"];
}
async function refreshWeather() {
  const weather = CONFIG.weather;
  setText("weatherLocation", weather.label.toUpperCase());
  const endpoint = new URL("https://api.open-meteo.com/v1/forecast");
  endpoint.searchParams.set("latitude", weather.latitude);
  endpoint.searchParams.set("longitude", weather.longitude);
  endpoint.searchParams.set("current", "temperature_2m,relative_humidity_2m,weather_code");
  endpoint.searchParams.set("timezone", "Asia/Manila");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(endpoint, { signal: controller.signal, cache: "no-store" });
    if (!response.ok) throw new Error(`Weather HTTP ${response.status}`);
    const { current } = await response.json();
    if (!current || !Number.isFinite(current.temperature_2m)) throw new Error("Weather data missing");
    const [condition, icon] = weatherDescription(current.weather_code);
    setText("weatherIcon", icon);
    setText("weatherValue", `${Math.round(current.temperature_2m)}°C · ${condition}`);
    setText("weatherUpdated", `Humidity ${current.relative_humidity_2m ?? "—"}% · Updated ${phTime.format(new Date())}`);
  } catch (err) {
    console.warn("Weather unavailable:", err);
    setText("weatherIcon", "☁");
    setText("weatherValue", "Weather unavailable");
    setText("weatherUpdated", "Will retry automatically");
  } finally {
    clearTimeout(timeout);
  }
}
refreshWeather();
setInterval(() => { if (!document.hidden) refreshWeather(); }, CONFIG.weatherRefreshMs);
document.addEventListener("visibilitychange", () => { if (!document.hidden) { tickLiveClock(); refreshWeather(); } });


// Enlin utilization is independent of Truck Monitoring reads and rendering.
// Same source and computation as YardActivityReport-yardactivity6:
// each inventory record whose normalized Location is CEZ-2 or CEZ-2-* counts
// as one occupied empty-container slot. Capacity = 1,100.
const YARD_UTILIZATION = {
  firebase: "https://yardactivity6-default-rtdb.asia-southeast1.firebasedatabase.app",
  capacity: 1100,
  refreshMs: 2 * 60 * 1000,
  paths: [
    "irsDailyData/Latest/Inventory/Records", "Latest/Inventory/Records",
    "irsDailyData/Latest/Inventory/records", "Latest/Inventory/records",
    "irsDailyData/latest/Inventory/Records", "latest/Inventory/Records",
    "irsDailyData/Latest/inventory/records", "Latest/inventory/records",
    "irsDailyData/latest/inventory/records", "latest/inventory/records"
  ]
};
let yardUtilizationRequest = null;
function normalizeYardLocation(value) {
  return String(value ?? "").trim().toUpperCase().replace(/[_\s]+/g, "-").replace(/-+/g, "-");
}
function yardInventoryLocation(row) {
  const direct = [row?.location, row?.Location, row?.yardLocation, row?.YardLocation]
    .find(v => v !== undefined && v !== null && String(v).trim() !== "");
  const fallback = Object.entries(row || {}).find(([k, v]) =>
    /location|yard|site/i.test(k) && v !== undefined && v !== null && typeof v !== "object" && String(v).trim() !== "");
  return normalizeYardLocation(direct ?? fallback?.[1]);
}
async function fetchYardInventory(path, signal) {
  const response = await fetch(`${YARD_UTILIZATION.firebase}/${path}.json`, { cache: "no-store", signal });
  if (!response.ok) throw new Error(`YardActivity6 HTTP ${response.status}`);
  return response.json();
}
async function refreshEnlinUtilization() {
  if (yardUtilizationRequest) return;
  const controller = new AbortController();
  yardUtilizationRequest = controller;
  const timeout = setTimeout(() => controller.abort(), 20000);
  const status = $("enlinUtilizationAsOf");
  try {
    let records = null;
    for (const path of YARD_UTILIZATION.paths) {
      try {
        const response = await fetchYardInventory(path, controller.signal);
        if (response && typeof response === "object") { records = response; break; }
      } catch (err) {
        if (controller.signal.aborted) throw err;
      }
    }
    if (!records) throw new Error("Inventory records unavailable");
    const rows = Object.values(records).filter(row => row && typeof row === "object" && !Array.isArray(row));
    const occupied = rows.reduce((n, row) => {
      const loc = yardInventoryLocation(row);
      return n + Number(loc === "CEZ-2" || loc.startsWith("CEZ-2-"));
    }, 0);
    const percent = occupied / YARD_UTILIZATION.capacity * 100;
    $("enlinUtilizationPct").textContent = `${percent.toFixed(2)}%`;
    $("enlinUtilizationCount").textContent = `${occupied.toLocaleString("en-PH")} occupied`;
    $("enlinUtilizationBar").style.width = `${Math.min(100, percent)}%`;
    status.textContent = `As of ${phDateTime.format(Date.now())} • YardActivity6`;
  } catch (err) {
    console.warn("Separate Enlin utilization fetch failed:", err);
    status.textContent = "Yard utilization unavailable • retrying";
    if ($("enlinUtilizationPct").textContent === "—")
      $("enlinUtilizationCount").textContent = "Unable to load inventory";
  } finally {
    clearTimeout(timeout);
    yardUtilizationRequest = null;
  }
}
refreshEnlinUtilization();
setInterval(() => { if (!document.hidden) refreshEnlinUtilization(); }, YARD_UTILIZATION.refreshMs);
$("refreshBtn").addEventListener("click", refreshEnlinUtilization);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshEnlinUtilization(); });
