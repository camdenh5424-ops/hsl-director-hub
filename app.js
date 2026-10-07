(function () {
  "use strict";

  // ---------- Supabase client ----------
  var cfg = window.HSL_CONFIG || {};
  if (!cfg.SUPABASE_URL || cfg.SUPABASE_URL.indexOf("YOUR-PROJECT-REF") !== -1) {
    document.getElementById("config-warning").hidden = false;
  }
  var sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

  var TOOL_SEED_ORDER = [
    "semester-planner", "budget-guidance", "journey-tracker", "content-catalog",
    "define-outcomes", "define-expectations", "define-values"
  ];

  var state = {
    session: null,
    profile: null,          // my own profile row {id, email, display_name, role}
    profiles: {},           // id -> profile, for everyone (used to show names + Team page)
    updates: [],
    links: [],
    tools: {},              // id -> {label, group_name, done}
    channel: null
  };

  // ---------- small helpers ----------
  function $(id) { return document.getElementById(id); }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function initials(name) {
    if (!name) return "?";
    var parts = name.trim().split(/\s+/);
    return (parts[0][0] + (parts[1] ? parts[1][0] : "")).toUpperCase();
  }
  function timeAgo(iso) {
    if (!iso) return "";
    var ts = new Date(iso).getTime();
    var diff = Date.now() - ts;
    var m = Math.floor(diff / 60000);
    if (m < 1) return "just now";
    if (m < 60) return m + "m ago";
    var h = Math.floor(m / 60);
    if (h < 24) return h + "h ago";
    var d = Math.floor(h / 24);
    if (d < 7) return d + "d ago";
    return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  function displayName(id) {
    var p = state.profiles[id];
    if (!p) return "Teammate";
    return p.display_name || (p.email ? p.email.split("@")[0] : "Teammate");
  }
  function canWrite() {
    return !!(state.profile && (state.profile.role === "owner" || state.profile.role === "editor"));
  }
  function isOwner() {
    return !!(state.profile && state.profile.role === "owner");
  }

  // ---------- routing ----------
  var PAGES = ["overview", "updates", "links", "tools", "plan", "team"];
  function showPage(name) {
    if (PAGES.indexOf(name) === -1) name = "overview";
    if (name === "team" && !isOwner()) name = "overview";
    PAGES.forEach(function (p) {
      var el = $("page-" + p);
      if (el) el.hidden = p !== name;
    });
    Array.prototype.slice.call(document.querySelectorAll(".navlink")).forEach(function (l) {
      l.classList.toggle("active", l.dataset.page === name);
    });
    window.scrollTo(0, 0);
  }
  function routeFromHash() {
    showPage((location.hash || "#overview").replace("#", ""));
  }
  window.addEventListener("hashchange", routeFromHash);

  // ---------- auth modal (sign in is optional — viewing never requires it) ----------
  function openAuthModal() { $("auth-screen").hidden = false; }
  function closeAuthModal() { $("auth-screen").hidden = true; }

  function wireAuthToggle() {
    $("sign-in-open").addEventListener("click", openAuthModal);
    $("auth-close").addEventListener("click", closeAuthModal);
    $("auth-screen").addEventListener("click", function (ev) {
      if (ev.target === $("auth-screen")) closeAuthModal();
    });
  }

  function wireAuthForm() {
    var form = $("login-form");
    var err = $("auth-error");
    form.addEventListener("submit", async function (ev) {
      ev.preventDefault();
      err.hidden = true;
      var email = $("login-email").value.trim();
      var password = $("login-password").value;
      var btn = $("login-submit");
      btn.disabled = true;
      var res = await sb.auth.signInWithPassword({ email: email, password: password });
      btn.disabled = false;
      if (res.error) {
        err.textContent = res.error.message;
        err.hidden = false;
        return;
      }
      form.reset();
      await onSignedIn(res.data.session);
    });

    $("forgot-link").addEventListener("click", async function (ev) {
      ev.preventDefault();
      var email = $("login-email").value.trim();
      if (!email) {
        err.textContent = "Enter your email above first, then click this again.";
        err.hidden = false;
        return;
      }
      await sb.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
      err.textContent = "If that email has an account, a reset link is on its way.";
      err.hidden = false;
    });
  }

  function wireSignOut() {
    $("sign-out").addEventListener("click", async function () {
      if (state.channel) sb.removeChannel(state.channel);
      await sb.auth.signOut();
      location.reload();
    });
  }

  // Shows the right chrome (sign-in button vs. signed-in chip) for the
  // current session, and re-renders anything whose write controls depend on it.
  function updateAuthChrome() {
    var signedIn = !!state.session;
    $("sign-in-open").hidden = signedIn;
    $("whoami-chip").hidden = !signedIn;
    $("sign-out").hidden = !signedIn;
    if (!signedIn) {
      $("team-navlink").hidden = true;
    }
    refreshComposer();
    refreshLinkForm();
    renderUpdates();
    renderLinks();
  }

  // ---------- profile / role ----------
  async function loadMyProfile() {
    var uid = state.session.user.id;
    var res = await sb.from("profiles").select("*").eq("id", uid).single();
    if (res.error) {
      // Profile row usually appears instantly via the DB trigger; retry once.
      await new Promise(function (r) { setTimeout(r, 800); });
      res = await sb.from("profiles").select("*").eq("id", uid).single();
    }
    state.profile = res.data || { id: uid, email: state.session.user.email, display_name: null, role: "viewer" };
    state.profiles[state.profile.id] = state.profile;
  }

  async function loadAllProfiles() {
    var res = await sb.from("profiles").select("*").order("created_at", { ascending: true });
    if (!res.error && res.data) {
      state.profiles = {};
      res.data.forEach(function (p) { state.profiles[p.id] = p; });
    }
  }

  function renderWhoAmI() {
    var name = displayName(state.profile.id);
    $("whoami").textContent = name;
    $("role-badge").textContent = state.profile.role;
    $("update-hint").textContent = "Posting as " + name;
    $("team-navlink").hidden = !isOwner();
  }

  // ---------- updates ----------
  function renderUpdates() {
    var feed = $("updates-feed");
    var overviewFeed = $("overview-updates");
    $("stat-updates").textContent = state.updates.length;
    $("nav-updates-count").textContent = state.updates.length;

    if (!state.updates.length) {
      feed.innerHTML = '<div class="empty">No updates yet — post the first one.</div>';
      overviewFeed.innerHTML = '<div class="empty">No updates yet — post the first one.</div>';
      return;
    }
    var sorted = state.updates.slice().sort(function (a, b) {
      return new Date(b.created_at) - new Date(a.created_at);
    });

    function row(u) {
      var name = displayName(u.author_id);
      var mine = state.session && u.author_id === state.session.user.id;
      var canDelete = mine || isOwner();
      return '<div class="update" data-id="' + escapeHtml(u.id) + '">'
        + '<div class="avatar">' + escapeHtml(initials(name)) + "</div>"
        + '<div class="body">'
        + '<div class="meta"><span class="who">' + escapeHtml(name) + '</span><span class="when">' + escapeHtml(timeAgo(u.created_at)) + "</span></div>"
        + '<div class="text">' + escapeHtml(u.text) + "</div>"
        + "</div>"
        + (canDelete ? '<button class="del" data-del-update="' + escapeHtml(u.id) + '">Delete</button>' : "")
        + "</div>";
    }

    feed.innerHTML = sorted.map(row).join("");
    overviewFeed.innerHTML = sorted.slice(0, 3).map(row).join("");

    Array.prototype.slice.call(document.querySelectorAll("[data-del-update]")).forEach(function (btn) {
      btn.addEventListener("click", async function () {
        await sb.from("updates").delete().eq("id", btn.getAttribute("data-del-update"));
      });
    });
  }

  function refreshComposer() {
    var btn = $("post-update");
    var ta = $("update-text");
    btn.disabled = !canWrite() || !ta.value.trim();
    ta.placeholder = canWrite()
      ? "Share an update with the team..."
      : (state.session ? "Only editors can post updates. Ask an owner for access." : "Sign in to post an update.");
  }

  function wireComposer() {
    var btn = $("post-update");
    var ta = $("update-text");
    ta.addEventListener("input", refreshComposer);
    refreshComposer();

    btn.addEventListener("click", async function () {
      if (!canWrite()) return;
      var text = ta.value.trim();
      if (!text) return;
      btn.disabled = true;
      var res = await sb.from("updates").insert({ text: text, author_id: state.session.user.id });
      if (!res.error) ta.value = "";
      refreshComposer();
    });
  }

  // ---------- links ----------
  var CATS = ["Content Catalog", "Branding & Graphics", "Budget", "Planner & Calendar", "Director Resources", "Other"];
  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch (e) { return url; }
  }
  function renderLinks() {
    $("stat-links").textContent = state.links.length;
    $("nav-links-count").textContent = state.links.length;
    var wrap = $("link-groups");
    if (!state.links.length) {
      wrap.innerHTML = '<div class="empty">No links yet — add the first file or resource.</div>';
      return;
    }
    var byCat = {};
    state.links.forEach(function (l) {
      var c = l.category && CATS.indexOf(l.category) !== -1 ? l.category : "Other";
      (byCat[c] = byCat[c] || []).push(l);
    });
    var html = "";
    CATS.forEach(function (cat) {
      if (!byCat[cat]) return;
      var items = byCat[cat].slice().sort(function (a, b) { return new Date(b.created_at) - new Date(a.created_at); });
      html += '<div><p class="link-group-label">' + escapeHtml(cat) + '</p><div class="link-list">';
      items.forEach(function (l) {
        var mine = state.session && l.author_id === state.session.user.id;
        var canDelete = mine || isOwner();
        html += '<div class="link-row" data-id="' + escapeHtml(l.id) + '">'
          + '<div class="ico">' + escapeHtml((hostOf(l.url) || "?")[0].toUpperCase()) + "</div>"
          + '<div class="info"><div class="title">' + escapeHtml(l.title) + '</div><div class="url">' + escapeHtml(hostOf(l.url)) + "</div></div>"
          + '<div class="meta">' + escapeHtml(timeAgo(l.created_at)) + "</div>"
          + '<a class="open" href="' + escapeHtml(l.url) + '" target="_blank" rel="noopener noreferrer">Open</a>'
          + (canDelete ? '<button class="del" data-del-link="' + escapeHtml(l.id) + '" title="Remove">&times;</button>' : "")
          + "</div>";
      });
      html += "</div></div>";
    });
    wrap.innerHTML = html;
    Array.prototype.slice.call(document.querySelectorAll("[data-del-link]")).forEach(function (btn) {
      btn.addEventListener("click", async function () {
        await sb.from("links").delete().eq("id", btn.getAttribute("data-del-link"));
      });
    });
  }

  function refreshLinkForm() {
    var ok = canWrite() && $("link-title").value.trim() && $("link-url").value.trim();
    $("add-link-btn").disabled = !ok;
  }

  function wireLinkForm() {
    var form = $("add-link-form");
    var btn = $("add-link-btn");
    ["link-title", "link-url"].forEach(function (id) { $(id).addEventListener("input", refreshLinkForm); });
    refreshLinkForm();

    form.addEventListener("submit", async function (ev) {
      ev.preventDefault();
      if (!canWrite()) return;
      var title = $("link-title").value.trim();
      var url = $("link-url").value.trim();
      var category = $("link-category").value;
      if (!title || !url) return;
      btn.disabled = true;
      var res = await sb.from("links").insert({
        title: title, url: url, category: category, author_id: state.session.user.id
      });
      if (!res.error) form.reset();
      refreshLinkForm();
    });
  }

  // ---------- tools checklist ----------
  function renderTools() {
    var total = TOOL_SEED_ORDER.length;
    var done = TOOL_SEED_ORDER.filter(function (id) { return state.tools[id] && state.tools[id].done; }).length;
    $("stat-tools").textContent = done + " / " + total;
    var pct = total ? Math.round((done / total) * 100) : 0;
    $("nav-tools-count").textContent = pct + "%";
    $("tools-progress-label").textContent = pct + "%";
    $("tools-progress-bar").style.width = pct + "%";

    var groups = {};
    TOOL_SEED_ORDER.forEach(function (id) {
      var t = state.tools[id];
      if (!t) return;
      (groups[t.group_name] = groups[t.group_name] || []).push({ id: id, label: t.label, done: t.done });
    });
    var wrap = $("tool-groups");
    var html = "";
    Object.keys(groups).forEach(function (g) {
      html += '<div><p class="link-group-label">' + escapeHtml(g) + '</p><ul class="tool-list">';
      groups[g].forEach(function (t) {
        html += '<li class="tool-item' + (t.done ? " done" : "") + '" data-tool="' + escapeHtml(t.id) + '">'
          + '<span class="box">' + (t.done ? "&#10003;" : "") + "</span>"
          + '<span class="label">' + escapeHtml(t.label) + "</span></li>";
      });
      html += "</ul></div>";
    });
    wrap.innerHTML = html || '<div class="empty">No resources seeded yet.</div>';

    Array.prototype.slice.call(document.querySelectorAll("[data-tool]")).forEach(function (li) {
      li.addEventListener("click", async function () {
        if (!canWrite()) return;
        var id = li.getAttribute("data-tool");
        var cur = state.tools[id] && state.tools[id].done;
        await sb.from("tools").update({ done: !cur }).eq("id", id);
      });
    });
  }

  // ---------- team access (owner only) ----------
  function renderTeam() {
    var wrap = $("team-list");
    var rows = Object.keys(state.profiles).map(function (id) { return state.profiles[id]; });
    rows.sort(function (a, b) { return new Date(a.created_at) - new Date(b.created_at); });
    if (!rows.length) {
      wrap.innerHTML = '<div class="empty">No one yet.</div>';
      return;
    }
    wrap.innerHTML = rows.map(function (p) {
      var roleOptions = ["owner", "editor", "viewer"].map(function (r) {
        return '<option value="' + r + '"' + (r === p.role ? " selected" : "") + ">" + r + "</option>";
      }).join("");
      var isSelf = state.session && p.id === state.session.user.id;
      return '<div class="team-row" data-user="' + escapeHtml(p.id) + '">'
        + '<div class="who-info"><div class="who-email">' + escapeHtml(p.display_name || p.email) + (isSelf ? " (you)" : "") + "</div>"
        + '<div class="who-meta">' + escapeHtml(p.email || "") + "</div></div>"
        + '<select class="role-select" ' + (isSelf ? "disabled" : "") + ">" + roleOptions + "</select>"
        + "</div>";
    }).join("");

    Array.prototype.slice.call(document.querySelectorAll(".team-row")).forEach(function (row) {
      var sel = row.querySelector(".role-select");
      if (sel.disabled) return;
      sel.addEventListener("change", async function () {
        var userId = row.getAttribute("data-user");
        sel.disabled = true;
        try {
          await fetch("/api/set-role", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              userId: userId,
              role: sel.value,
              accessToken: state.session.access_token
            })
          });
          await loadAllProfiles();
          renderTeam();
        } finally {
          sel.disabled = false;
        }
      });
    });
  }

  function wireInviteForm() {
    var form = $("invite-form");
    var status = $("invite-status");
    form.addEventListener("submit", async function (ev) {
      ev.preventDefault();
      var email = $("invite-email").value.trim();
      var role = $("invite-role").value;
      if (!email) return;
      var btn = $("invite-submit");
      btn.disabled = true;
      status.hidden = true;
      try {
        var res = await fetch("/api/invite-user", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: email, role: role, accessToken: state.session.access_token })
        });
        var json = await res.json();
        if (!res.ok) {
          status.textContent = json.error || "Something went wrong.";
          status.style.color = "var(--red)";
        } else {
          status.textContent = email + " has been invited.";
          status.style.color = "var(--green-accent)";
          form.reset();
          await loadAllProfiles();
          renderTeam();
        }
      } catch (e) {
        status.textContent = "Network error — try again.";
        status.style.color = "var(--red)";
      }
      status.hidden = false;
      btn.disabled = false;
    });
  }

  // ---------- data loading + realtime ----------
  async function loadAll() {
    var [u, l, t] = await Promise.all([
      sb.from("updates").select("*").order("created_at", { ascending: false }).limit(200),
      sb.from("links").select("*").order("created_at", { ascending: false }).limit(500),
      sb.from("tools").select("*")
    ]);
    state.updates = u.data || [];
    state.links = l.data || [];
    state.tools = {};
    (t.data || []).forEach(function (row) { state.tools[row.id] = row; });
    renderUpdates();
    renderLinks();
    renderTools();
  }

  function subscribeRealtime() {
    state.channel = sb
      .channel("hsl-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "updates" }, loadAndRenderUpdates)
      .on("postgres_changes", { event: "*", schema: "public", table: "links" }, loadAndRenderLinks)
      .on("postgres_changes", { event: "*", schema: "public", table: "tools" }, loadAndRenderTools)
      .subscribe();
  }
  async function loadAndRenderUpdates() {
    var res = await sb.from("updates").select("*").order("created_at", { ascending: false }).limit(200);
    state.updates = res.data || [];
    renderUpdates();
  }
  async function loadAndRenderLinks() {
    var res = await sb.from("links").select("*").order("created_at", { ascending: false }).limit(500);
    state.links = res.data || [];
    renderLinks();
  }
  async function loadAndRenderTools() {
    var res = await sb.from("tools").select("*");
    state.tools = {};
    (res.data || []).forEach(function (row) { state.tools[row.id] = row; });
    renderTools();
  }

  // ---------- boot ----------
  // Signing in only changes what you can DO (post, add links, check off the
  // list, see Team Access) — the dashboard itself is loaded for everyone,
  // signed in or not, in boot() below.
  async function onSignedIn(session) {
    state.session = session;
    await loadMyProfile();
    await loadAllProfiles();
    renderWhoAmI();
    closeAuthModal();
    if (isOwner()) wireInviteForm();
    renderTeam();
    updateAuthChrome();
  }

  async function boot() {
    wireAuthToggle();
    wireAuthForm();
    wireSignOut();
    wireComposer();
    wireLinkForm();

    // Load and show the dashboard for every visitor, guest or not.
    await loadAllProfiles();
    await loadAll();
    subscribeRealtime();

    var { data } = await sb.auth.getSession();
    if (data && data.session) {
      await onSignedIn(data.session);
    } else {
      updateAuthChrome();
    }
    routeFromHash();

    sb.auth.onAuthStateChange(function (event, session) {
      if (event === "SIGNED_OUT") {
        if (state.channel) sb.removeChannel(state.channel);
        location.reload();
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
