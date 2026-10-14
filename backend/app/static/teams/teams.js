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
    workspace: document.getElementById("workspace"),
    teamName: document.getElementById("team-name"),
    createTeam: document.getElementById("create-team"),
    teamsList: document.getElementById("teams-list"),
    assignmentList: document.getElementById("assignment-list"),
  };

  /** @type {any[]} */
  let tutorials = [];

  function apiBase() {
    return (els.apiBase.value || "http://localhost:8000").replace(/\/$/, "");
  }
  function token() {
    return localStorage.getItem("sms_token");
  }
  function showBanner(msg, isError = false) {
    els.banner.textContent = msg || "";
    els.banner.classList.toggle("hidden", !msg);
    els.banner.classList.toggle("error", Boolean(isError));
  }
  function escapeHtml(v) {
    return String(v ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  async function api(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body != null && !(options.body instanceof FormData)) {
      headers["Content-Type"] = "application/json";
    }
    const t = token();
    if (t) headers.Authorization = `Bearer ${t}`;
    const res = await fetch(`${apiBase()}${path}`, { ...options, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(
        typeof data.detail === "string" ? data.detail : "Request failed"
      );
    }
    return data;
  }

  function showLoggedIn() {
    els.authBox.classList.add("hidden");
    els.nav.classList.remove("hidden");
    els.workspace.classList.remove("hidden");
  }
  function showLoggedOut() {
    els.authBox.classList.remove("hidden");
    els.nav.classList.add("hidden");
    els.workspace.classList.add("hidden");
  }

  async function loadMyAssignments() {
    const items = await api("/api/teams/me/assignments");
    if (!items.length) {
      els.assignmentList.innerHTML = "No tutorials assigned to you yet.";
      return;
    }
    els.assignmentList.innerHTML = items
      .map(
        (a) => `
      <div class="assign-row">
        <div>
          <strong>${escapeHtml(a.tutorial_title || "Tutorial")}</strong>
          <div class="muted">${escapeHtml(a.status)}${
            a.due_at ? ` · due ${escapeHtml(a.due_at)}` : ""
          }</div>
        </div>
        <div class="actions">
          ${
            a.share_url
              ? `<a class="btn primary" href="${escapeHtml(a.share_url)}" target="_blank" rel="noreferrer">Open</a>`
              : ""
          }
        </div>
      </div>`
      )
      .join("");
  }

  function renderTeam(team) {
    const isAdmin = team.my_role === "owner" || team.my_role === "admin";
    const members = (team.members || [])
      .map(
        (m) => `
      <div class="member-row">
        <div>
          <strong>${escapeHtml(m.email)}</strong>
          <div class="muted">${escapeHtml(m.role)} · ${escapeHtml(m.status)}</div>
        </div>
      </div>`
      )
      .join("");

    const tutorialOptions = tutorials
      .map(
        (t) =>
          `<option value="${escapeHtml(t.id)}">${escapeHtml(t.title)} (${escapeHtml(
            t.status
          )})</option>`
      )
      .join("");

    const card = document.createElement("article");
    card.className = "card";
    card.dataset.id = team.id;
    card.innerHTML = `
      <div class="card-head">
        <div>
          <h2 class="card-title">${escapeHtml(team.name)}</h2>
          <p class="muted">Your role: ${escapeHtml(team.my_role || "member")}</p>
        </div>
      </div>
      <div class="panel-block">
        <h3>Members</h3>
        ${members || '<p class="muted">No members</p>'}
      </div>
      ${
        isAdmin
          ? `<div class="inline-form">
              <h3 class="muted" style="margin:0">Invite employee</h3>
              <input class="invite-email" type="email" placeholder="employee@company.com" />
              <select class="invite-role">
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
              <button type="button" class="secondary invite-btn">Invite</button>

              <h3 class="muted" style="margin:8px 0 0">Assign tutorial</h3>
              <select class="assign-tutorial">${tutorialOptions}</select>
              <input class="assign-emails" type="text" placeholder="emails, comma-separated" />
              <button type="button" class="primary assign-btn">Assign</button>
              <div class="team-assignments muted">Loading assignments…</div>
            </div>`
          : ""
      }
    `;
    els.teamsList.appendChild(card);

    if (isAdmin) {
      loadTeamAssignments(team.id, card.querySelector(".team-assignments"));
    }
  }

  async function loadTeamAssignments(teamId, container) {
    try {
      const items = await api(`/api/teams/${teamId}/assignments`);
      if (!items.length) {
        container.textContent = "No assignments yet.";
        return;
      }
      container.innerHTML = items
        .map(
          (a) =>
            `<div class="assign-row"><div><strong>${escapeHtml(
              a.tutorial_title || a.tutorial_id
            )}</strong> → ${escapeHtml(a.assignee_email)} <span class="muted">(${escapeHtml(
              a.status
            )})</span></div></div>`
        )
        .join("");
    } catch (err) {
      container.textContent = err.message;
    }
  }

  async function refresh() {
    showBanner("Loading teams…");
    const dash = await api("/api/dashboard").catch(() => ({ tutorials: [] }));
    tutorials = dash.tutorials || [];
    const teams = await api("/api/teams");
    els.teamsList.innerHTML = "";
    teams.forEach(renderTeam);
    await loadMyAssignments();
    showBanner(teams.length ? "" : "Create a team to invite employees and assign tutorials.");
  }

  els.loginBtn.addEventListener("click", async () => {
    try {
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
      await refresh();
    } catch (err) {
      showBanner(err.message || String(err), true);
    }
  });

  els.logoutBtn.addEventListener("click", () => {
    localStorage.removeItem("sms_token");
    showLoggedOut();
    showBanner("Logged out.");
  });

  els.createTeam.addEventListener("click", async () => {
    const name = els.teamName.value.trim();
    if (!name) return showBanner("Team name required", true);
    try {
      await api("/api/teams", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      els.teamName.value = "";
      showBanner("Team created.");
      await refresh();
    } catch (err) {
      showBanner(err.message || String(err), true);
    }
  });

  els.teamsList.addEventListener("click", async (event) => {
    const card = event.target.closest(".card");
    if (!card) return;
    const teamId = card.dataset.id;

    if (event.target.closest(".invite-btn")) {
      const email = card.querySelector(".invite-email").value.trim();
      const role = card.querySelector(".invite-role").value;
      try {
        await api(`/api/teams/${teamId}/members`, {
          method: "POST",
          body: JSON.stringify({ email, role }),
        });
        showBanner(`Invited ${email}`);
        await refresh();
      } catch (err) {
        showBanner(err.message || String(err), true);
      }
      return;
    }

    if (event.target.closest(".assign-btn")) {
      const tutorialId = card.querySelector(".assign-tutorial").value;
      const emails = card
        .querySelector(".assign-emails")
        .value.split(",")
        .map((e) => e.trim())
        .filter(Boolean);
      if (!tutorialId || !emails.length) {
        return showBanner("Pick a tutorial and at least one email", true);
      }
      try {
        await api(`/api/teams/${teamId}/assignments`, {
          method: "POST",
          body: JSON.stringify({
            tutorial_id: tutorialId,
            assignee_emails: emails,
          }),
        });
        showBanner("Tutorial assigned.");
        await refresh();
      } catch (err) {
        showBanner(err.message || String(err), true);
      }
    }
  });

  const savedBase = localStorage.getItem("sms_api_base");
  if (savedBase) els.apiBase.value = savedBase;
  const savedEmail = localStorage.getItem("sms_email");
  if (savedEmail) els.email.value = savedEmail;

  if (token()) {
    showLoggedIn();
    refresh().catch((err) => showBanner(err.message || String(err), true));
  } else {
    showLoggedOut();
    showBanner("Log in to manage teams.");
  }
})();
