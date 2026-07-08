window.addEventListener("error", (e) => {
  const days = document.getElementById("days");
  if (days) {
    days.innerHTML = `<div style="color:#ff6b7a;padding:16px;border:1px solid #ff6b7a;border-radius:8px;">
      Something broke: ${String(e.message || e.error).replace(/</g, "&lt;")}.<br>
      Try a hard refresh (Ctrl/Cmd+Shift+R) to clear a stale cached copy of this page.
    </div>`;
  }
});

(function () {
  "use strict";

  const ENTRIES_KEY = "timeTracker.entries.v2";
  const SESSIONS_KEY = "timeTracker.sessions.v2";
  const ACTIVE_KEY = "timeTracker.active.v2";
  const COMPANIES_KEY = "timeTracker.companies.v2";
  const LAST_STOPPED_KEY = "timeTracker.lastStopped.v2";
  const LEGACY_ENTRIES_KEY = "timeTracker.entries";
  const WHO_KEY = "timeTracker.who";
  const PEOPLE_CACHE_KEY = "timeTracker.people";

  const GAP_THRESHOLD_MS = 60 * 1000;
  const TIMELINE_ROUND_MS = 15 * 60 * 1000;
  const TIMELINE_MIN_WINDOW_MS = 60 * 60 * 1000;
  const WRAP_COMPANY = "Wrap";
  const PBKDF2_ITERATIONS = 100000;

  // dataviz categorical palette (dark-mode steps), red reserved for the
  // "missing time" status so it never doubles as a company color.
  const CATEGORICAL_COLORS = ["#3987e5", "#199e70", "#c98500", "#008300", "#9085e9", "#d55181", "#d95926"];
  const CRITICAL_COLOR = "#d03b3b";

  const daysEl = document.getElementById("days");
  const weekLabelEl = document.getElementById("week-label");
  const prevWeekBtn = document.getElementById("prev-week");
  const nextWeekBtn = document.getElementById("next-week");
  const thisWeekBtn = document.getElementById("this-week");
  const companyListEl = document.getElementById("company-list");

  const boltSection = document.getElementById("bolt-section");
  const boltIcon = document.getElementById("bolt-icon");
  const boltLabel = document.getElementById("bolt-label");
  const boltElapsed = document.getElementById("bolt-elapsed");
  const boltStopBtn = document.getElementById("bolt-stop");
  const boltResumeBtn = document.getElementById("bolt-resume");

  const timeModalBackdrop = document.getElementById("time-modal-backdrop");
  const timeModalStart = document.getElementById("time-modal-start");
  const timeModalEnd = document.getElementById("time-modal-end");
  const timeModalCancel = document.getElementById("time-modal-cancel");
  const timeModalSave = document.getElementById("time-modal-save");

  const tooltipEl = document.getElementById("viz-tooltip");
  const whoDisplay = document.getElementById("who-display");
  const switchWhoBtn = document.getElementById("switch-who-btn");
  const peopleListEl = document.getElementById("people-list");
  const syncStatusEl = document.getElementById("sync-status");

  const gateEl = document.getElementById("identity-gate");
  const gateStepName = document.getElementById("gate-step-name");
  const gateNameInput = document.getElementById("gate-name-input");
  const gateNameError = document.getElementById("gate-name-error");
  const gateStepPassword = document.getElementById("gate-step-password");
  const gatePasswordContext = document.getElementById("gate-password-context");
  const gatePasswordInput = document.getElementById("gate-password-input");
  const gateConfirmField = document.getElementById("gate-confirm-field");
  const gatePasswordConfirm = document.getElementById("gate-password-confirm");
  const gatePasswordError = document.getElementById("gate-password-error");
  const gateBackBtn = document.getElementById("gate-back-btn");

  let who = (localStorage.getItem(WHO_KEY) || "").trim();
  let entries, sessions, companies, activeTimer, lastStopped;
  let knownPeople = loadJson(PEOPLE_CACHE_KEY, []);

  let weekStart = mondayOf(todayStr());
  let tickHandle = null;
  let syncPushTimer = null;
  const draftByDate = {};
  const companyColorMap = new Map();
  const expandedEntries = new Set();
  let modalContext = null; // { type: 'entry', id } | { type: 'draft', date } | { type: 'session', id }

  // ---------- storage helpers ----------

  function loadJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  function keyForWho(base, w) {
    return w ? `${base}::${w.toLowerCase()}` : base;
  }

  function keyFor(base) {
    return keyForWho(base, who);
  }

  function saveEntries() {
    localStorage.setItem(keyFor(ENTRIES_KEY), JSON.stringify(entries));
    scheduleSyncPush();
  }

  function saveSessions() {
    localStorage.setItem(keyFor(SESSIONS_KEY), JSON.stringify(sessions));
    scheduleSyncPush();
  }

  function saveCompanies() {
    localStorage.setItem(keyFor(COMPANIES_KEY), JSON.stringify(companies));
    scheduleSyncPush();
  }

  function saveActive() {
    if (activeTimer) {
      localStorage.setItem(keyFor(ACTIVE_KEY), JSON.stringify(activeTimer));
    } else {
      localStorage.removeItem(keyFor(ACTIVE_KEY));
    }
  }

  function saveLastStopped() {
    if (lastStopped) {
      localStorage.setItem(keyFor(LAST_STOPPED_KEY), JSON.stringify(lastStopped));
    } else {
      localStorage.removeItem(keyFor(LAST_STOPPED_KEY));
    }
    scheduleSyncPush();
  }

  function migrateLegacyEntries() {
    const legacy = loadJson(LEGACY_ENTRIES_KEY, []);
    if (!Array.isArray(legacy) || legacy.length === 0) return [];
    return legacy.map((e) => ({
      id: e.id || uid(),
      date: dateKeyOf(e.start),
      company: e.customer || "",
      ticket: e.ticket || "",
      description: e.note || "",
      totalMs: e.duration || 0,
      carryOver: false,
      carried: true,
    }));
  }

  // the very first time a named identity is used on this browser, adopt
  // whatever anonymous/base-bucket data already exists here so nothing
  // already logged is lost.
  function migrateBaseToWhoIfNeeded(newWho) {
    if (!newWho) return;
    if (localStorage.getItem(keyForWho(ENTRIES_KEY, newWho)) !== null) return;
    if (localStorage.getItem(ENTRIES_KEY) === null) return;
    [ENTRIES_KEY, SESSIONS_KEY, COMPANIES_KEY, ACTIVE_KEY, LAST_STOPPED_KEY].forEach((base) => {
      const raw = localStorage.getItem(base);
      if (raw !== null) localStorage.setItem(keyForWho(base, newWho), raw);
    });
  }

  function loadStateForWho() {
    entries = loadJson(keyFor(ENTRIES_KEY), null);
    sessions = loadJson(keyFor(SESSIONS_KEY), []);
    companies = loadJson(keyFor(COMPANIES_KEY), []);
    activeTimer = loadJson(keyFor(ACTIVE_KEY), null);
    lastStopped = loadJson(keyFor(LAST_STOPPED_KEY), null);

    if (entries === null) {
      entries = who ? [] : migrateLegacyEntries();
      saveEntries();
    }

    if (companies.length === 0 && entries.length > 0) {
      companies = [...new Set(entries.map((e) => e.company).filter(Boolean))].sort((a, b) => a.localeCompare(b));
      saveCompanies();
    }
  }

  // ---------- identity (who) + sync ----------

  function setSyncStatus(text) {
    syncStatusEl.textContent = text;
  }

  function renderPeopleList() {
    peopleListEl.innerHTML = knownPeople.map((p) => `<option value="${escapeHtml(p)}"></option>`).join("");
  }

  function registerPerson(name) {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (!knownPeople.some((p) => p.toLowerCase() === trimmed.toLowerCase())) {
      knownPeople.push(trimmed);
      knownPeople.sort((a, b) => a.localeCompare(b));
      localStorage.setItem(PEOPLE_CACHE_KEY, JSON.stringify(knownPeople));
      renderPeopleList();
    }
    if (window.TTSync && TTSync.enabled()) TTSync.addPerson(trimmed);
  }

  async function refreshRemotePeople() {
    if (!window.TTSync || !TTSync.enabled()) return;
    const remote = await TTSync.getPeople();
    if (remote) {
      knownPeople = remote;
      localStorage.setItem(PEOPLE_CACHE_KEY, JSON.stringify(knownPeople));
      renderPeopleList();
    }
  }

  function scheduleSyncPush() {
    if (!who || !window.TTSync || !TTSync.enabled()) return;
    setSyncStatus("Syncing…");
    clearTimeout(syncPushTimer);
    syncPushTimer = setTimeout(async () => {
      const ok = await TTSync.putUserData(who, { entries, sessions, companies, lastStopped });
      setSyncStatus(ok ? "Synced" : "Offline (saved locally)");
    }, 800);
  }

  async function syncPullAndReconcile() {
    if (!window.TTSync || !TTSync.enabled()) {
      setSyncStatus("Local only");
      return;
    }
    if (!who) {
      setSyncStatus("");
      return;
    }
    setSyncStatus("Syncing…");
    const remote = await TTSync.getUserData(who);
    if (remote) {
      entries = remote.entries || [];
      sessions = remote.sessions || [];
      companies = remote.companies || [];
      lastStopped = remote.lastStopped || null;
      saveEntries();
      saveSessions();
      saveCompanies();
      saveLastStopped();
      materializeWrapEntries();
      materializeCarryOvers();
      renderCompanyList();
      renderAll();
      setSyncStatus("Synced");
    } else {
      setSyncStatus("Offline (using local copy)");
    }
  }

  // ---------- identity gate (name + password) ----------

  function randomHex(byteLen) {
    const arr = new Uint8Array(byteLen);
    crypto.getRandomValues(arr);
    return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  function hexToBytes(hex) {
    return new Uint8Array(hex.match(/.{2}/g).map((h) => parseInt(h, 16)));
  }

  async function pbkdf2Hex(password, saltHex) {
    const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt: hexToBytes(saltHex), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
      keyMaterial,
      256
    );
    return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  let gatePendingName = "";
  let gatePendingIsNew = false;
  let gatePendingSalt = "";

  function showGate(dismissable) {
    gateEl.hidden = false;
    gateEl.dataset.dismissable = dismissable ? "1" : "";
    gateStepName.hidden = false;
    gateStepPassword.hidden = true;
    gateNameError.hidden = true;
    gateNameInput.value = "";
    gateNameInput.focus();
  }

  function hideGate() {
    gateEl.hidden = true;
  }

  gateEl.addEventListener("click", (e) => {
    if (e.target === gateEl && gateEl.dataset.dismissable === "1" && who) hideGate();
  });

  switchWhoBtn.addEventListener("click", () => showGate(true));

  gateStepName.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = gateNameInput.value.trim();
    gateNameError.hidden = true;
    if (!name) {
      gateNameError.textContent = "Enter a name.";
      gateNameError.hidden = false;
      return;
    }

    if (!window.TTSync || !TTSync.enabled()) {
      // no backend to check a password against — proceed local-only
      completeIdentity(name);
      return;
    }

    gatePendingName = name;
    const authInfo = await TTSync.getAuth(name);
    gatePasswordError.hidden = true;
    gatePasswordInput.value = "";
    gatePasswordConfirm.value = "";

    if (authInfo && authInfo.exists) {
      gatePendingIsNew = false;
      gatePendingSalt = authInfo.salt;
      gatePasswordContext.textContent = `Enter the password for "${name}".`;
      gateConfirmField.hidden = true;
    } else {
      gatePendingIsNew = true;
      gatePendingSalt = randomHex(16);
      gatePasswordContext.textContent = `"${name}" is a new name — set a password for it.`;
      gateConfirmField.hidden = false;
    }

    gateStepName.hidden = true;
    gateStepPassword.hidden = false;
    gatePasswordInput.focus();
  });

  gateBackBtn.addEventListener("click", () => {
    gateStepPassword.hidden = true;
    gateStepName.hidden = false;
    gateNameInput.focus();
  });

  gateStepPassword.addEventListener("submit", async (e) => {
    e.preventDefault();
    const password = gatePasswordInput.value;
    gatePasswordError.hidden = true;

    if (!password) {
      gatePasswordError.textContent = "Enter a password.";
      gatePasswordError.hidden = false;
      return;
    }
    if (gatePendingIsNew && password !== gatePasswordConfirm.value) {
      gatePasswordError.textContent = "Passwords don't match.";
      gatePasswordError.hidden = false;
      return;
    }

    const hash = await pbkdf2Hex(password, gatePendingSalt);

    if (gatePendingIsNew) {
      const result = await TTSync.registerAuth(gatePendingName, gatePendingSalt, hash);
      if (!result) {
        gatePasswordError.textContent = "Couldn't reach the server — try again.";
        gatePasswordError.hidden = false;
        return;
      }
      if (result.status === 409) {
        gatePasswordError.textContent = "Someone just took that name — go back and try another, or sign in if it's you.";
        gatePasswordError.hidden = false;
        return;
      }
      if (!result.ok) {
        gatePasswordError.textContent = "Something went wrong — try again.";
        gatePasswordError.hidden = false;
        return;
      }
    } else {
      const result = await TTSync.verifyAuth(gatePendingName, hash);
      if (!result) {
        gatePasswordError.textContent = "Couldn't reach the server — try again.";
        gatePasswordError.hidden = false;
        return;
      }
      if (!result.ok || !(result.body && result.body.ok)) {
        gatePasswordError.textContent = "Wrong password.";
        gatePasswordError.hidden = false;
        gatePasswordInput.value = "";
        gatePasswordInput.focus();
        return;
      }
    }

    completeIdentity(gatePendingName);
  });

  function completeIdentity(name) {
    stopTicking();
    migrateBaseToWhoIfNeeded(name);
    who = name;
    localStorage.setItem(WHO_KEY, who);
    whoDisplay.textContent = who;
    registerPerson(who);
    hideGate();
    bootApp();
  }

  function bootApp() {
    loadStateForWho();
    materializeWrapEntries();
    materializeCarryOvers();
    renderCompanyList();
    renderAll();
    if (activeTimer) startTicking();
    if (!window.TTSync || !TTSync.enabled()) {
      setSyncStatus("Local only");
    } else {
      syncPullAndReconcile();
    }
  }

  // ---------- date helpers ----------

  function todayStr(d = new Date()) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function parseDateStr(dateStr) {
    const [y, m, d] = dateStr.split("-").map(Number);
    return new Date(y, m - 1, d);
  }

  function dateKeyOf(isoString) {
    return todayStr(new Date(isoString));
  }

  function addDaysStr(dateStr, n) {
    const d = parseDateStr(dateStr);
    d.setDate(d.getDate() + n);
    return todayStr(d);
  }

  function mondayOf(dateStr) {
    const d = parseDateStr(dateStr);
    const day = d.getDay(); // 0 = Sun
    const offset = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + offset);
    return todayStr(d);
  }

  function formatDayLabel(dateStr) {
    const d = parseDateStr(dateStr);
    return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  }

  function formatWeekRangeLabel(start) {
    const startD = parseDateStr(start);
    const endD = parseDateStr(addDaysStr(start, 4));
    const startStr = startD.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const endStr = endD.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    return `${startStr} – ${endStr}`;
  }

  function formatDuration(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const h = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
    const m = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
    const s = String(totalSeconds % 60).padStart(2, "0");
    return `${h}:${m}:${s}`;
  }

  function formatClock(isoString) {
    return new Date(isoString).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function formatClockSec(isoString) {
    return new Date(isoString).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function uid() {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str == null ? "" : str;
    return div.innerHTML;
  }

  function timeInputToIso(dateStr, hhmm) {
    const [h, m] = hhmm.split(":").map(Number);
    const d = parseDateStr(dateStr);
    d.setHours(h, m, 0, 0);
    return d.toISOString();
  }

  function isoToTimeInput(isoString) {
    const d = new Date(isoString);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  // ---------- wrap (non-ticket time) materialization ----------

  // every day that's about to be shown in full (today, or any day that
  // already has real entries) gets exactly one Wrap row, auto-created if
  // missing, for time not attributable to a specific ticket.
  function materializeWrapEntries() {
    const today = todayStr();
    const dates = new Set([today, ...entries.map((e) => e.date)]);
    let changed = false;
    for (const date of dates) {
      if (!entries.some((e) => e.date === date && e.isWrap)) {
        entries.push({
          id: uid(),
          date,
          company: WRAP_COMPANY,
          ticket: "—",
          description: "",
          totalMs: 0,
          carryOver: false,
          carried: true,
          isWrap: true,
        });
        changed = true;
      }
    }
    if (changed) saveEntries();
  }

  function getWrapEntry(date) {
    return entries.find((e) => e.date === date && e.isWrap);
  }

  // ---------- carry-over materialization ----------

  function materializeCarryOvers() {
    const today = todayStr();
    let changed = false;
    for (const src of entries) {
      if (src.carryOver && !src.carried && src.date < today) {
        entries.push({
          id: uid(),
          date: today,
          company: src.company,
          ticket: src.ticket,
          description: src.description,
          totalMs: 0,
          carryOver: false,
          carried: false,
        });
        src.carried = true;
        changed = true;
      }
    }
    if (changed) saveEntries();
  }

  // ---------- company autocomplete + color ----------

  function rememberCompany(company) {
    const trimmed = company.trim();
    if (!trimmed) return;
    if (!companies.some((c) => c.toLowerCase() === trimmed.toLowerCase())) {
      companies.push(trimmed);
      companies.sort((a, b) => a.localeCompare(b));
      saveCompanies();
      renderCompanyList();
    }
  }

  function renderCompanyList() {
    companyListEl.innerHTML = companies.map((c) => `<option value="${escapeHtml(c)}"></option>`).join("");
  }

  function companyColor(company) {
    const key = (company || "").trim().toLowerCase();
    if (!companyColorMap.has(key)) {
      companyColorMap.set(key, CATEGORICAL_COLORS[companyColorMap.size % CATEGORICAL_COLORS.length]);
    }
    return companyColorMap.get(key);
  }

  // ---------- entry / session mutation ----------

  function getEntry(id) {
    return entries.find((e) => e.id === id);
  }

  function createEntry(date, company, ticket, description) {
    const entry = {
      id: uid(),
      date,
      company: company.trim(),
      ticket: ticket.trim(),
      description: description.trim(),
      totalMs: 0,
      carryOver: false,
      carried: false,
    };
    entries.push(entry);
    rememberCompany(entry.company);
    saveEntries();
    return entry;
  }

  function startTimerOn(entryId, startIso) {
    if (activeTimer) stopActiveTimer();
    const entry = getEntry(entryId);
    if (!entry) return;
    activeTimer = { entryId, start: startIso || new Date().toISOString() };
    saveActive();
    if (who && window.TTSync && TTSync.enabled()) {
      TTSync.setActive(who, {
        company: entry.company,
        ticket: entry.ticket,
        description: entry.description,
        start: activeTimer.start,
      });
    }
    startTicking();
    renderAll();
  }

  function recomputeEntryTotal(entry) {
    entry.totalMs = sessions
      .filter((s) => s.entryId === entry.id)
      .reduce((sum, s) => sum + Math.max(0, new Date(s.end) - new Date(s.start)), 0);
  }

  function stopActiveTimer() {
    if (!activeTimer) return;
    const entry = getEntry(activeTimer.entryId);
    const start = activeTimer.start;
    const end = new Date().toISOString();
    if (entry) {
      sessions.push({
        id: uid(),
        entryId: entry.id,
        date: entry.date,
        company: entry.company,
        ticket: entry.ticket,
        description: entry.description,
        start,
        end,
        type: "timer",
      });
      recomputeEntryTotal(entry);
      saveEntries();
      saveSessions();
      lastStopped = { entryId: entry.id, end };
      saveLastStopped();
    }
    activeTimer = null;
    saveActive();
    if (who && window.TTSync && TTSync.enabled()) TTSync.clearActive(who);
    stopTicking();

    // Wrap automatically picks up whenever a ticket timer stops, so time
    // is never silently untracked between tickets. Stopping Wrap itself
    // doesn't re-trigger this (nothing to fill a gap after Wrap stops).
    if (entry && !entry.isWrap && entry.date === todayStr()) {
      const wrapEntry = getWrapEntry(todayStr());
      if (wrapEntry) startTimerOn(wrapEntry.id);
    }
  }

  function addManualMinutes(entryId, minutes) {
    const entry = getEntry(entryId);
    if (!entry || !minutes || minutes <= 0) return;
    const ms = minutes * 60 * 1000;
    const end = new Date();
    const start = new Date(end.getTime() - ms);
    sessions.push({
      id: uid(),
      entryId: entry.id,
      date: entry.date,
      company: entry.company,
      ticket: entry.ticket,
      description: entry.description,
      start: start.toISOString(),
      end: end.toISOString(),
      type: "manual",
    });
    recomputeEntryTotal(entry);
    saveEntries();
    saveSessions();
    renderAll();
  }

  function addRangeSession(entryId, startIso, endIso) {
    const entry = getEntry(entryId);
    if (!entry) return;
    const ms = new Date(endIso) - new Date(startIso);
    if (!(ms > 0)) {
      alert("End time must be after start time.");
      return;
    }
    sessions.push({
      id: uid(),
      entryId: entry.id,
      date: entry.date,
      company: entry.company,
      ticket: entry.ticket,
      description: entry.description,
      start: startIso,
      end: endIso,
      type: "range",
    });
    recomputeEntryTotal(entry);
    saveEntries();
    saveSessions();
    renderAll();
  }

  function deleteSession(sessionId) {
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) return;
    sessions = sessions.filter((s) => s.id !== sessionId);
    const entry = getEntry(session.entryId);
    if (entry) recomputeEntryTotal(entry);
    saveEntries();
    saveSessions();
    renderAll();
  }

  function updateSessionTimes(sessionId, startIso, endIso) {
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) return false;
    if (!(new Date(endIso) - new Date(startIso) > 0)) {
      alert("End time must be after start time.");
      return false;
    }
    session.start = startIso;
    session.end = endIso;
    const entry = getEntry(session.entryId);
    if (entry) recomputeEntryTotal(entry);
    saveEntries();
    saveSessions();
    renderAll();
    return true;
  }

  function deleteEntry(id) {
    entries = entries.filter((e) => e.id !== id);
    sessions = sessions.filter((s) => s.entryId !== id);
    if (activeTimer && activeTimer.entryId === id) {
      activeTimer = null;
      saveActive();
      if (who && window.TTSync && TTSync.enabled()) TTSync.clearActive(who);
      stopTicking();
    }
    saveEntries();
    saveSessions();
    renderAll();
  }

  // ---------- draft rows (one blank "add" row per day, today only) ----------

  function getDraft(date) {
    if (!draftByDate[date]) draftByDate[date] = { company: "", ticket: "", description: "" };
    return draftByDate[date];
  }

  function draftReady(date) {
    const d = getDraft(date);
    return d.company.trim() && d.ticket.trim();
  }

  function commitDraft(date) {
    const d = getDraft(date);
    const entry = createEntry(date, d.company, d.ticket, d.description);
    draftByDate[date] = { company: "", ticket: "", description: "" };
    return entry;
  }

  // ---------- custom time modal ----------

  function openTimeModal(context) {
    modalContext = context;

    if (context.type === "session") {
      const session = sessions.find((s) => s.id === context.id);
      if (!session) return;
      timeModalStart.value = isoToTimeInput(session.start);
      timeModalEnd.value = isoToTimeInput(session.end);
      timeModalBackdrop.hidden = false;
      timeModalStart.focus();
      return;
    }

    const now = new Date();
    const defaultEnd = isoToTimeInput(now.toISOString());
    let defaultStart;
    if (lastStopped) {
      const lastEntry = getEntry(lastStopped.entryId);
      if (lastEntry && lastEntry.date === contextDate(context)) {
        defaultStart = isoToTimeInput(lastStopped.end);
      }
    }
    if (!defaultStart) {
      defaultStart = isoToTimeInput(new Date(now.getTime() - 30 * 60 * 1000).toISOString());
    }
    timeModalStart.value = defaultStart;
    timeModalEnd.value = defaultEnd;
    timeModalBackdrop.hidden = false;
    timeModalStart.focus();
  }

  function contextDate(context) {
    if (context.type === "entry") {
      const entry = getEntry(context.id);
      return entry ? entry.date : todayStr();
    }
    if (context.type === "session") {
      const session = sessions.find((s) => s.id === context.id);
      return session ? session.date : todayStr();
    }
    return context.date;
  }

  function closeTimeModal() {
    timeModalBackdrop.hidden = true;
    modalContext = null;
  }

  timeModalCancel.addEventListener("click", closeTimeModal);
  timeModalBackdrop.addEventListener("click", (e) => {
    if (e.target === timeModalBackdrop) closeTimeModal();
  });

  timeModalSave.addEventListener("click", () => {
    if (!modalContext) return;
    const date = contextDate(modalContext);
    if (!timeModalStart.value || !timeModalEnd.value) return;
    const startIso = timeInputToIso(date, timeModalStart.value);
    const endIso = timeInputToIso(date, timeModalEnd.value);

    if (modalContext.type === "session") {
      const sessionId = modalContext.id;
      closeTimeModal();
      updateSessionTimes(sessionId, startIso, endIso);
      return;
    }

    let entryId;
    if (modalContext.type === "entry") {
      entryId = modalContext.id;
    } else {
      entryId = commitDraft(modalContext.date).id;
    }
    closeTimeModal();
    addRangeSession(entryId, startIso, endIso);
  });

  // ---------- rendering ----------

  function renderAll() {
    renderBoltSection();
    renderWeek();
  }

  function renderBoltSection() {
    if (activeTimer) {
      const entry = getEntry(activeTimer.entryId);
      if (!entry) {
        activeTimer = null;
        saveActive();
      } else {
        boltSection.classList.add("bolt-active");
        boltIcon.textContent = "⚡";
        boltLabel.textContent = `${entry.company} · ${entry.ticket}${entry.description ? " — " + entry.description : ""}`;
        boltStopBtn.hidden = false;
        boltResumeBtn.hidden = true;
        boltElapsed.hidden = false;
        updateBoltElapsed();
        return;
      }
    }

    boltSection.classList.remove("bolt-active");
    boltIcon.textContent = "⚡";
    boltElapsed.hidden = true;
    boltStopBtn.hidden = true;

    const today = todayStr();
    if (lastStopped) {
      const lastEntry = getEntry(lastStopped.entryId);
      if (lastEntry && lastEntry.date === today) {
        boltLabel.textContent = "No timer running";
        boltResumeBtn.hidden = false;
        boltResumeBtn.textContent = `Resume ${lastEntry.company} · ${lastEntry.ticket} (from ${formatClock(lastStopped.end)})`;
        return;
      }
    }

    boltLabel.textContent = "No timer running";
    boltResumeBtn.hidden = true;
  }

  function updateBoltElapsed() {
    if (!activeTimer) return;
    const elapsed = Date.now() - new Date(activeTimer.start).getTime();
    boltElapsed.textContent = formatDuration(elapsed);
  }

  boltStopBtn.addEventListener("click", () => {
    stopActiveTimer();
    renderAll();
  });

  boltResumeBtn.addEventListener("click", () => {
    if (!lastStopped) return;
    startTimerOn(lastStopped.entryId, lastStopped.end);
  });

  function startTicking() {
    stopTicking();
    tickHandle = setInterval(() => {
      updateBoltElapsed();
      updateRunningRowCell();
      updateLiveTimeline();
    }, 1000);
  }

  function stopTicking() {
    if (tickHandle) {
      clearInterval(tickHandle);
      tickHandle = null;
    }
  }

  function updateRunningRowCell() {
    if (!activeTimer) return;
    const cell = document.querySelector(`[data-time-for="${activeTimer.entryId}"]`);
    if (!cell) return;
    const entry = getEntry(activeTimer.entryId);
    if (!entry) return;
    const elapsed = Date.now() - new Date(activeTimer.start).getTime();
    cell.textContent = formatDuration(entry.totalMs + elapsed);
  }

  function updateLiveTimeline() {
    if (!activeTimer) return;
    const entry = getEntry(activeTimer.entryId);
    if (!entry) return;
    const holder = document.querySelector(`[data-timeline-for="${entry.date}"]`);
    if (!holder) return;
    holder.replaceChildren(buildTimeline(entry.date));
  }

  function weekdayDates() {
    const dates = [];
    for (let i = 0; i < 5; i++) dates.push(addDaysStr(weekStart, i));
    return dates;
  }

  function renderWeek() {
    weekLabelEl.textContent = formatWeekRangeLabel(weekStart);
    const currentMonday = mondayOf(todayStr());
    nextWeekBtn.disabled = weekStart >= currentMonday;

    daysEl.innerHTML = "";
    const today = todayStr();

    for (const date of weekdayDates()) {
      if (date > today) continue;

      const dayEntries = entries
        .filter((e) => e.date === date)
        .sort((a, b) => a.id.localeCompare(b.id));
      const isToday = date === today;

      if (dayEntries.length === 0 && !isToday) {
        daysEl.appendChild(renderPlaceholderDay(date));
      } else {
        daysEl.appendChild(renderFullDay(date, dayEntries, isToday));
      }
    }
  }

  function renderPlaceholderDay(date) {
    const div = document.createElement("div");
    div.className = "day-placeholder";
    div.innerHTML = `<span class="day-placeholder-label">${formatDayLabel(date)}</span><span class="day-placeholder-note">No entries</span>`;
    return div;
  }

  function renderFullDay(date, dayEntries, isToday) {
    const section = document.createElement("section");
    section.className = "day-card" + (isToday ? " day-card-today" : "");

    const dayTotal = dayEntries.reduce((sum, e) => sum + e.totalMs, 0);
    const wrapEntry = dayEntries.find((e) => e.isWrap);
    const ticketEntries = dayEntries.filter((e) => !e.isWrap);

    const header = document.createElement("div");
    header.className = "day-header";
    header.innerHTML = `
      <div class="day-title">${formatDayLabel(date)}${isToday ? '<span class="today-badge">Today</span>' : ""}</div>
      <div class="day-header-right">
        <span class="day-total mono">${formatDuration(dayTotal)}</span>
        <button class="btn btn-ghost btn-small" data-export-totals="${date}">Export Totals</button>
        <button class="btn btn-ghost btn-small" data-export-timeline="${date}">Export Timeline</button>
      </div>
    `;
    section.appendChild(header);

    if (wrapEntry) {
      section.appendChild(renderWrapSection(wrapEntry));
    }

    const table = document.createElement("table");
    table.className = "entries-table";
    table.innerHTML = `
      <thead>
        <tr>
          <th class="col-carry" title="Carry over to today's next open day">Carry</th>
          <th>Company</th>
          <th>Ticket</th>
          <th>Description</th>
          <th class="col-actions">Timer</th>
          <th class="col-time">Time</th>
          <th></th>
        </tr>
      </thead>
      <tbody></tbody>
    `;
    const tbody = table.querySelector("tbody");

    for (const entry of ticketEntries) {
      tbody.appendChild(renderEntryRow(entry));
      if (expandedEntries.has(entry.id)) {
        tbody.appendChild(renderSessionDetailRow(entry));
      }
    }

    if (isToday) {
      tbody.appendChild(renderDraftRow(date));
    }

    section.appendChild(table);

    const timelineWrap = document.createElement("div");
    timelineWrap.className = "timeline-wrap";
    timelineWrap.setAttribute("data-timeline-for", date);
    timelineWrap.appendChild(buildTimeline(date));
    section.appendChild(timelineWrap);

    header.querySelector(`[data-export-totals]`).addEventListener("click", () => exportTotalsCsv(date, dayEntries));
    header.querySelector(`[data-export-timeline]`).addEventListener("click", () => exportTimelineCsv(date));

    return section;
  }

  function renderWrapSection(entry) {
    const isRunning = activeTimer && activeTimer.entryId === entry.id;
    const outer = document.createElement("div");

    const div = document.createElement("div");
    div.className = "wrap-section" + (isRunning ? " row-running" : "");

    div.innerHTML = `
      <span class="wrap-icon">&#9889;</span>
      <span class="wrap-label">Wrap<small>non-ticket time</small></span>
      <input type="text" class="cell-input" placeholder="What kind of overhead? (optional)" data-field="description" value="${escapeHtml(entry.description)}" />
      <div class="action-buttons">
        <button class="btn btn-small ${isRunning ? "btn-danger" : "btn-primary"}" data-timer-toggle>${isRunning ? "Stop" : "Start"}</button>
        <button class="btn btn-ghost btn-small" data-add5>+5m</button>
        <button class="btn btn-ghost btn-small" data-addcustom>+Custom</button>
        <button class="btn btn-ghost btn-small" data-times title="Set a custom start and end time">Times</button>
      </div>
      <button class="time-toggle mono" data-toggle-sessions="${entry.id}" title="Show individual sessions">
        <span class="time-chevron">${expandedEntries.has(entry.id) ? "▾" : "▸"}</span>
        <span data-time-for="${entry.id}">${formatDuration(entry.totalMs)}</span>
      </button>
    `;

    div.querySelector(`[data-field]`).addEventListener("change", (e) => {
      entry.description = e.target.value.trim();
      saveEntries();
      if (isRunning) renderBoltSection();
    });

    div.querySelector(`[data-timer-toggle]`).addEventListener("click", () => {
      if (isRunning) {
        stopActiveTimer();
        renderAll();
      } else {
        startTimerOn(entry.id);
      }
    });

    div.querySelector(`[data-add5]`).addEventListener("click", () => addManualMinutes(entry.id, 5));

    div.querySelector(`[data-addcustom]`).addEventListener("click", () => {
      const input = window.prompt("Minutes to add:", "15");
      if (input === null) return;
      const minutes = parseFloat(input);
      if (!Number.isFinite(minutes) || minutes <= 0) return;
      addManualMinutes(entry.id, minutes);
    });

    div.querySelector(`[data-times]`).addEventListener("click", () => {
      openTimeModal({ type: "entry", id: entry.id });
    });

    div.querySelector(`[data-toggle-sessions]`).addEventListener("click", () => {
      if (expandedEntries.has(entry.id)) expandedEntries.delete(entry.id);
      else expandedEntries.add(entry.id);
      renderAll();
    });

    outer.appendChild(div);
    if (expandedEntries.has(entry.id)) {
      const detail = document.createElement("div");
      detail.className = "session-list-outer";
      detail.appendChild(renderSessionList(entry));
      outer.appendChild(detail);
    }

    return outer;
  }

  function renderEntryRow(entry) {
    const tr = document.createElement("tr");
    const isRunning = activeTimer && activeTimer.entryId === entry.id;
    if (isRunning) tr.classList.add("row-running");

    tr.innerHTML = `
      <td class="col-carry">
        <input type="checkbox" data-carry="${entry.id}" ${entry.carryOver ? "checked" : ""} />
      </td>
      <td><input type="text" class="cell-input" list="company-list" data-field="company" data-id="${entry.id}" value="${escapeHtml(entry.company)}" /></td>
      <td><input type="text" class="cell-input" data-field="ticket" data-id="${entry.id}" value="${escapeHtml(entry.ticket)}" /></td>
      <td><input type="text" class="cell-input" data-field="description" data-id="${entry.id}" value="${escapeHtml(entry.description)}" /></td>
      <td class="col-actions">
        <div class="action-buttons">
          <button class="btn btn-small ${isRunning ? "btn-danger" : "btn-primary"}" data-timer-toggle="${entry.id}">${isRunning ? "Stop" : "Start"}</button>
          <button class="btn btn-ghost btn-small" data-add5="${entry.id}">+5m</button>
          <button class="btn btn-ghost btn-small" data-addcustom="${entry.id}">+Custom</button>
          <button class="btn btn-ghost btn-small" data-times="${entry.id}" title="Set a custom start and end time">Times</button>
        </div>
      </td>
      <td class="col-time">
        <button class="time-toggle mono" data-toggle-sessions="${entry.id}" title="Show individual sessions">
          <span class="time-chevron">${expandedEntries.has(entry.id) ? "▾" : "▸"}</span>
          <span data-time-for="${entry.id}">${formatDuration(entry.totalMs)}</span>
        </button>
      </td>
      <td><button class="btn-icon" data-delete="${entry.id}" title="Delete row">&#10005;</button></td>
    `;

    tr.querySelector(`[data-carry]`).addEventListener("change", (e) => {
      entry.carryOver = e.target.checked;
      saveEntries();
    });

    tr.querySelectorAll(`[data-field]`).forEach((input) => {
      input.addEventListener("change", (e) => {
        entry[e.target.dataset.field] = e.target.value.trim();
        if (e.target.dataset.field === "company") rememberCompany(entry.company);
        saveEntries();
        if (isRunning) renderBoltSection();
      });
    });

    tr.querySelector(`[data-timer-toggle]`).addEventListener("click", () => {
      if (isRunning) {
        stopActiveTimer();
        renderAll();
      } else if (entry.totalMs > 0) {
        // this ticket already has time logged — ask whether to continue
        // that same entry or keep this run as a separate line item.
        const continueSame = window.confirm(
          `"${entry.company} · ${entry.ticket}" already has ${formatDuration(entry.totalMs)} logged today.\n\nOK — continue that entry.\nCancel — start a new, separate entry for it.`
        );
        if (continueSame) {
          startTimerOn(entry.id);
        } else {
          const dup = createEntry(entry.date, entry.company, entry.ticket, entry.description);
          startTimerOn(dup.id);
        }
      } else {
        startTimerOn(entry.id);
      }
    });

    tr.querySelector(`[data-add5]`).addEventListener("click", () => addManualMinutes(entry.id, 5));

    tr.querySelector(`[data-addcustom]`).addEventListener("click", () => {
      const input = window.prompt("Minutes to add:", "15");
      if (input === null) return;
      const minutes = parseFloat(input);
      if (!Number.isFinite(minutes) || minutes <= 0) return;
      addManualMinutes(entry.id, minutes);
    });

    tr.querySelector(`[data-times]`).addEventListener("click", () => {
      openTimeModal({ type: "entry", id: entry.id });
    });

    tr.querySelector(`[data-delete]`).addEventListener("click", () => {
      deleteEntry(entry.id);
    });

    tr.querySelector(`[data-toggle-sessions]`).addEventListener("click", () => {
      if (expandedEntries.has(entry.id)) expandedEntries.delete(entry.id);
      else expandedEntries.add(entry.id);
      renderAll();
    });

    return tr;
  }

  function renderSessionDetailRow(entry) {
    const tr = document.createElement("tr");
    tr.className = "session-detail-row";
    const td = document.createElement("td");
    td.colSpan = 7;
    td.appendChild(renderSessionList(entry));
    tr.appendChild(td);
    return tr;
  }

  function renderSessionList(entry) {
    const wrap = document.createElement("div");
    wrap.className = "session-list";

    const entrySessions = sessions.filter((s) => s.entryId === entry.id).sort((a, b) => new Date(a.start) - new Date(b.start));

    if (entrySessions.length === 0) {
      wrap.innerHTML = `<div class="session-empty">No individual sessions yet — use Start, +5m, or Times above.</div>`;
      return wrap;
    }

    entrySessions.forEach((session) => {
      const row = document.createElement("div");
      row.className = "session-row";
      row.innerHTML = `
        <input type="time" class="session-time-input" step="60" value="${isoToTimeInput(session.start)}" data-session-start="${session.id}" />
        <span class="session-sep">–</span>
        <input type="time" class="session-time-input" step="60" value="${isoToTimeInput(session.end)}" data-session-end="${session.id}" />
        <span class="session-duration mono">${formatDuration(new Date(session.end) - new Date(session.start))}</span>
        <span class="session-type">${typeLabel(session.type)}</span>
        <button class="btn-icon" data-session-delete="${session.id}" title="Delete session">&#10005;</button>
      `;

      const applyChange = () => {
        const startVal = row.querySelector(`[data-session-start]`).value;
        const endVal = row.querySelector(`[data-session-end]`).value;
        if (!startVal || !endVal) return;
        const startIso = timeInputToIso(session.date, startVal);
        const endIso = timeInputToIso(session.date, endVal);
        updateSessionTimes(session.id, startIso, endIso);
      };

      row.querySelector(`[data-session-start]`).addEventListener("change", applyChange);
      row.querySelector(`[data-session-end]`).addEventListener("change", applyChange);
      row.querySelector(`[data-session-delete]`).addEventListener("click", () => deleteSession(session.id));

      wrap.appendChild(row);
    });

    return wrap;
  }

  function renderDraftRow(date) {
    const draft = getDraft(date);
    const tr = document.createElement("tr");
    tr.className = "row-draft";

    tr.innerHTML = `
      <td class="col-carry"></td>
      <td><input type="text" class="cell-input" list="company-list" placeholder="Company code" data-draft="company" value="${escapeHtml(draft.company)}" /></td>
      <td><input type="text" class="cell-input" placeholder="Ticket #" data-draft="ticket" value="${escapeHtml(draft.ticket)}" /></td>
      <td><input type="text" class="cell-input" placeholder="What are you doing?" data-draft="description" value="${escapeHtml(draft.description)}" /></td>
      <td class="col-actions">
        <div class="action-buttons">
          <button class="btn btn-primary btn-small" data-draft-start>Start</button>
          <button class="btn btn-ghost btn-small" data-draft-add5>+5m</button>
          <button class="btn btn-ghost btn-small" data-draft-addcustom>+Custom</button>
          <button class="btn btn-ghost btn-small" data-draft-times title="Set a custom start and end time">Times</button>
        </div>
      </td>
      <td class="col-time mono">00:00:00</td>
      <td></td>
    `;

    tr.querySelectorAll(`[data-draft]`).forEach((input) => {
      input.addEventListener("input", (e) => {
        draft[e.target.dataset.draft] = e.target.value;
      });
    });

    tr.querySelector(`[data-draft-start]`).addEventListener("click", () => {
      if (!draftReady(date)) return;
      const entry = commitDraft(date);
      startTimerOn(entry.id);
    });

    tr.querySelector(`[data-draft-add5]`).addEventListener("click", () => {
      if (!draftReady(date)) return;
      const entry = commitDraft(date);
      addManualMinutes(entry.id, 5);
    });

    tr.querySelector(`[data-draft-addcustom]`).addEventListener("click", () => {
      if (!draftReady(date)) return;
      const input = window.prompt("Minutes to add:", "15");
      if (input === null) return;
      const minutes = parseFloat(input);
      if (!Number.isFinite(minutes) || minutes <= 0) return;
      const entry = commitDraft(date);
      addManualMinutes(entry.id, minutes);
    });

    tr.querySelector(`[data-draft-times]`).addEventListener("click", () => {
      if (!draftReady(date)) return;
      openTimeModal({ type: "draft", date });
    });

    return tr;
  }

  // ---------- timeline (dataviz) ----------

  function mergeIntervals(intervals) {
    const sorted = intervals.slice().sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [start, end] of sorted) {
      const last = merged[merged.length - 1];
      if (last && start <= last[1]) {
        last[1] = Math.max(last[1], end);
      } else {
        merged.push([start, end]);
      }
    }
    return merged;
  }

  function buildTimeline(date) {
    const daySessions = sessions
      .filter((s) => s.date === date)
      .slice()
      .sort((a, b) => new Date(a.start) - new Date(b.start));

    const segments = daySessions.map((s) => ({
      startMs: new Date(s.start).getTime(),
      endMs: new Date(s.end).getTime(),
      company: s.company,
      ticket: s.ticket,
      description: s.description,
      kind: "work",
    }));

    if (activeTimer) {
      const entry = getEntry(activeTimer.entryId);
      if (entry && entry.date === date) {
        segments.push({
          startMs: new Date(activeTimer.start).getTime(),
          endMs: Date.now(),
          company: entry.company,
          ticket: entry.ticket,
          description: entry.description,
          kind: "live",
        });
      }
    }

    const container = document.createElement("div");

    const heading = document.createElement("div");
    heading.className = "timeline-heading";
    heading.textContent = "Timeline";
    container.appendChild(heading);

    if (segments.length === 0) {
      const empty = document.createElement("div");
      empty.className = "timeline-empty";
      empty.textContent = "No timed sessions yet today.";
      container.appendChild(empty);
      return container;
    }

    // Round to clean 15-min boundaries and enforce a minimum span so the
    // axis doesn't rescale to fit every tiny addition — an axis that
    // stretches to match new data hides the very change it's showing
    // (a fresh 5-minute add would otherwise render at ~100% width next
    // to nothing, making it look like nothing happened).
    let windowStart = Math.floor(Math.min(...segments.map((s) => s.startMs)) / TIMELINE_ROUND_MS) * TIMELINE_ROUND_MS;
    let windowEnd = Math.ceil(Math.max(...segments.map((s) => s.endMs)) / TIMELINE_ROUND_MS) * TIMELINE_ROUND_MS;
    if (windowEnd - windowStart < TIMELINE_MIN_WINDOW_MS) {
      const pad = (TIMELINE_MIN_WINDOW_MS - (windowEnd - windowStart)) / 2;
      windowStart -= pad;
      windowEnd += pad;
    }
    const windowMs = Math.max(1, windowEnd - windowStart);

    // one skinny row per company (Wrap included), in first-appearance-safe
    // fixed order: Wrap first, then alphabetical.
    const byCompany = new Map();
    for (const seg of segments) {
      const key = seg.company.trim().toLowerCase();
      if (!byCompany.has(key)) byCompany.set(key, { name: seg.company, segs: [] });
      byCompany.get(key).segs.push(seg);
    }
    const companyRows = [...byCompany.values()].sort((a, b) => {
      if (a.name === WRAP_COMPANY) return -1;
      if (b.name === WRAP_COMPANY) return 1;
      return a.name.localeCompare(b.name);
    });

    const rowsWrap = document.createElement("div");
    rowsWrap.className = "timeline-rows";

    for (const row of companyRows) {
      const totalMs = row.segs.reduce((sum, s) => sum + (s.endMs - s.startMs), 0);
      rowsWrap.appendChild(buildTimelineRow(row.name, row.segs, windowStart, windowMs, totalMs, false));
    }

    // aggregate row: time not covered by any company/Wrap segment
    const merged = mergeIntervals(segments.map((s) => [s.startMs, s.endMs]));
    const gaps = [];
    for (let i = 0; i < merged.length - 1; i++) {
      const gapStart = merged[i][1];
      const gapEnd = merged[i + 1][0];
      if (gapEnd - gapStart >= GAP_THRESHOLD_MS) gaps.push({ startMs: gapStart, endMs: gapEnd });
    }
    if (gaps.length > 0) {
      const totalGapMs = gaps.reduce((sum, g) => sum + (g.endMs - g.startMs), 0);
      rowsWrap.appendChild(buildTimelineRow("Missing", gaps, windowStart, windowMs, totalGapMs, true));
    }

    container.appendChild(rowsWrap);

    const axis = document.createElement("div");
    axis.className = "timeline-axis";
    axis.innerHTML = `<span></span><span class="timeline-axis-labels"><span>${formatClock(new Date(windowStart).toISOString())}</span><span>${formatClock(new Date(windowEnd).toISOString())}</span></span>`;
    container.appendChild(axis);

    return container;
  }

  function buildTimelineRow(name, segs, windowStart, windowMs, totalMs, isMissingRow) {
    const row = document.createElement("div");
    row.className = "timeline-row" + (isMissingRow ? " timeline-row-missing" : "");

    const label = document.createElement("div");
    label.className = "timeline-row-label";
    label.innerHTML = `<span class="row-name">${escapeHtml(name)}</span><span class="mono">${formatDuration(totalMs)}</span>`;
    row.appendChild(label);

    const track = document.createElement("div");
    track.className = "timeline-row-track";

    segs.forEach((seg) => {
      const el = document.createElement("div");
      const leftPct = ((seg.startMs - windowStart) / windowMs) * 100;
      const widthPct = Math.max(((seg.endMs - seg.startMs) / windowMs) * 100, 0.4);
      el.className = "timeline-seg" + (seg.kind === "live" ? " timeline-seg-live" : "");
      el.style.left = `${leftPct}%`;
      el.style.width = `${widthPct}%`;
      el.style.background = isMissingRow ? CRITICAL_COLOR : companyColor(name);
      el.tabIndex = 0;

      const label2 = isMissingRow
        ? `Missing time — ${formatClock(new Date(seg.startMs).toISOString())}–${formatClock(new Date(seg.endMs).toISOString())} (${formatDuration(seg.endMs - seg.startMs)})`
        : `${name}${seg.ticket ? " · " + seg.ticket : ""}${seg.description ? " — " + seg.description : ""} — ${formatClock(new Date(seg.startMs).toISOString())}–${formatClock(new Date(seg.endMs).toISOString())} (${formatDuration(seg.endMs - seg.startMs)})`;

      el.addEventListener("mouseenter", (e) => showTooltip(label2, e.currentTarget));
      el.addEventListener("focus", (e) => showTooltip(label2, e.currentTarget));
      el.addEventListener("mouseleave", hideTooltip);
      el.addEventListener("blur", hideTooltip);

      track.appendChild(el);
    });

    row.appendChild(track);
    return row;
  }

  function showTooltip(text, target) {
    tooltipEl.textContent = text;
    tooltipEl.hidden = false;
    const rect = target.getBoundingClientRect();
    const tipRect = tooltipEl.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - tipRect.width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tipRect.width - 8));
    tooltipEl.style.left = `${left + window.scrollX}px`;
    tooltipEl.style.top = `${rect.top + window.scrollY - tipRect.height - 8}px`;
  }

  function hideTooltip() {
    tooltipEl.hidden = true;
  }

  // ---------- CSV export ----------

  function groupTotals(dayEntries) {
    const map = new Map();
    for (const e of dayEntries) {
      if (!map.has(e.company)) map.set(e.company, new Map());
      const tickets = map.get(e.company);
      tickets.set(e.ticket, (tickets.get(e.ticket) || 0) + e.totalMs);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }

  function csvEscape(value) {
    const str = String(value);
    if (/[",\r\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
    return str;
  }

  function downloadCsv(csv, filename) {
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function exportTotalsCsv(date, dayEntries) {
    if (dayEntries.length === 0) {
      alert("No entries for this day yet.");
      return;
    }
    const rows = [["Company", "Ticket", "Duration (H:MM:SS)", "Duration (hours)"]];
    const grouped = groupTotals(dayEntries);
    let grandTotal = 0;

    for (const [company, tickets] of grouped) {
      let companyTotal = 0;
      for (const [ticket, ms] of tickets) {
        companyTotal += ms;
        rows.push([company, ticket, formatDuration(ms), (ms / 3600000).toFixed(2)]);
      }
      grandTotal += companyTotal;
      rows.push([company, "TOTAL", formatDuration(companyTotal), (companyTotal / 3600000).toFixed(2)]);
    }
    rows.push(["", "GRAND TOTAL", formatDuration(grandTotal), (grandTotal / 3600000).toFixed(2)]);

    const csv = rows.map((row) => row.map(csvEscape).join(",")).join("\r\n");
    downloadCsv(csv, `time-totals-${date}.csv`);
  }

  function typeLabel(type) {
    if (type === "manual") return "manual add";
    if (type === "range") return "custom range";
    return "timer";
  }

  function exportTimelineCsv(date) {
    const daySessions = sessions
      .filter((s) => s.date === date)
      .slice()
      .sort((a, b) => new Date(a.start) - new Date(b.start));

    if (daySessions.length === 0) {
      alert("No timed sessions logged for this day yet (only entries with a Start/Stop, +time, or custom-times click show up here).");
      return;
    }

    const rows = [["Start", "End", "Duration (H:MM:SS)", "Company", "Ticket", "Description", "Type"]];
    for (const s of daySessions) {
      rows.push([
        formatClockSec(s.start),
        formatClockSec(s.end),
        formatDuration(new Date(s.end) - new Date(s.start)),
        s.company,
        s.ticket,
        s.description,
        typeLabel(s.type),
      ]);
    }

    const csv = rows.map((row) => row.map(csvEscape).join(",")).join("\r\n");
    downloadCsv(csv, `time-timeline-${date}.csv`);
  }

  // ---------- week navigation ----------

  prevWeekBtn.addEventListener("click", () => {
    weekStart = addDaysStr(weekStart, -7);
    renderWeek();
  });

  nextWeekBtn.addEventListener("click", () => {
    const currentMonday = mondayOf(todayStr());
    if (weekStart >= currentMonday) return;
    weekStart = addDaysStr(weekStart, 7);
    renderWeek();
  });

  thisWeekBtn.addEventListener("click", () => {
    weekStart = mondayOf(todayStr());
    renderWeek();
  });

  // ---------- init ----------

  renderPeopleList();
  refreshRemotePeople();

  if (who) {
    whoDisplay.textContent = who;
    hideGate();
    bootApp();
  } else {
    showGate(false);
  }
})();
