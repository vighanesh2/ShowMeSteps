(() => {
  const els = {
    authBox: document.getElementById("auth-box"),
    apiBase: document.getElementById("api-base"),
    email: document.getElementById("email"),
    password: document.getElementById("password"),
    loginBtn: document.getElementById("login-btn"),
    logoutBtn: document.getElementById("logout-btn"),
    nav: document.getElementById("nav"),
    banner: document.getElementById("banner"),
    summary: document.getElementById("summary"),
    list: document.getElementById("list"),
  };

  function apiBase() {
    return (els.apiBase.value || "http://localhost:8000").replace(/\/$/, "");
  }

  function token() {
    return localStorage.getItem("sms_token");
  }

  function showBanner(message, isError = false) {
    els.banner.textContent = message || "";
    els.banner.classList.toggle("hidden", !message);
    els.banner.classList.toggle("error", Boolean(isError));
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  async function api(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (!(options.body instanceof FormData) && options.body != null) {
      headers["Content-Type"] = "application/json";
    }
    const t = token();
    if (t) headers.Authorization = `Bearer ${t}`;
    const res = await fetch(`${apiBase()}${path}`, { ...options, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail =
        typeof data.detail === "string"
          ? data.detail
          : Array.isArray(data.detail)
            ? data.detail.map((d) => d.msg || JSON.stringify(d)).join("; ")
            : "Request failed";
      throw new Error(detail);
    }
    return data;
  }

  function showLoggedIn() {
    els.authBox.classList.add("hidden");
    els.nav.classList.remove("hidden");
  }

  function showLoggedOut() {
    els.authBox.classList.remove("hidden");
    els.nav.classList.add("hidden");
    els.summary.classList.add("hidden");
    els.list.classList.add("hidden");
  }

  function renderSummary(totals) {
    const cards = [
      ["Tutorials", totals.tutorial_count ?? 0],
      ["Published", totals.published ?? 0],
      ["Drafts", totals.drafts ?? 0],
      ["Starts", totals.started ?? 0],
      ["Finished", totals.finished ?? 0],
      ["Passed", totals.passed ?? 0],
    ];
    els.summary.innerHTML = cards
      .map(
        ([label, value]) => `
      <div class="summary-card">
        <div class="label">${escapeHtml(label)}</div>
        <div class="value">${escapeHtml(value)}</div>
      </div>`
      )
      .join("");
    els.summary.classList.remove("hidden");
  }

  function renderTutorials(tutorials) {
    if (!tutorials.length) {
      els.list.innerHTML = `
        <div class="card">
          <h2 class="card-title">No tutorials yet</h2>
          <p class="muted">Record a task with the Chrome extension, then generate and publish it.</p>
        </div>`;
      els.list.classList.remove("hidden");
      return;
    }

    els.list.innerHTML = "";
    tutorials.forEach((t) => {
      const card = document.createElement("article");
      card.className = "card";
      card.dataset.id = t.id;

      const problems = (t.problem_steps || [])
        .map(
          (p) => `
        <div class="problem">
          <strong>Step ${p.order_index + 1}: ${escapeHtml(p.title)}</strong>
          <div class="muted">
            ${p.stuck_count} learner(s) stuck here
            ${p.friction_count ? ` · ${p.friction_count} mistake signal(s)` : ""}
          </div>
        </div>`
        )
        .join("") || `<p class="muted">No problem-step signals yet.</p>`;

      const attempts = (t.recent_attempts || [])
        .map(
          (a) => `
        <div class="attempt-row">
          <div><strong>${escapeHtml(a.status)}</strong> · ${a.steps_completed}/${a.steps_total} steps</div>
          <div class="muted">${escapeHtml(a.learner_label || a.learner_key.slice(0, 16))}${
            a.verification_summary ? ` — ${escapeHtml(a.verification_summary)}` : ""
          }</div>
        </div>`
        )
        .join("") || `<p class="muted">No learner attempts yet.</p>`;

      const v = t.verification || {};
      card.innerHTML = `
        <div class="card-head">
          <div>
            <h2 class="card-title">${escapeHtml(t.title)}</h2>
            <p class="muted" style="margin:6px 0 0">${escapeHtml(t.description || "No summary")}</p>
          </div>
          <span class="status-pill ${escapeHtml(t.status)}">${escapeHtml(t.status)}</span>
        </div>

        <div class="stats">
          <div class="stat"><div class="num">${t.started}</div><div class="lbl">Started</div></div>
          <div class="stat"><div class="num">${t.finished}</div><div class="lbl">Finished</div></div>
          <div class="stat"><div class="num">${t.passed}</div><div class="lbl">Passed</div></div>
          <div class="stat"><div class="num">${t.completion_rate}%</div><div class="lbl">Pass rate</div></div>
          <div class="stat"><div class="num">${t.step_count}</div><div class="lbl">Steps</div></div>
        </div>

        <div class="muted">
          Verification mix:
          passed ${v.passed || 0} ·
          pending ${v.pending_review || 0} ·
          retry ${v.needs_retry || 0} ·
          in progress ${v.in_progress || 0} ·
          failed ${v.failed || 0}
        </div>

        ${
          t.share_url
            ? `<div class="share-row">
                <code id="share-${t.id}">${escapeHtml(t.share_url)}</code>
                <button type="button" class="ghost copy" data-url="${escapeHtml(t.share_url)}">Copy link</button>
                <a class="ghost btn" href="${escapeHtml(t.share_url)}" target="_blank" rel="noreferrer">Open</a>
              </div>`
            : `<p class="muted">Publish to get a shareable learner link.</p>`
        }

        <div class="actions">
          <a class="btn primary" href="/review/?tutorial_id=${encodeURIComponent(t.id)}">Edit</a>
          ${
            t.status === "published"
              ? `<button type="button" class="secondary unpublish" data-id="${t.id}">Unpublish</button>`
              : `<button type="button" class="secondary publish" data-id="${t.id}">Publish</button>`
          }
          <a class="btn ghost" href="/review/?tutorial_id=${encodeURIComponent(t.id)}#attempts">Review attempts</a>
        </div>

        <div class="two-col">
          <div class="panel-block">
            <h3>Steps causing problems</h3>
            ${problems}
          </div>
          <div class="panel-block">
            <h3>Recent learner progress</h3>
            ${attempts}
          </div>
        </div>
      `;
      els.list.appendChild(card);
    });
    els.list.classList.remove("hidden");
  }

  async function loadDashboard() {
    showBanner("Loading dashboard…");
    const data = await api("/api/dashboard");
    renderSummary(data.totals || {});
    renderTutorials(data.tutorials || []);
    showBanner("");
  }

  els.loginBtn.addEventListener("click", async () => {
    try {
      showBanner("Signing in…");
      const data = await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({
          email: els.email.value.trim(),
          password: els.password.value,
        }),
      });
      localStorage.setItem("sms_token", data.access_token);
      localStorage.setItem("sms_api_base", apiBase());
      localStorage.setItem("sms_email", data.user?.email || els.email.value.trim());
      els.password.value = "";
      showLoggedIn();
      await loadDashboard();
    } catch (err) {
      showBanner(err.message || String(err), true);
    }
  });

  els.logoutBtn.addEventListener("click", () => {
    localStorage.removeItem("sms_token");
    showLoggedOut();
    showBanner("Logged out.");
  });

  els.list.addEventListener("click", async (event) => {
    const copyBtn = event.target.closest(".copy");
    if (copyBtn) {
      try {
        await navigator.clipboard.writeText(copyBtn.dataset.url);
        showBanner("Share link copied.");
      } catch {
        showBanner("Could not copy link.", true);
      }
      return;
    }

    const publishBtn = event.target.closest(".publish");
    const unpublishBtn = event.target.closest(".unpublish");
    const btn = publishBtn || unpublishBtn;
    if (!btn) return;
    const id = btn.dataset.id;
    try {
      showBanner(publishBtn ? "Publishing…" : "Unpublishing…");
      const path = publishBtn
        ? `/api/dashboard/tutorials/${id}/publish`
        : `/api/dashboard/tutorials/${id}/unpublish`;
      const result = await api(path, { method: "POST", body: "{}" });
      showBanner(result.message || "Updated.");
      await loadDashboard();
    } catch (err) {
      showBanner(err.message || String(err), true);
    }
  });

  const savedBase = localStorage.getItem("sms_api_base");
  if (savedBase) els.apiBase.value = savedBase;
  const savedEmail = localStorage.getItem("sms_email");
  if (savedEmail) els.email.value = savedEmail;

  if (token()) {
    showLoggedIn();
    loadDashboard().catch((err) => showBanner(err.message || String(err), true));
  } else {
    showLoggedOut();
    showBanner("Log in to open your creator dashboard.");
  }
})();
