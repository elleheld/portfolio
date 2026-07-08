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

  // Like req(), but preserves the HTTP status instead of collapsing every
  // non-2xx to null — auth flows need to tell "wrong password" (200,
  // ok:false) apart from "name already taken" (409) apart from "network
  // is down" (null).
  async function reqStatus(path, options) {
    if (!enabled()) return null;
    try {
      const resp = await fetch(window.TT_CONFIG.apiBase + path, {
        ...options,
        headers: headers(),
      });
      let body = null;
      try {
        body = await resp.json();
      } catch {
        body = null;
      }
      return { status: resp.status, ok: resp.ok, body };
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
    getAuth: (who) => req(`/api/auth/${encodeURIComponent(who)}`, { method: "GET" }),
    registerAuth: (who, salt, hash) =>
      reqStatus(`/api/auth/${encodeURIComponent(who)}`, { method: "POST", body: JSON.stringify({ action: "register", salt, hash }) }),
    verifyAuth: (who, hash) =>
      reqStatus(`/api/auth/${encodeURIComponent(who)}`, { method: "POST", body: JSON.stringify({ action: "verify", hash }) }),
    changePassword: (who, oldHash, newSalt, newHash) =>
      reqStatus(`/api/auth/${encodeURIComponent(who)}`, { method: "POST", body: JSON.stringify({ action: "change", oldHash, newSalt, newHash }) }),
    renameIdentity: (who, newName, hash) =>
      reqStatus(`/api/auth/${encodeURIComponent(who)}`, { method: "POST", body: JSON.stringify({ action: "rename", newName, hash }) }),
  };
})();
