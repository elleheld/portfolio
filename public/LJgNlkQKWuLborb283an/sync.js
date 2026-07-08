window.TTSync = (function () {
  "use strict";

  function enabled() {
    return !!(window.TT_CONFIG && window.TT_CONFIG.apiBase);
  }

  function headers() {
    return { "Content-Type": "application/json", "X-Auth": window.TT_CONFIG.sharedSecret };
  }

  async function req(path, options) {
    if (!enabled()) return null;
    try {
      const resp = await fetch(window.TT_CONFIG.apiBase + path, {
        ...options,
        headers: headers(),
      });
      if (!resp.ok) return null;
      return await resp.json();
    } catch {
      return null;
    }
  }

  return {
    enabled,
    getPeople: () => req("/api/people", { method: "GET" }),
    addPerson: (name) => req("/api/people", { method: "POST", body: JSON.stringify({ name }) }),
    getUserData: (who) => req(`/api/user/${encodeURIComponent(who)}`, { method: "GET" }),
    putUserData: (who, data) => req(`/api/user/${encodeURIComponent(who)}`, { method: "PUT", body: JSON.stringify(data) }),
    getActive: () => req("/api/active", { method: "GET" }),
    setActive: (who, payload) => req(`/api/active/${encodeURIComponent(who)}`, { method: "POST", body: JSON.stringify(payload) }),
    clearActive: (who) => req(`/api/active/${encodeURIComponent(who)}`, { method: "DELETE" }),
  };
})();
