(function () {
  "use strict";

  const listEl = document.getElementById("dash-list");
  const statusEl = document.getElementById("dash-status");

  let active = {};

  function formatDuration(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const h = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
    const m = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
    const s = String(totalSeconds % 60).padStart(2, "0");
    return `${h}:${m}:${s}`;
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str == null ? "" : str;
    return div.innerHTML;
  }

  function render() {
    const people = Object.keys(active).sort((a, b) => a.localeCompare(b));

    if (people.length === 0) {
      listEl.innerHTML = `<p class="empty-state">No one is currently tracking time.</p>`;
      return;
    }

    listEl.innerHTML = people
      .map((who) => {
        const t = active[who];
        const elapsed = Date.now() - new Date(t.start).getTime();
        return `
          <section class="day-card day-card-today">
            <div class="day-header">
              <div class="day-title">${escapeHtml(who)}<span class="today-badge">LIVE</span></div>
              <div class="day-header-right">
                <span class="day-total mono">${formatDuration(elapsed)}</span>
              </div>
            </div>
            <div style="font-size:14px;">
              <strong>${escapeHtml(t.company)}</strong> &middot; ${escapeHtml(t.ticket)}
              ${t.description ? `<div style="color:var(--text-dim);margin-top:4px;">${escapeHtml(t.description)}</div>` : ""}
            </div>
          </section>
        `;
      })
      .join("");
  }

  function tick() {
    if (Object.keys(active).length > 0) render();
  }

  async function poll() {
    if (!window.TTSync || !TTSync.enabled()) {
      statusEl.textContent = "Sync isn't configured yet — this dashboard has nothing to show until the tracker is connected to the backend.";
      return;
    }
    const remote = await TTSync.getActive();
    if (remote) {
      active = remote;
      statusEl.textContent = "";
      render();
    } else {
      statusEl.textContent = "Couldn't reach the sync backend — retrying…";
    }
  }

  poll();
  setInterval(poll, 4000);
  setInterval(tick, 1000);
})();
