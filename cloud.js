/* Can Vault cloud module: accounts, sync and leaderboard (Supabase REST, no library). */
(function () {
  "use strict";
  var C = window.CV_CONFIG || {};
  var BASE = String(C.supabaseUrl || "").replace(/\/+$/, "");
  var KEY = String(C.supabaseAnonKey || "");
  var ON = !!(BASE && KEY);
  var LOCAL = ["theme", "photos", "view", "pass", "lastBackup", "seen", "cloudAt", "cloudIds", "cloudUser", "del", "name"];
  var el = function (id) { return document.getElementById(id); };
  var dnum = function (s) { var p = String(s || "").split("-").map(Number); return p.length === 3 && p.every(function (n) { return n > 0; }) ? p[0] * 10000 + p[1] * 100 + p[2] : 0; };
  var sess = null, busy = false, timer = null, lastSync = 0, pendingEmail = "", lbOpen = false;
  try { sess = JSON.parse(localStorage.getItem("cv_sess") || "null"); } catch (e) {}

  function setSess(s) { sess = s; try { if (s) localStorage.setItem("cv_sess", JSON.stringify(s)); else localStorage.removeItem("cv_sess"); } catch (e) {} }
  function jwt(t) { try { return JSON.parse(atob(String(t).split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); } catch (e) { return {}; } }
  function uid() { return sess ? jwt(sess.access_token).sub : null; }
  function mail() { return sess ? (jwt(sess.access_token).email || "") : ""; }
  function msg(t) { var m = el("acMsg"); if (m) m.textContent = t || ""; }
  function isDirty() { try { return localStorage.getItem("cv_dirty") === "1"; } catch (e) { return false; } }
  function setDirty(v) { try { if (v) localStorage.setItem("cv_dirty", "1"); else localStorage.removeItem("cv_dirty"); } catch (e) {} }

  async function api(path, o) {
    o = o || {};
    var h = { apikey: KEY, "Content-Type": "application/json" };
    if (o.token) h.Authorization = "Bearer " + o.token;
    if (o.headers) Object.keys(o.headers).forEach(function (k) { h[k] = o.headers[k]; });
    var r = await fetch(BASE + path, { method: o.method || "GET", headers: h, body: o.body ? JSON.stringify(o.body) : undefined });
    var t = await r.text(), j = null;
    try { j = t ? JSON.parse(t) : null; } catch (e) {}
    if (!r.ok) throw new Error((j && (j.msg || j.message || j.error_description || j.error)) || "HTTP " + r.status);
    return j;
  }
  function fromTokens(j) { return { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + (+j.expires_in || 3600) * 1000 }; }
  async function token() {
    if (!sess) return null;
    if (sess.expires_at - Date.now() < 60000) {
      try {
        var j = await api("/auth/v1/token?grant_type=refresh_token", { method: "POST", body: { refresh_token: sess.refresh_token } });
        setSess(fromTokens(j));
      } catch (e) {
        if (!(e instanceof TypeError)) { setSess(null); ui(); }
        return null;
      }
    }
    return sess && sess.access_token;
  }

  /* ---- merging ---- */
  function mergeVal(a, b) {
    if (a == null) return b;
    if (b == null) return a;
    if (typeof a === "number" && typeof b === "number") return Math.max(a, b);
    if (Array.isArray(a) && Array.isArray(b)) {
      var objs = a.concat(b).some(function (x) { return x && typeof x === "object"; });
      if (objs) {
        var m = new Map();
        b.concat(a).forEach(function (x) { if (x && x.d) m.set(x.d, x); });
        return Array.from(m.values()).sort(function (x, y) { return dnum(x.d) - dnum(y.d); }).slice(-180);
      }
      return Array.from(new Set(b.concat(a))).slice(-2000);
    }
    if (typeof a === "object" && typeof b === "object") {
      if (typeof a.d === "string" && typeof b.d === "string" && a.d !== b.d) return dnum(a.d) >= dnum(b.d) ? a : b;
      var o = {}, k;
      for (k in b) o[k] = b[k];
      for (k in a) o[k] = mergeVal(a[k], b[k]);
      return o;
    }
    return a;
  }
  function localSettings() { var o = {}; Object.keys(S).forEach(function (k) { if (LOCAL.indexOf(k) < 0) o[k] = S[k]; }); return JSON.parse(JSON.stringify(o)); }
  function mergeSettings(ls, rs) {
    var m = mergeVal(ls, rs || {});
    if (rs && dnum(rs.lastDay) > dnum(ls.lastDay)) { m.lastDay = rs.lastDay; m.streak = rs.streak; }
    else { m.lastDay = ls.lastDay; m.streak = ls.streak; }
    return m;
  }
  function strip(c) { var o = {}; Object.keys(c).forEach(function (k) { if (k !== "img" && k !== "scanning") o[k] = c[k]; }); return o; }
  function rawSave() { try { localStorage.setItem("canvault", JSON.stringify(cans)); } catch (e) {} saveS(); }

  function applyRemote(row, union) {
    var rd = row.data || {};
    var rc = (rd.cans || []).map(cleanCan).filter(Boolean);
    var del = new Set((rd.del || []).concat(S.del || []));
    var local = new Map(cans.map(function (c) { return [c.id, c]; }));
    var out;
    if (union) {
      var m = new Map();
      cans.forEach(function (c) { m.set(c.id, c); });
      rc.forEach(function (c) { var l = m.get(c.id); if (l && l.img) c.img = l.img; m.set(c.id, c); });
      out = Array.from(m.values());
    } else {
      out = rc.map(function (c) { var l = local.get(c.id); if (l && l.img) c.img = l.img; return c; });
      cans.filter(function (c) { return c.scanning; }).forEach(function (c) { out.push(c); });
    }
    cans = out.filter(function (c) { return !del.has(c.id); });
    var merged = mergeSettings(localSettings(), rd.settings || {});
    Object.keys(merged).forEach(function (k) { S[k] = merged[k]; });
    S.del = Array.from(del).slice(-500);
    rawSave();
    render();
  }

  /* ---- sync ---- */
  async function pull() {
    var t = await token(); if (!t) return null;
    var rows = await api("/rest/v1/vaults?select=data,updated_at&user_id=eq." + uid(), { token: t });
    return (rows && rows[0]) || null;
  }
  async function push() {
    var t = await token(); if (!t) return;
    var cur = new Set(cans.map(function (c) { return c.id; }));
    S.del = S.del || [];
    (S.cloudIds || []).forEach(function (id) { if (!cur.has(id) && S.del.indexOf(id) < 0) S.del.push(id); });
    S.del = S.del.slice(-500);
    var data = { cans: cans.filter(function (c) { return !c.scanning; }).map(strip), settings: localSettings(), del: S.del };
    var rows = await api("/rest/v1/vaults?on_conflict=user_id", { method: "POST", token: t, headers: { Prefer: "resolution=merge-duplicates,return=representation" }, body: { user_id: uid(), data: data } });
    S.cloudAt = rows && rows[0] && rows[0].updated_at;
    S.cloudIds = cans.filter(function (c) { return !c.scanning; }).map(function (c) { return c.id; });
    setDirty(false); saveS();
  }
  async function pushProfile() {
    var t = await token(); if (!t) return;
    var o = ownedList();
    await api("/rest/v1/profiles?on_conflict=user_id", { method: "POST", token: t, headers: { Prefer: "resolution=merge-duplicates" },
      body: { user_id: uid(), name: String(S.name || "Collector").slice(0, 30), xp: Math.round(S.xp || 0), rank: rankInfo(S.xp || 0).name, cans: cnt(o), value: Math.round(sumV(o)) } });
  }
  async function sync(manual) {
    if (!ON || !sess || busy) return;
    busy = true; lastSync = Date.now(); if (manual) msg("Syncing…");
    try {
      var row = await pull();
      var dirty = isDirty();
      var remoteNewer = !!row && (!S.cloudAt || Date.parse(row.updated_at) > Date.parse(S.cloudAt));
      var needPush = !row || dirty || (!S.cloudAt && cans.length > 0);
      if (row && remoteNewer) {
        applyRemote(row, dirty || (!S.cloudAt && cans.length > 0));
        if (!needPush) { S.cloudAt = row.updated_at; S.cloudIds = cans.map(function (c) { return c.id; }); saveS(); }
      }
      if (needPush) await push();
      await pushProfile();
      msg("Synced " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    } catch (e) {
      msg(e instanceof TypeError ? "Offline. Will sync when you're back online." : "Sync failed: " + e.message);
    }
    busy = false;
  }
  window.cloudSchedule = function () { if (!ON || !sess) return; clearTimeout(timer); timer = setTimeout(function () { sync(); }, 4000); };

  /* ---- auth ---- */
  function friendly(e) { var m = String(e.message || e); if (/rate limit/i.test(m)) return "Too many emails right now. Try Google sign-in, or wait a while."; if (/invalid|expired/i.test(m)) return "That code is wrong or expired. Request a new one."; return m; }
  function captureHash() {
    var h = location.hash || "";
    if (!/access_token=|error_description=/.test(h)) return false;
    var p = new URLSearchParams(h.slice(1));
    try { history.replaceState(null, "", location.pathname + location.search); } catch (e) {}
    if (p.get("error_description")) { toast("Sign-in failed: " + p.get("error_description").replace(/\+/g, " ")); return false; }
    var at = p.get("access_token"); if (!at) return false;
    setSess({ access_token: at, refresh_token: p.get("refresh_token"), expires_at: Date.now() + (+p.get("expires_in") || 3600) * 1000 });
    return true;
  }
  async function afterSignIn() {
    var id = uid();
    if (S.cloudUser && S.cloudUser !== id && cans.length && !confirm("This phone still holds another account's cans. Add them to this account too?")) { setSess(null); ui(); return; }
    if (S.cloudUser !== id) { S.cloudAt = null; S.cloudIds = []; S.del = []; }
    S.cloudUser = id; saveS();
    try { await loadProfile(); } catch (e) {}
    ui(); await sync(true); if (lbOpen) board(); toast("Signed in");
  }
  async function loadProfile() {
    var t = await token(); if (!t) return;
    var r = await api("/rest/v1/profiles?select=name&user_id=eq." + uid(), { token: t });
    if (r && r[0] && r[0].name) S.name = r[0].name; else if (!S.name) S.name = (mail().split("@")[0] || "Collector").slice(0, 30);
    saveS();
  }
  async function board() {
    var box = el("lbList"); if (!box) return;
    box.textContent = "Loading…";
    try {
      var t = await token();
      var r = await api("/rest/v1/profiles?select=user_id,name,xp,rank,cans,value&order=xp.desc&limit=50", { token: t });
      box.innerHTML = r && r.length ? r.map(function (p, i) {
        return '<div class="lbrow' + (p.user_id === uid() ? " me" : "") + '"><b>' + (i + 1) + '</b><span>' + esc(p.name) + '<small>' + esc(p.rank) + ' · ' + (+p.xp || 0) + ' XP</small></span><em>' + (+p.cans || 0) + ' cans<small>' + money(p.value) + '</small></em></div>';
      }).join("") : '<p class="note">No one is on the board yet.</p>';
    } catch (e) { box.textContent = "Couldn't load the leaderboard: " + e.message; }
  }

  /* ---- UI ---- */
  function injectCSS() {
    var s = document.createElement("style");
    s.textContent = ".lbrow{display:grid;grid-template-columns:28px 1fr auto;gap:8px;align-items:center;padding:8px 6px;border-radius:10px}.lbrow.me{background:var(--ph)}.lbrow b{color:var(--mute)}.lbrow small{display:block;color:var(--mute);font-size:12px}.lbrow em{font-style:normal;text-align:right;font-size:14px}.lbrow span{min-width:0;overflow:hidden;text-overflow:ellipsis}";
    document.head.appendChild(s);
  }
  function ui() {
    var a = el("acct"), b = el("lbBox"); if (!a) return;
    if (!ON) { a.innerHTML = '<h3>Account</h3><p class="note">Cloud sync and the leaderboard are switched off. They turn on once the app owner adds their Supabase details.</p>'; if (b) b.innerHTML = ""; return; }
    if (!sess) {
      a.innerHTML = '<h3>Account</h3><p class="note">Sign in to keep your vault safe, sync it across phones and join the leaderboard. The app works without an account too.</p>' +
        '<label for="acEmail">Email</label><input id="acEmail" type="email" autocomplete="email" placeholder="you@example.com" value="' + esc(pendingEmail) + '">' +
        '<button class="primary" id="acSend" style="margin-top:10px">Email me a code</button>' +
        '<div id="acCodeBox" style="display:' + (pendingEmail ? "block" : "none") + '"><label for="acCode">Code from the email</label><input id="acCode" inputmode="numeric" autocomplete="one-time-code" placeholder="Enter the code"><button class="primary" id="acVerify" style="margin-top:10px">Sign in</button></div>' +
        '<button class="outline" id="acGoogle" style="width:100%;margin-top:8px">Continue with Google</button><p class="note" id="acMsg"></p>';
      if (b) b.innerHTML = "";
    } else {
      a.innerHTML = '<h3>Account</h3><p class="note">Signed in as ' + esc(mail()) + '</p>' +
        '<label for="acName">Leaderboard name</label><input id="acName" maxlength="30" value="' + esc(S.name || "") + '">' +
        '<div class="row" style="margin-top:8px"><button class="outline" id="acSaveName">Save name</button><button class="outline" id="acSync">Sync now</button></div>' +
        '<div class="row" style="margin-top:8px"><button class="outline" id="acOut">Sign out</button><button class="outline danger" id="acWipe">Delete cloud data</button></div><p class="note" id="acMsg"></p>';
      if (b) b.innerHTML = '<h3>Leaderboard</h3><p class="note">Shows name, rank, XP, can count and vault value. Nothing else.</p><div id="lbList"></div><button class="outline" id="lbRefresh" style="width:100%;margin-top:8px">Refresh</button>';
      if (b && !lbOpen) { lbOpen = true; board(); } else if (b) board();
    }
  }
  document.addEventListener("click", async function (e) {
    var id = e.target && e.target.id; if (!id) return;
    try {
      if (id === "acSend") {
        var em = (el("acEmail").value || "").trim(); if (!/^\S+@\S+\.\S+$/.test(em)) { msg("Enter a valid email."); return; }
        msg("Sending…"); await api("/auth/v1/otp", { method: "POST", body: { email: em, create_user: true } });
        pendingEmail = em; el("acCodeBox").style.display = "block"; msg("Check your email for the code.");
      } else if (id === "acVerify") {
        var code = (el("acCode").value || "").replace(/\s/g, ""); if (!code) { msg("Enter the code."); return; }
        msg("Checking…"); var j = await api("/auth/v1/verify", { method: "POST", body: { type: "email", email: pendingEmail, token: code } });
        setSess(fromTokens(j)); pendingEmail = ""; await afterSignIn();
      } else if (id === "acGoogle") {
        location.href = BASE + "/auth/v1/authorize?provider=google&redirect_to=" + encodeURIComponent(location.origin + "/");
      } else if (id === "acSaveName") {
        S.name = (el("acName").value || "").trim().slice(0, 30) || "Collector"; saveS(); await pushProfile(); board(); toast("Name saved");
      } else if (id === "acSync") { await sync(true); board(); }
      else if (id === "acOut") { setSess(null); lbOpen = false; ui(); toast("Signed out. Your cans stay on this phone."); }
      else if (id === "acWipe") {
        if (!confirm("Delete your vault and leaderboard entry from the cloud? Cans on this phone stay.")) return;
        var t = await token(); await api("/rest/v1/vaults?user_id=eq." + uid(), { method: "DELETE", token: t });
        await api("/rest/v1/profiles?user_id=eq." + uid(), { method: "DELETE", token: t });
        S.cloudAt = null; S.cloudIds = []; saveS(); toast("Cloud data deleted"); board();
      } else if (id === "lbRefresh") board();
    } catch (err) { msg(friendly(err)); if (id === "lbRefresh") board(); }
  });

  function init() {
    injectCSS();
    var back = ON && captureHash();
    ui();
    if (ON && sess) { if (back) afterSignIn(); else loadProfile().catch(function () {}).then(function () { return sync(); }); }
    window.addEventListener("online", function () { sync(); });
    document.addEventListener("visibilitychange", function () { if (!document.hidden && Date.now() - lastSync > 30000) sync(); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
