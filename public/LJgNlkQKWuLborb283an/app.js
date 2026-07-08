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
  const LEGACY_ENTRIES_KEY = "timeTracker.entries";

  const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri"];

  const daysEl = document.getElementById("days");
  const weekLabelEl = document.getElementById("week-label");
  const prevWeekBtn = document.getElementById("prev-week");
  const nextWeekBtn = document.getElementById("next-week");
  const thisWeekBtn = document.getElementById("this-week");
  const companyListEl = document.getElementById("company-list");

  const runningBanner = document.getElementById("running-banner");
  const runningLabel = document.getElementById("running-label");
  const runningElapsed = document.getElementById("running-elapsed");
  const runningStopBtn = document.getElementById("running-stop");

  let entries = loadJson(ENTRIES_KEY, null);
  let sessions = loadJson(SESSIONS_KEY, []);
  let companies = loadJson(COMPANIES_KEY, []);
  let activeTimer = loadJson(ACTIVE_KEY, null);

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

  // ---------- company autocomplete ----------

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

  function startTimerOn(entryId) {
    if (activeTimer) stopActiveTimer();
    activeTimer = { entryId, start: new Date().toISOString() };
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
      const ms = new Date(end) - new Date(start);
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

  // ---------- rendering ----------

  function renderAll() {
    renderRunningBanner();
    renderWeek();
  }

  function renderRunningBanner() {
    if (!activeTimer) {
      runningBanner.hidden = true;
      return;
    }
    const entry = getEntry(activeTimer.entryId);
    if (!entry) {
      runningBanner.hidden = true;
      return;
    }
    runningBanner.hidden = false;
    runningLabel.textContent = `${entry.company} · ${entry.ticket}${entry.description ? " — " + entry.description : ""}`;
    updateRunningElapsed();
  }

  function updateRunningElapsed() {
    if (!activeTimer) return;
    const elapsed = Date.now() - new Date(activeTimer.start).getTime();
    runningElapsed.textContent = formatDuration(elapsed);
  }

  function startTicking() {
    stopTicking();
    tickHandle = setInterval(() => {
      updateRunningElapsed();
      updateRunningRowCell();
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
        if (isRunning) renderRunningBanner();
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

    return tr;
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

  function exportTimelineCsv(date) {
    const daySessions = sessions
      .filter((s) => s.date === date)
      .slice()
      .sort((a, b) => new Date(a.start) - new Date(b.start));

    if (daySessions.length === 0) {
      alert("No timed sessions logged for this day yet (only entries with a Start/Stop or +time click show up here).");
      return;
    }

    const rows = [["Start", "End", "Duration (H:MM:SS)", "Company", "Ticket", "Description", "Type"]];
    for (const s of daySessions) {
      rows.push([
        formatClock(s.start),
        formatClock(s.end),
        formatDuration(new Date(s.end) - new Date(s.start)),
        s.company,
        s.ticket,
        s.description,
        s.type === "manual" ? "manual add" : "timer",
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

  runningStopBtn.addEventListener("click", () => {
    stopActiveTimer();
    renderAll();
  });

  // ---------- init ----------

  materializeCarryOvers();
  renderCompanyList();
  renderAll();
  if (activeTimer) startTicking();
})();
