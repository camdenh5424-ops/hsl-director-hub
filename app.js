(function () {
  "use strict";

  // Capture this *before* the Supabase client parses and clears the URL hash.
  // Invite and password-reset emails land here with "#...type=invite..." or
  // "#...type=recovery..." — that's our signal to force a "set your password"
  // step instead of just dropping the person straight into the dashboard.
  var initialHash = window.location.hash || "";
  var needsPasswordSetup = /type=invite|type=recovery/i.test(initialHash);

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
    profiles: {},           // id -> profile, for everyone (used to show names + Admin page)
    updates: [],
    links: [],
    tools: {},              // id -> {label, group_name, done}
    catalogTopics: [],
    calendarEvents: [],
    monthFocus: {},          // 'YYYY-MM' -> {month, focus, updated_at}
    teamRoles: [],
    channel: null
  };

  // The month currently shown on the Calendar & Initiatives page (independent
  // of what "this month" means on the Overview page, which always shows today).
  var calState = (function () {
    var n = new Date();
    return { year: n.getFullYear(), month: n.getMonth() };
  })();

  // ---------- small helpers ----------
  function $(id) { return document.getElementById(id); }
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
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
  function monthKey(y, m0) { return y + "-" + String(m0 + 1).padStart(2, "0"); }

  // ---------- routing ----------
  var PAGES = ["overview", "catalog", "experience", "calendar", "team", "admin"];
  function showPage(name) {
    if (PAGES.indexOf(name) === -1) name = "overview";
    if (name === "admin" && !isOwner()) name = "overview";
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

  function wireSetPasswordForm() {
    var form = $("setpw-form");
    var err = $("setpw-error");
    form.addEventListener("submit", async function (ev) {
      ev.preventDefault();
      err.hidden = true;
      var pw = $("setpw-password").value;
      var confirm = $("setpw-confirm").value;
      if (pw.length < 6) {
        err.textContent = "Password must be at least 6 characters.";
        err.hidden = false;
        return;
      }
      if (pw !== confirm) {
        err.textContent = "Those two passwords don't match.";
        err.hidden = false;
        return;
      }
      var btn = $("setpw-submit");
      btn.disabled = true;
      var res = await sb.auth.updateUser({ password: pw });
      btn.disabled = false;
      if (res.error) {
        err.textContent = res.error.message;
        err.hidden = false;
        return;
      }
      needsPasswordSetup = false;
      $("setpw-screen").hidden = true;
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
      $("admin-navlink").hidden = true;
    }
    refreshComposer();
    refreshLinkForm();
    renderUpdates();
    renderLinks();
    renderCatalog();
    renderCalendarPage();
    renderOrgChart();
    renderRoleOverviewGrid();
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
    $("admin-navlink").hidden = !isOwner();
  }

  // ---------- overview page ----------
  function renderOverview() {
    var now = new Date();
    var key = monthKey(now.getFullYear(), now.getMonth());
    var monthName = now.toLocaleDateString(undefined, { month: "long" });
    $("overview-month-label").textContent = monthName + "'s Initiatives";

    var monthEvents = state.calendarEvents
      .filter(function (e) { return e.event_date && e.event_date.slice(0, 7) === key; })
      .sort(function (a, b) { return a.event_date < b.event_date ? -1 : 1; });

    var list = $("overview-init-list");
    if (!monthEvents.length) {
      list.innerHTML = '<div class="empty">No initiatives logged yet this month.</div>';
    } else {
      list.innerHTML = monthEvents.map(function (e) {
        var d = new Date(e.event_date + "T00:00:00");
        return '<div class="init-row"><div class="date">' + d.getDate() + '<small>' + d.toLocaleDateString(undefined, { month: "short" }).toUpperCase() + '</small></div>'
          + '<div><div class="what">' + escapeHtml(e.title) + '</div>'
          + (e.subtitle ? '<div class="sub">' + escapeHtml(e.subtitle) + '</div>' : '')
          + '</div></div>';
      }).join("");
    }

    var focusRow = state.monthFocus[key];
    var focusText = focusRow && focusRow.focus;
    $("overview-month-focus").innerHTML = focusText
      ? '<strong>Overall focus:</strong> ' + escapeHtml(focusText) + ' &mdash; <a href="#calendar" style="color:var(--blue-700);">see full calendar &rarr;</a>'
      : '<a href="#calendar" style="color:var(--blue-700);">Set this month\u2019s focus &rarr;</a>';

    $("stat-initiatives").textContent = monthEvents.length;
    $("stat-catalog").textContent = state.catalogTopics.length;
    $("stat-roles").textContent = state.teamRoles.length;
    var weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    var weekCount = state.updates.filter(function (u) { return new Date(u.created_at).getTime() >= weekAgo; }).length;
    $("stat-updates-week").textContent = weekCount;
  }

  // ---------- updates ----------
  function renderUpdates() {
    var feed = $("updates-feed");
    $("nav-updates-count") && ($("nav-updates-count").textContent = state.updates.length);

    if (!state.updates.length) {
      feed.innerHTML = '<div class="empty">No updates yet — post the first one.</div>';
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
    var pct = total ? Math.round((done / total) * 100) : 0;
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

  // ---------- content catalog ----------
  function findTopic(id) {
    var found = state.catalogTopics.filter(function (t) { return t.id === id; });
    return found[0];
  }

  function renderCatalog() {
    $("add-topic-btn").hidden = !canWrite();
    var grid = $("catalog-grid");
    var topics = state.catalogTopics;
    var html = topics.map(function (t) {
      return '<div class="catalog-card">'
        + '<h4>' + escapeHtml(t.title) + (canWrite() ? ' <button class="edit-btn" data-edit-topic="' + t.id + '">Edit</button>' : '') + '</h4>'
        + (t.biblical_direction ? '<div class="lbl">Biblical direction</div><p>' + escapeHtml(t.biblical_direction) + '</p>' : '')
        + (t.activation_ideas ? '<div class="lbl">Activation ideas</div><p>' + escapeHtml(t.activation_ideas) + '</p>' : '')
        + '</div>';
    }).join("");
    if (canWrite()) html += '<div class="catalog-card add-card" id="catalog-add-card">+ Add new topic</div>';
    grid.innerHTML = html || '<div class="empty">No topics yet.</div>';

    Array.prototype.slice.call(grid.querySelectorAll("[data-edit-topic]")).forEach(function (btn) {
      btn.addEventListener("click", function (ev) {
        ev.stopPropagation();
        openTopicModal("edit", findTopic(btn.getAttribute("data-edit-topic")));
      });
    });
    var addCard = $("catalog-add-card");
    if (addCard) addCard.addEventListener("click", function () { openTopicModal("add"); });
  }

  function openTopicModal(mode, topic) {
    $("topic-error").hidden = true;
    $("topic-modal-title").textContent = mode === "edit" ? "Edit topic" : "Add a catalog topic";
    $("topic-id").value = topic ? topic.id : "";
    $("topic-title").value = topic ? topic.title : "";
    $("topic-biblical").value = topic ? topic.biblical_direction : "";
    $("topic-activation").value = topic ? topic.activation_ideas : "";
    $("topic-delete").hidden = mode !== "edit";
    $("topic-modal").hidden = false;
  }
  function closeTopicModal() { $("topic-modal").hidden = true; }

  function wireTopicModal() {
    $("topic-modal-close").addEventListener("click", closeTopicModal);
    $("topic-modal").addEventListener("click", function (ev) {
      if (ev.target === $("topic-modal")) closeTopicModal();
    });
    $("add-topic-btn").addEventListener("click", function () { openTopicModal("add"); });

    $("topic-form").addEventListener("submit", async function (ev) {
      ev.preventDefault();
      if (!canWrite()) return;
      var id = $("topic-id").value;
      var payload = {
        title: $("topic-title").value.trim(),
        biblical_direction: $("topic-biblical").value.trim(),
        activation_ideas: $("topic-activation").value.trim()
      };
      if (!payload.title) return;
      var res;
      if (id) {
        res = await sb.from("catalog_topics").update(payload).eq("id", id);
      } else {
        payload.author_id = state.session.user.id;
        res = await sb.from("catalog_topics").insert(payload);
      }
      if (res.error) {
        $("topic-error").textContent = res.error.message;
        $("topic-error").hidden = false;
        return;
      }
      closeTopicModal();
    });

    $("topic-delete").addEventListener("click", async function () {
      var id = $("topic-id").value;
      if (!id) return;
      await sb.from("catalog_topics").delete().eq("id", id);
      closeTopicModal();
    });
  }

  // ---------- calendar & initiatives ----------
  function renderCalendarPage() {
    var y = calState.year, m = calState.month;
    var key = monthKey(y, m);
    var first = new Date(y, m, 1);
    $("cal-month-label").textContent = first.toLocaleDateString(undefined, { month: "long", year: "numeric" });

    var focusRow = state.monthFocus[key];
    $("cal-focus-text").textContent = (focusRow && focusRow.focus) || "No focus set for this month yet";
    $("cal-focus-input").value = (focusRow && focusRow.focus) || "";
    $("cal-focus-edit-wrap").hidden = !canWrite();

    var daysInMonth = new Date(y, m + 1, 0).getDate();
    var startDow = first.getDay();
    var monthEvents = state.calendarEvents.filter(function (e) { return e.event_date && e.event_date.slice(0, 7) === key; });
    var byDay = {};
    monthEvents.forEach(function (e) {
      var d = parseInt(e.event_date.slice(8, 10), 10);
      (byDay[d] = byDay[d] || []).push(e);
    });

    var html = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(function (d) { return '<div class="dow">' + d + '</div>'; }).join("");
    for (var i = 0; i < startDow; i++) html += '<div class="cell blank"></div>';
    for (var d = 1; d <= daysInMonth; d++) {
      var evs = byDay[d] || [];
      html += '<div class="cell"><div class="num">' + d + '</div>'
        + evs.map(function (e) { return '<div class="ev">' + escapeHtml(e.title) + '</div>'; }).join("")
        + '</div>';
    }
    $("big-cal").innerHTML = html;

    var sorted = monthEvents.slice().sort(function (a, b) { return a.event_date < b.event_date ? -1 : 1; });
    var listEl = $("event-list");
    if (!sorted.length) {
      listEl.innerHTML = '<div class="empty">No events yet this month.</div>';
    } else {
      listEl.innerHTML = sorted.map(function (e) {
        var dd = new Date(e.event_date + "T00:00:00");
        return '<div class="init-row"><div class="date">' + dd.getDate() + '<small>' + dd.toLocaleDateString(undefined, { month: "short" }).toUpperCase() + '</small></div>'
          + '<div style="flex:1 1 auto; min-width:0;"><div class="what">' + escapeHtml(e.title) + '</div>'
          + (e.subtitle ? '<div class="sub">' + escapeHtml(e.subtitle) + '</div>' : '') + '</div>'
          + (canWrite() ? '<button class="del" data-del-event="' + escapeHtml(e.id) + '" title="Remove">&times;</button>' : '')
          + '</div>';
      }).join("");
      Array.prototype.slice.call(listEl.querySelectorAll("[data-del-event]")).forEach(function (btn) {
        btn.addEventListener("click", async function () {
          await sb.from("calendar_events").delete().eq("id", btn.getAttribute("data-del-event"));
        });
      });
    }

    $("add-event-form").hidden = !canWrite();
    $("event-form-hint").hidden = canWrite();
  }

  function wireCalendarNav() {
    $("cal-prev").addEventListener("click", function () {
      calState.month--;
      if (calState.month < 0) { calState.month = 11; calState.year--; }
      renderCalendarPage();
    });
    $("cal-next").addEventListener("click", function () {
      calState.month++;
      if (calState.month > 11) { calState.month = 0; calState.year++; }
      renderCalendarPage();
    });
    $("cal-today").addEventListener("click", function () {
      var n = new Date();
      calState.year = n.getFullYear();
      calState.month = n.getMonth();
      renderCalendarPage();
    });
    $("cal-focus-save").addEventListener("click", async function () {
      if (!canWrite()) return;
      var key = monthKey(calState.year, calState.month);
      var text = $("cal-focus-input").value.trim();
      await sb.from("month_focus").upsert({ month: key, focus: text, updated_at: new Date().toISOString() });
    });
  }

  function wireAddEventForm() {
    $("add-event-form").addEventListener("submit", async function (ev) {
      ev.preventDefault();
      if (!canWrite()) return;
      var date = $("event-date").value;
      var title = $("event-title").value.trim();
      var subtitle = $("event-subtitle").value.trim();
      if (!date || !title) return;
      var res = await sb.from("calendar_events").insert({
        event_date: date, title: title, subtitle: subtitle, author_id: state.session.user.id
      });
      if (!res.error) $("add-event-form").reset();
    });
  }

  // ---------- team: org chart + role overviews ----------
  function findRole(id) {
    var found = state.teamRoles.filter(function (r) { return r.id === id; });
    return found[0];
  }

  function cardHtml(r, isTop) {
    return '<div class="org-card' + (isTop ? " top" : "") + '">'
      + (canWrite() ? '<button class="edit-btn" data-edit-role="' + r.id + '">Edit</button>' : '')
      + '<div class="org-avatar">' + escapeHtml(initials(r.title)) + '</div>'
      + '<div class="role">' + escapeHtml(r.title) + '</div>'
      + '<div class="lead">' + (r.subtitle ? escapeHtml(r.subtitle) : '&nbsp;') + '</div>'
      + '<div class="focus">' + escapeHtml(r.focus) + '</div>'
      + '</div>';
  }

  function renderOrgChart() {
    var wrap = $("org-chart");
    var roles = state.teamRoles;
    if (!roles.length) {
      wrap.innerHTML = canWrite()
        ? '<div class="org-card add-card" id="org-add-top">+ Add role</div>'
        : '<div class="empty">No roles yet.</div>';
      var addTop = $("org-add-top");
      if (addTop) addTop.addEventListener("click", function () { openRoleModal("add"); });
      return;
    }
    var byParent = {};
    roles.forEach(function (r) {
      var k = r.parent_id || "_top";
      (byParent[k] = byParent[k] || []).push(r);
    });
    Object.keys(byParent).forEach(function (k) {
      byParent[k].sort(function (a, b) { return a.sort_order - b.sort_order; });
    });
    var tops = byParent._top || [];
    var html = "";
    tops.forEach(function (top) {
      html += cardHtml(top, true);
      var kids = byParent[top.id] || [];
      html += '<div class="org-connector"></div><div class="org-row">';
      kids.forEach(function (k) { html += cardHtml(k, false); });
      if (canWrite()) html += '<div class="org-card add-card" data-add-child="' + top.id + '">+ Add role</div>';
      html += '</div>';
    });
    wrap.innerHTML = html;

    Array.prototype.slice.call(wrap.querySelectorAll("[data-edit-role]")).forEach(function (btn) {
      btn.addEventListener("click", function (ev) {
        ev.stopPropagation();
        openRoleModal("edit", findRole(btn.getAttribute("data-edit-role")));
      });
    });
    Array.prototype.slice.call(wrap.querySelectorAll("[data-add-child]")).forEach(function (btn) {
      btn.addEventListener("click", function () {
        openRoleModal("add", null, btn.getAttribute("data-add-child"));
      });
    });
  }

  function renderRoleOverviewGrid() {
    var grid = $("role-overview-grid");
    var roles = state.teamRoles.slice().sort(function (a, b) { return a.sort_order - b.sort_order; });
    if (!roles.length) {
      grid.innerHTML = '<div class="empty">No roles yet.</div>';
      return;
    }
    grid.innerHTML = roles.map(function (r) {
      var bullets = (r.responsibilities || "").split("\n").map(function (s) { return s.trim(); }).filter(Boolean);
      return '<div class="role-card">'
        + '<h4>' + escapeHtml(r.title) + (canWrite() ? ' <button class="edit-btn" data-edit-role2="' + r.id + '">Edit</button>' : '') + '</h4>'
        + '<div class="who">' + escapeHtml(r.subtitle || r.focus || "") + '</div>'
        + (bullets.length ? '<ul>' + bullets.map(function (b) { return '<li>' + escapeHtml(b) + '</li>'; }).join("") + '</ul>' : '')
        + (r.campus_example ? '<div class="campus-ex">At your campus: ' + escapeHtml(r.campus_example) + '</div>' : '')
        + '</div>';
    }).join("");

    Array.prototype.slice.call(grid.querySelectorAll("[data-edit-role2]")).forEach(function (btn) {
      btn.addEventListener("click", function () {
        openRoleModal("edit", findRole(btn.getAttribute("data-edit-role2")));
      });
    });
  }

  function populateRoleParentSelect(excludeId) {
    var sel = $("role-parent");
    var tops = state.teamRoles.filter(function (r) { return !r.parent_id && r.id !== excludeId; });
    sel.innerHTML = '<option value="">Top of chart (no one)</option>' + tops.map(function (r) {
      return '<option value="' + r.id + '">' + escapeHtml(r.title) + '</option>';
    }).join("");
  }

  function openRoleModal(mode, role, presetParentId) {
    $("role-error").hidden = true;
    $("role-modal-title").textContent = mode === "edit" ? "Edit role" : "Add a role";
    populateRoleParentSelect(role ? role.id : null);
    $("role-id").value = role ? role.id : "";
    $("role-title").value = role ? role.title : "";
    $("role-subtitle").value = role ? role.subtitle : "";
    $("role-focus").value = role ? role.focus : "";
    $("role-responsibilities").value = role ? role.responsibilities : "";
    $("role-campus-example").value = role ? role.campus_example : "";
    $("role-parent").value = role ? (role.parent_id || "") : (presetParentId || "");
    $("role-delete").hidden = mode !== "edit";
    $("role-modal").hidden = false;
  }
  function closeRoleModal() { $("role-modal").hidden = true; }

  function wireRoleModal() {
    $("role-modal-close").addEventListener("click", closeRoleModal);
    $("role-modal").addEventListener("click", function (ev) {
      if (ev.target === $("role-modal")) closeRoleModal();
    });
    $("add-role-btn").addEventListener("click", function () { openRoleModal("add"); });

    $("role-form").addEventListener("submit", async function (ev) {
      ev.preventDefault();
      if (!canWrite()) return;
      var id = $("role-id").value;
      var payload = {
        title: $("role-title").value.trim(),
        subtitle: $("role-subtitle").value.trim(),
        focus: $("role-focus").value.trim(),
        responsibilities: $("role-responsibilities").value.trim(),
        campus_example: $("role-campus-example").value.trim(),
        parent_id: $("role-parent").value || null
      };
      if (!payload.title) return;
      var res;
      if (id) {
        res = await sb.from("team_roles").update(payload).eq("id", id);
      } else {
        res = await sb.from("team_roles").insert(payload);
      }
      if (res.error) {
        $("role-error").textContent = res.error.message;
        $("role-error").hidden = false;
        return;
      }
      closeRoleModal();
    });

    $("role-delete").addEventListener("click", async function () {
      var id = $("role-id").value;
      if (!id) return;
      await sb.from("team_roles").delete().eq("id", id);
      closeRoleModal();
    });
  }

  // ---------- admin (owner only): invite + role management ----------
  function renderAdminTeamList() {
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
          renderAdminTeamList();
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
          renderAdminTeamList();
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
    var results = await Promise.all([
      sb.from("updates").select("*").order("created_at", { ascending: false }).limit(200),
      sb.from("links").select("*").order("created_at", { ascending: false }).limit(500),
      sb.from("tools").select("*"),
      sb.from("catalog_topics").select("*").order("created_at", { ascending: true }),
      sb.from("calendar_events").select("*").order("event_date", { ascending: true }),
      sb.from("month_focus").select("*"),
      sb.from("team_roles").select("*").order("sort_order", { ascending: true })
    ]);
    var u = results[0], l = results[1], t = results[2], ct = results[3], ce = results[4], mf = results[5], tr = results[6];

    state.updates = u.data || [];
    state.links = l.data || [];
    state.tools = {};
    (t.data || []).forEach(function (row) { state.tools[row.id] = row; });
    state.catalogTopics = ct.data || [];
    state.calendarEvents = ce.data || [];
    state.monthFocus = {};
    (mf.data || []).forEach(function (row) { state.monthFocus[row.month] = row; });
    state.teamRoles = tr.data || [];

    renderAllPages();
  }

  function renderAllPages() {
    renderOverview();
    renderUpdates();
    renderLinks();
    renderTools();
    renderCatalog();
    renderCalendarPage();
    renderOrgChart();
    renderRoleOverviewGrid();
  }

  function subscribeRealtime() {
    state.channel = sb
      .channel("hsl-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "updates" }, loadAndRenderUpdates)
      .on("postgres_changes", { event: "*", schema: "public", table: "links" }, loadAndRenderLinks)
      .on("postgres_changes", { event: "*", schema: "public", table: "tools" }, loadAndRenderTools)
      .on("postgres_changes", { event: "*", schema: "public", table: "catalog_topics" }, loadAndRenderCatalog)
      .on("postgres_changes", { event: "*", schema: "public", table: "calendar_events" }, loadAndRenderCalendar)
      .on("postgres_changes", { event: "*", schema: "public", table: "month_focus" }, loadAndRenderCalendar)
      .on("postgres_changes", { event: "*", schema: "public", table: "team_roles" }, loadAndRenderTeamRoles)
      .subscribe();
  }
  async function loadAndRenderUpdates() {
    var res = await sb.from("updates").select("*").order("created_at", { ascending: false }).limit(200);
    state.updates = res.data || [];
    renderUpdates();
    renderOverview();
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
  async function loadAndRenderCatalog() {
    var res = await sb.from("catalog_topics").select("*").order("created_at", { ascending: true });
    state.catalogTopics = res.data || [];
    renderCatalog();
    renderOverview();
  }
  async function loadAndRenderCalendar() {
    var results = await Promise.all([
      sb.from("calendar_events").select("*").order("event_date", { ascending: true }),
      sb.from("month_focus").select("*")
    ]);
    state.calendarEvents = results[0].data || [];
    state.monthFocus = {};
    (results[1].data || []).forEach(function (row) { state.monthFocus[row.month] = row; });
    renderCalendarPage();
    renderOverview();
  }
  async function loadAndRenderTeamRoles() {
    var res = await sb.from("team_roles").select("*").order("sort_order", { ascending: true });
    state.teamRoles = res.data || [];
    renderOrgChart();
    renderRoleOverviewGrid();
    renderOverview();
  }

  // ---------- boot ----------
  // Signing in only changes what you can DO (post, add links, edit the
  // catalog/calendar/team, see Admin) — the dashboard itself is loaded for
  // everyone, signed in or not, in boot() below.
  async function onSignedIn(session) {
    state.session = session;
    await loadMyProfile();
    await loadAllProfiles();
    renderWhoAmI();
    closeAuthModal();
    if (needsPasswordSetup) {
      $("setpw-screen").hidden = false;
    }
    if (isOwner()) wireInviteForm();
    renderAdminTeamList();
    updateAuthChrome();
  }

  async function boot() {
    wireAuthToggle();
    wireAuthForm();
    wireSignOut();
    wireSetPasswordForm();
    wireComposer();
    wireLinkForm();
    wireTopicModal();
    wireRoleModal();
    wireCalendarNav();
    wireAddEventForm();

    // Load and show the dashboard for every visitor, guest or not.
    await loadAllProfiles();
    await loadAll();
    subscribeRealtime();

    var sessionRes = await sb.auth.getSession();
    if (sessionRes.data && sessionRes.data.session) {
      await onSignedIn(sessionRes.data.session);
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
