(function () {
  "use strict";

  const ENTRIES_KEY = "timeTracker.entries";
  const ACTIVE_KEY = "timeTracker.active";

  const form = document.getElementById("timer-form");
  const customerInput = document.getElementById("customer");
  const ticketInput = document.getElementById("ticket");
  const noteInput = document.getElementById("note");
  const customerList = document.getElementById("customer-list");

  const activeCard = document.getElementById("active-card");
  const activeCustomerEl = document.getElementById("active-customer");
  const activeTicketEl = document.getElementById("active-ticket");
  const activeNoteEl = document.getElementById("active-note");
  const activeElapsedEl = document.getElementById("active-elapsed");
  const stopBtn = document.getElementById("stop-btn");

  const dayPicker = document.getElementById("day-picker");
  const prevDayBtn = document.getElementById("prev-day");
  const nextDayBtn = document.getElementById("next-day");
  const todayBtn = document.getElementById("today-btn");

  const entriesBody = document.getElementById("entries-body");
  const emptyState = document.getElementById("empty-state");
  const summaryBody = document.getElementById("summary-body");
  const exportBtn = document.getElementById("export-btn");

  let entries = loadEntries();
  let activeTimer = loadActive();
  let selectedDate = todayStr();
  let tickHandle = null;

  function loadEntries() {
    try {
      return JSON.parse(localStorage.getItem(ENTRIES_KEY)) || [];
    } catch {
      return [];
    }
  }

  function saveEntries() {
    localStorage.setItem(ENTRIES_KEY, JSON.stringify(entries));
  }

  function loadActive() {
    try {
      return JSON.parse(localStorage.getItem(ACTIVE_KEY));
    } catch {
      return null;
    }
  }

  function saveActive() {
    if (activeTimer) {
      localStorage.setItem(ACTIVE_KEY, JSON.stringify(activeTimer));
    } else {
      localStorage.removeItem(ACTIVE_KEY);
    }
  }

  function todayStr(d = new Date()) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function dateKeyOf(isoString) {
    return todayStr(new Date(isoString));
  }

  function formatDuration(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const h = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
    const m = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
    const s = String(totalSeconds % 60).padStart(2, "0");
    return `${h}:${m}:${s}`;
  }

  function formatTime(isoString) {
    const d = new Date(isoString);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function uid() {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }

  // ---------- Timer controls ----------

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const customer = customerInput.value.trim();
    const ticket = ticketInput.value.trim();
    const note = noteInput.value.trim();
    if (!customer || !ticket) return;

    if (activeTimer) {
      stopActiveTimer();
    }

    activeTimer = {
      customer,
      ticket,
      note,
      start: new Date().toISOString(),
    };
    saveActive();
    form.reset();
    renderActive();
    startTicking();
  });

  stopBtn.addEventListener("click", () => {
    stopActiveTimer();
    renderActive();
    renderDay();
  });

  function stopActiveTimer() {
    if (!activeTimer) return;
    const end = new Date().toISOString();
    entries.push({
      id: uid(),
      customer: activeTimer.customer,
      ticket: activeTimer.ticket,
      note: activeTimer.note || "",
      start: activeTimer.start,
      end,
      duration: new Date(end) - new Date(activeTimer.start),
    });
    saveEntries();
    activeTimer = null;
    saveActive();
    stopTicking();
    refreshCustomerList();
    if (selectedDate === todayStr()) renderDay();
  }

  function renderActive() {
    if (activeTimer) {
      activeCard.hidden = false;
      activeCustomerEl.textContent = activeTimer.customer;
      activeTicketEl.textContent = activeTimer.ticket;
      activeNoteEl.textContent = activeTimer.note || "";
      activeNoteEl.style.display = activeTimer.note ? "" : "none";
      updateElapsed();
    } else {
      activeCard.hidden = true;
    }
  }

  function updateElapsed() {
    if (!activeTimer) return;
    const elapsed = Date.now() - new Date(activeTimer.start).getTime();
    activeElapsedEl.textContent = formatDuration(elapsed);
  }

  function startTicking() {
    stopTicking();
    tickHandle = setInterval(updateElapsed, 1000);
  }

  function stopTicking() {
    if (tickHandle) {
      clearInterval(tickHandle);
      tickHandle = null;
    }
  }

  // ---------- Day view ----------

  function entriesForDay(dateKey) {
    return entries
      .filter((e) => dateKeyOf(e.start) === dateKey)
      .sort((a, b) => new Date(a.start) - new Date(b.start));
  }

  function renderDay() {
    dayPicker.value = selectedDate;
    const dayEntries = entriesForDay(selectedDate);

    entriesBody.innerHTML = "";
    emptyState.hidden = dayEntries.length !== 0;

    for (const entry of dayEntries) {
      const tr = document.createElement("tr");

      tr.innerHTML = `
        <td>${escapeHtml(entry.customer)}</td>
        <td>${escapeHtml(entry.ticket)}</td>
        <td>${escapeHtml(entry.note || "")}</td>
        <td class="mono">${formatTime(entry.start)}</td>
        <td class="mono">${formatTime(entry.end)}</td>
        <td class="mono">${formatDuration(entry.duration)}</td>
        <td><button class="btn-icon" data-id="${entry.id}" title="Delete entry">&#10005;</button></td>
      `;
      entriesBody.appendChild(tr);
    }

    entriesBody.querySelectorAll("button[data-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        entries = entries.filter((e) => e.id !== btn.dataset.id);
        saveEntries();
        renderDay();
      });
    });

    renderSummary(dayEntries);
  }

  function renderSummary(dayEntries) {
    summaryBody.innerHTML = "";

    if (dayEntries.length === 0) {
      summaryBody.innerHTML = `<p class="empty-state" style="padding:0;">Nothing to summarize yet.</p>`;
      return;
    }

    const byCustomer = groupByCustomer(dayEntries);
    let grandTotal = 0;

    for (const [customer, tickets] of byCustomer) {
      const group = document.createElement("div");
      group.className = "summary-group";

      let customerTotal = 0;
      const ticketRows = [];
      for (const [ticket, ms] of tickets) {
        customerTotal += ms;
        ticketRows.push(
          `<div class="summary-ticket-row"><span>${escapeHtml(ticket)}</span><span class="ticket-time">${formatDuration(ms)}</span></div>`
        );
      }
      grandTotal += customerTotal;

      group.innerHTML = `
        <div class="summary-group-header">
          <span class="customer-name">${escapeHtml(customer)}</span>
          <span class="customer-total">${formatDuration(customerTotal)}</span>
        </div>
        <div class="summary-tickets">${ticketRows.join("")}</div>
      `;
      summaryBody.appendChild(group);
    }

    const totalEl = document.createElement("div");
    totalEl.className = "grand-total";
    totalEl.innerHTML = `<span>Total</span><span class="mono">${formatDuration(grandTotal)}</span>`;
    summaryBody.appendChild(totalEl);
  }

  function groupByCustomer(dayEntries) {
    const map = new Map();
    for (const entry of dayEntries) {
      if (!map.has(entry.customer)) map.set(entry.customer, new Map());
      const tickets = map.get(entry.customer);
      tickets.set(entry.ticket, (tickets.get(entry.ticket) || 0) + entry.duration);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // ---------- Date navigation ----------

  dayPicker.addEventListener("change", () => {
    if (dayPicker.value) {
      selectedDate = dayPicker.value;
      renderDay();
    }
  });

  prevDayBtn.addEventListener("click", () => shiftDay(-1));
  nextDayBtn.addEventListener("click", () => shiftDay(1));
  todayBtn.addEventListener("click", () => {
    selectedDate = todayStr();
    renderDay();
  });

  function shiftDay(delta) {
    const d = new Date(selectedDate + "T00:00:00");
    d.setDate(d.getDate() + delta);
    selectedDate = todayStr(d);
    renderDay();
  }

  // ---------- Customer autocomplete ----------

  function refreshCustomerList() {
    const customers = [...new Set(entries.map((e) => e.customer))].sort((a, b) =>
      a.localeCompare(b)
    );
    customerList.innerHTML = customers.map((c) => `<option value="${escapeHtml(c)}"></option>`).join("");
  }

  // ---------- CSV export ----------

  exportBtn.addEventListener("click", () => {
    const dayEntries = entriesForDay(selectedDate);
    if (dayEntries.length === 0) {
      alert("No time entries for this day yet.");
      return;
    }
    const csv = buildCsv(dayEntries);
    downloadCsv(csv, `time-report-${selectedDate}.csv`);
  });

  function buildCsv(dayEntries) {
    const rows = [["Customer", "Ticket", "Duration (H:MM:SS)", "Duration (hours)"]];
    const byCustomer = groupByCustomer(dayEntries);
    let grandTotal = 0;

    for (const [customer, tickets] of byCustomer) {
      let customerTotal = 0;
      for (const [ticket, ms] of tickets) {
        customerTotal += ms;
        rows.push([customer, ticket, formatDuration(ms), (ms / 3600000).toFixed(2)]);
      }
      grandTotal += customerTotal;
      rows.push([customer, "TOTAL", formatDuration(customerTotal), (customerTotal / 3600000).toFixed(2)]);
    }
    rows.push(["", "GRAND TOTAL", formatDuration(grandTotal), (grandTotal / 3600000).toFixed(2)]);

    return rows.map((row) => row.map(csvEscape).join(",")).join("\r\n");
  }

  function csvEscape(value) {
    const str = String(value);
    if (/[",\r\n]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
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

  // ---------- Init ----------

  refreshCustomerList();
  renderActive();
  renderDay();
  if (activeTimer) startTicking();
})();
