// Shared config for the time tracker + dashboard.
// The API base is set once the Worker is deployed (see worker/README.md).
// SHARED_SECRET only deters casual/bot traffic to the Worker — it's plain
// text in this file, so it is not real access control. Don't put anything
// sensitive behind it.
window.TT_CONFIG = {
  apiBase: "", // e.g. "https://elles-timetracker.<subdomain>.workers.dev" — empty = sync disabled, local-only
  sharedSecret: "vc1QzQ1begwg6kePGR93tAvGdHaZEySd",
};
