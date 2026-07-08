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

  const GAP_THRESHOLD_MS = 60 * 1000;

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

  let entries = loadJson(ENTRIES_KEY, null);
  let sessions = loadJson(SESSIONS_KEY, []);
  let companies = loadJson(COMPANIES_KEY, []);
  let activeTimer = loadJson(ACTIVE_KEY, null);
  let lastStopped = loadJson(LAST_STOPPED_KEY, null);

  if (entries === null) {
    entries = migrateLegacyEntries();
    saveEntries();
  }

  if (companies.length === 0 && entries.length > 0) {
    companies = [...new Set(entries.map((e) => e.company).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    saveCompanies();
  }

  let weekStart = mondayOf(todayStr());
  let tickHandle = null;
  const draftByDate = {};
  const companyColorMap = new Map();
  let modalContext = null; // { type: 'entry', id } | { type: 'draft', date }

  // ---------- storage helpers ----------

  function loadJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  function saveEntries() {
    localStorage.setItem(ENTRIES_KEY, JSON.stringify(entries));
  }

  function saveSessions() {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
  }

  function saveCompanies() {
    localStorage.setItem(COMPANIES_KEY, JSON.stringify(companies));
  }

  function saveActive() {
    if (activeTimer) {
      localStorage.setItem(ACTIVE_KEY, JSON.stringify(activeTimer));
    } else {
      localStorage.removeItem(ACTIVE_KEY);
    }
  }

  function saveLastStopped() {
    if (lastStopped) {
      localStorage.setItem(LAST_STOPPED_KEY, JSON.stringify(lastStopped));
    } else {
      localStorage.removeItem(LAST_STOPPED_KEY);
    }
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
    activeTimer = { entryId, start: startIso || new Date().toISOString() };
    saveActive();
    startTicking();
    renderAll();
  }

  function stopActiveTimer() {
    if (!activeTimer) return;
    const entry = getEntry(activeTimer.entryId);
    const start = activeTimer.start;
    const end = new Date().toISOString();
    if (entry) {
      const ms = Math.max(0, new Date(end) - new Date(start));
      entry.totalMs += ms;
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
      saveEntries();
      saveSessions();
      lastStopped = { entryId: entry.id, end };
      saveLastStopped();
    }
    activeTimer = null;
    saveActive();
    stopTicking();
  }

  function addManualMinutes(entryId, minutes) {
    const entry = getEntry(entryId);
    if (!entry || !minutes || minutes <= 0) return;
    const ms = minutes * 60 * 1000;
    const end = new Date();
    const start = new Date(end.getTime() - ms);
    entry.totalMs += ms;
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
    entry.totalMs += ms;
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
    saveEntries();
    saveSessions();
    renderAll();
  }

  function deleteEntry(id) {
    entries = entries.filter((e) => e.id !== id);
    sessions = sessions.filter((s) => s.entryId !== id);
    if (activeTimer && activeTimer.entryId === id) {
      activeTimer = null;
      saveActive();
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

    for (const entry of dayEntries) {
      tbody.appendChild(renderEntryRow(entry));
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
      <td class="col-time mono" data-time-for="${entry.id}">${formatDuration(entry.totalMs)}</td>
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

    return tr;
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

    segments.sort((a, b) => a.startMs - b.startMs);

    const container = document.createElement("div");

    if (segments.length === 0) {
      container.innerHTML = `<div class="timeline-empty">No timed sessions yet today.</div>`;
      return container;
    }

    // fold in red gap segments between consecutive tracked blocks
    const withGaps = [];
    for (let i = 0; i < segments.length; i++) {
      withGaps.push(segments[i]);
      const next = segments[i + 1];
      if (next && next.startMs - segments[i].endMs >= GAP_THRESHOLD_MS) {
        withGaps.push({
          startMs: segments[i].endMs,
          endMs: next.startMs,
          kind: "gap",
        });
      }
    }

    const windowStart = withGaps[0].startMs;
    const windowEnd = withGaps[withGaps.length - 1].endMs;
    const windowMs = Math.max(1, windowEnd - windowStart);

    const heading = document.createElement("div");
    heading.className = "timeline-heading";
    heading.textContent = "Timeline";
    container.appendChild(heading);

    const bar = document.createElement("div");
    bar.className = "timeline-bar";

    withGaps.forEach((seg, i) => {
      const el = document.createElement("div");
      const widthPct = ((seg.endMs - seg.startMs) / windowMs) * 100;
      el.className = "timeline-seg" + (seg.kind === "gap" ? " timeline-seg-gap" : "") + (seg.kind === "live" ? " timeline-seg-live" : "");
      el.style.flexBasis = `${widthPct}%`;
      el.style.background = seg.kind === "gap" ? CRITICAL_COLOR : companyColor(seg.company);
      el.tabIndex = 0;

      const label =
        seg.kind === "gap"
          ? `Missing time — ${formatClock(new Date(seg.startMs).toISOString())}–${formatClock(new Date(seg.endMs).toISOString())} (${formatDuration(seg.endMs - seg.startMs)})`
          : `${seg.company} · ${seg.ticket}${seg.description ? " — " + seg.description : ""} — ${formatClock(new Date(seg.startMs).toISOString())}–${formatClock(new Date(seg.endMs).toISOString())} (${formatDuration(seg.endMs - seg.startMs)})`;

      el.addEventListener("mouseenter", (e) => showTooltip(label, e.currentTarget));
      el.addEventListener("focus", (e) => showTooltip(label, e.currentTarget));
      el.addEventListener("mouseleave", hideTooltip);
      el.addEventListener("blur", hideTooltip);

      bar.appendChild(el);
    });

    container.appendChild(bar);

    const axis = document.createElement("div");
    axis.className = "timeline-axis";
    axis.innerHTML = `<span>${formatClock(new Date(windowStart).toISOString())}</span><span>${formatClock(new Date(windowEnd).toISOString())}</span>`;
    container.appendChild(axis);

    const companiesInDay = [...new Set(segments.filter((s) => s.kind !== "gap").map((s) => s.company))];
    const hasGap = withGaps.some((s) => s.kind === "gap");
    if (companiesInDay.length > 0) {
      const legend = document.createElement("div");
      legend.className = "timeline-legend";
      legend.innerHTML =
        companiesInDay
          .map((c) => `<span class="legend-item"><span class="legend-swatch" style="background:${companyColor(c)}"></span>${escapeHtml(c)}</span>`)
          .join("") +
        (hasGap ? `<span class="legend-item"><span class="legend-swatch" style="background:${CRITICAL_COLOR}"></span>Missing time</span>` : "");
      container.appendChild(legend);
    }

    return container;
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

  materializeCarryOvers();
  renderCompanyList();
  renderAll();
  if (activeTimer) startTicking();
})();
