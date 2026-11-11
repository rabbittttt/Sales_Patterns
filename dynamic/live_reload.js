(() => {
"use strict";
const marker = document.querySelector('meta[name="sales-patterns-live-version"]');
if (!/^https?:$/.test(location.protocol) || !marker) return;

const pageVersion = marker.content;
const pollMs = 15000;
const timeoutMs = 10000;
const trialIds = ["trialBase", "trialDays", "trialFactor"];
const storageKey = "sales-patterns-live-trial:v1:" + location.pathname + location.search;
let pollTimer = null;
let controller = null;
let stopped = false;
let reloading = false;

function restoreTrial() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey) || "null");
    if (!saved || typeof saved.values !== "object") return;
    // The next published page can be newer than the status that triggered reload.
    // A pending page has no form; leave its draft for the next complete form.
    if (!trialIds.every(id => document.getElementById(id))) return;
    sessionStorage.removeItem(storageKey);
    for (const id of trialIds) {
      if (typeof saved.values?.[id] === "string") document.getElementById(id).value = saved.values[id];
    }
    const mode = [...document.querySelectorAll('input[name="trialMode"]')]
      .find(input => input.value === saved.mode);
    if (mode) {
      mode.checked = true;
      mode.dispatchEvent(new Event("change", {bubbles: true}));
    }
    for (const id of trialIds) {
      document.getElementById(id).dispatchEvent(new Event("input", {bubbles: true}));
    }
  } catch (_) { /* Storage can be disabled; the report must still work. */ }
}

function saveTrial() {
  const fields = trialIds.map(id => document.getElementById(id));
  if (fields.some(input => !input)) return;
  try {
    sessionStorage.setItem(storageKey, JSON.stringify({
      values: Object.fromEntries(fields.map(input => [input.id, input.value])),
      mode: document.querySelector('input[name="trialMode"]:checked')?.value
    }));
  } catch (_) { /* URL state remains available when storage is disabled. */ }
}

function extendFullDateWindow() {
  const params = new URLSearchParams(location.hash.slice(1));
  const metric = params.get("metric");
  const rows = window.PATTERNS_DATA?.series;
  const start = document.getElementById("dateStart")?.value;
  const end = document.getElementById("dateEnd")?.value;
  if (!metric || !Array.isArray(rows) || !start || !end) return;
  let first = "", last = "";
  for (const row of rows) {
    if (row.metric !== metric || !row.date) continue;
    const date = String(row.date).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (!first || date < first) first = date;
    if (!last || date > last) last = date;
  }
  if (start !== first || end !== last) return;
  params.delete("start");
  params.delete("end");
  // replaceState avoids triggering the current report's hash-change handler.
  const hash = params.toString();
  history.replaceState(history.state, "", location.pathname + location.search + (hash ? "#" + hash : ""));
}

function schedule() {
  clearTimeout(pollTimer);
  if (!stopped && !reloading && !document.hidden) pollTimer = setTimeout(check, pollMs);
}

async function check() {
  if (stopped || reloading || document.hidden || controller) return;
  const request = new AbortController();
  controller = request;
  const deadline = setTimeout(() => request.abort(), timeoutMs);
  try {
    const response = await fetch(new URL("api/status", location.href), {
      cache: "no-store",
      headers: {Accept: "application/json"},
      signal: request.signal
    });
    if (!response.ok) return;
    const status = await response.json();
    if (stopped || document.hidden || request.signal.aborted) return;
    if (status?.app !== "sales-patterns" || typeof status.version !== "string" ||
        !/^[a-f0-9]{64}$/i.test(status.version) || status.version === pageVersion) return;
    reloading = true;
    saveTrial();
    extendFullDateWindow();
    location.reload();
  } catch (_) { /* A failed scan/request leaves the current report usable. */ }
  finally {
    clearTimeout(deadline);
    controller = null;
    schedule();
  }
}

document.addEventListener("visibilitychange", () => {
  clearTimeout(pollTimer);
  if (document.hidden) controller?.abort();
  else check();
});
window.addEventListener("pagehide", () => {
  stopped = true;
  clearTimeout(pollTimer);
  controller?.abort();
});
window.addEventListener("pageshow", event => {
  if (event.persisted) {
    stopped = false;
    check();
  }
});
restoreTrial();
check();
})();
