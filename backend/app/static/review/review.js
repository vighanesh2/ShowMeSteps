(() => {
  const params = new URLSearchParams(location.search);
  let tutorialId = params.get("tutorial_id");

  const els = {
    authBox: document.getElementById("auth-box"),
    apiBase: document.getElementById("api-base"),
    email: document.getElementById("email"),
    password: document.getElementById("password"),
    loginBtn: document.getElementById("login-btn"),
    banner: document.getElementById("banner"),
    picker: document.getElementById("picker"),
    tutorialList: document.getElementById("tutorial-list"),
    editor: document.getElementById("editor"),
    title: document.getElementById("title"),
    description: document.getElementById("description"),
    steps: document.getElementById("steps"),
    saveDraft: document.getElementById("save-draft"),
    publish: document.getElementById("publish"),
    successDefinition: document.getElementById("success-definition"),
    verifyMode: document.getElementById("verify-mode"),
    urlContains: document.getElementById("url-contains"),
    manualFallback: document.getElementById("manual-fallback"),
    autofillCriteria: document.getElementById("autofill-criteria"),
    saveCriteria: document.getElementById("save-criteria"),
    attempts: document.getElementById("attempts"),
    refreshAttempts: document.getElementById("refresh-attempts"),
  };

  /** @type {{title: string, description: string|null, steps: any[]} | null} */
  let draft = null;
  /** @type {Record<string, string>} */
  let pathToUrl = {};

  function apiBase() {
    return (els.apiBase.value || "http://localhost:8000").replace(/\/$/, "");
  }

  function token() {
    return localStorage.getItem("sms_token");
  }

  function showBanner(message, isError = false) {
    els.banner.textContent = message;
    els.banner.classList.toggle("hidden", !message);
    els.banner.classList.toggle("error", Boolean(isError));
  }

  async function api(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (!(options.body instanceof FormData)) {
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

  function renderSteps() {
    els.steps.innerHTML = "";
    (draft.steps || []).forEach((step, index) => {
      const li = document.createElement("li");
      li.className = "step";
      li.dataset.index = String(index);

      const media = document.createElement("div");
      const url = step.screenshot_path
        ? pathToUrl[step.screenshot_path]
        : null;
      if (url) {
        const img = document.createElement("img");
        img.className = "shot";
        img.src = url;
        img.alt = `Screenshot for step ${index + 1}`;
        media.appendChild(img);
      } else {
        const fallback = document.createElement("div");
        fallback.className = "shot shot-fallback";
        fallback.textContent = "No screenshot";
        media.appendChild(fallback);
      }

      const body = document.createElement("div");
      body.className = "step-body";
      body.innerHTML = `
        <div class="step-head">
          <div class="step-num">Step ${index + 1}</div>
          <button type="button" class="danger remove" data-index="${index}">Remove</button>
        </div>
        <label>Title
          <input class="step-title" type="text" maxlength="200" value="${escapeAttr(step.title || "")}" />
        </label>
        <label>Explanation
          <textarea class="step-desc" rows="3">${escapeHtml(step.description || "")}</textarea>
        </label>
      `;

      li.appendChild(media);
      li.appendChild(body);
      els.steps.appendChild(li);
    });
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }

  function escapeAttr(value) {
    return escapeHtml(value).replaceAll('"', "&quot;");
  }

  function collectDraftFromDom() {
    draft.title = els.title.value.trim();
    draft.description = els.description.value.trim();
    const items = [...els.steps.querySelectorAll(".step")];
    draft.steps = items.map((li, order) => {
      const index = Number(li.dataset.index);
      const existing = draft.steps[index] || {};
      return {
        title: li.querySelector(".step-title").value.trim(),
        description: li.querySelector(".step-desc").value.trim(),
        order_index: order,
        screenshot_path: existing.screenshot_path || null,
        metadata: existing.metadata || {},
      };
    });
  }

  els.steps.addEventListener("click", (event) => {
    const btn = event.target.closest(".remove");
    if (!btn) return;
    collectDraftFromDom();
    const index = Number(btn.dataset.index);
    draft.steps.splice(index, 1);
    renderSteps();
  });

  async function loadTutorialList() {
    if (!token()) {
      showBanner("Log in to see your tutorials.");
      return;
    }
    showBanner("Loading your tutorials…");
    els.editor.classList.add("hidden");
    els.picker.classList.remove("hidden");
    els.authBox.classList.add("hidden");

    const data = await api("/api/tutorials");
    const items = data.items || [];
    if (!items.length) {
      els.tutorialList.innerHTML =
        `<p style="margin:0;color:var(--muted)">No tutorials yet. Record one with the Chrome extension first.</p>`;
      showBanner("No tutorials yet.");
      return;
    }

    els.tutorialList.innerHTML = "";
    items.forEach((t) => {
      const div = document.createElement("div");
      div.className = "attempt";
      const stepCount = (t.steps || []).length;
      const share = t.share_url
        ? `<div style="margin-top:4px;font-size:12px;color:var(--muted)">Share: ${escapeHtml(t.share_url)}</div>`
        : "";
      div.innerHTML = `
        <div class="attempt-head">
          <strong>${escapeHtml(t.title || "Untitled")}</strong>
          <span class="attempt-status ${escapeAttr(t.status || "draft")}">${escapeHtml(t.status || "draft")}</span>
        </div>
        <div style="color:var(--muted);font-size:13px">${stepCount} step(s)</div>
        ${share}
        <div class="attempt-actions">
          <a class="btn primary" style="text-decoration:none" href="/review/?tutorial_id=${encodeURIComponent(t.id)}">Open</a>
        </div>
      `;
      els.tutorialList.appendChild(div);
    });
    showBanner(`Found ${items.length} tutorial(s). Pick one to continue.`);
  }

  async function loadTutorial() {
    if (!tutorialId) {
      await loadTutorialList();
      return;
    }
    if (!token()) {
      showBanner("Log in to review this tutorial.");
      return;
    }

    showBanner("Loading draft…");
    els.picker.classList.add("hidden");
    const tutorial = await api(`/api/tutorials/${tutorialId}`);
    const media = await api(`/api/media/tutorial/${tutorialId}?media_type=screenshot`).catch(
      () => []
    );

    pathToUrl = {};
    for (const asset of media || []) {
      if (asset.file_path && asset.public_url) {
        pathToUrl[asset.file_path] = asset.public_url;
      } else if (asset.file_path) {
        try {
          const signed = await api(`/api/media/${asset.id}/signed-url?expires_in=86400`);
          pathToUrl[asset.file_path] = signed.signed_url;
        } catch {
          /* ignore */
        }
      }
    }

    draft = {
      title: tutorial.title || "",
      description: tutorial.description || "",
      steps: (tutorial.steps || []).map((s) => ({
        title: s.title,
        description: s.description || "",
        order_index: s.order_index,
        screenshot_path: s.screenshot_path,
        metadata: s.metadata || {},
      })),
    };

    els.title.value = draft.title;
    els.description.value = draft.description || "";
    fillCriteriaForm(tutorial.completion_criteria || {});
    renderSteps();
    els.editor.classList.remove("hidden");
    els.authBox.classList.add("hidden");
    showBanner(`Loaded “${draft.title}” — ${draft.steps.length} step(s). Edit, then save.`);
    await loadAttempts();
  }

  function fillCriteriaForm(criteria) {
    const ver = criteria.verification || {};
    const page = ver.page_check || {};
    els.successDefinition.value = criteria.success_definition || "";
    els.verifyMode.value = ver.mode || "steps_only";
    els.urlContains.value = page.url_contains || "";
    els.manualFallback.checked = ver.manual_review_fallback !== false;
  }

  function criteriaPayload() {
    const mode = els.verifyMode.value;
    return {
      success_definition: els.successDefinition.value.trim() || "Complete all steps",
      require_all_steps: true,
      required_step_indexes: null,
      verification: {
        mode,
        manual_review_fallback: els.manualFallback.checked,
        page_check:
          mode === "page_check"
            ? { url_contains: els.urlContains.value.trim() || null }
            : els.urlContains.value.trim()
              ? { url_contains: els.urlContains.value.trim() }
              : null,
        api: null,
        file:
          mode === "file"
            ? {
                required: true,
                allowed_types: ["image/png", "image/jpeg", "application/pdf"],
                max_bytes: 10000000,
              }
            : null,
      },
    };
  }

  async function loadAttempts() {
    if (!els.attempts) return;
    try {
      const data = await api(`/api/tutorials/${tutorialId}/attempts`);
      const items = data.items || [];
      if (!items.length) {
        els.attempts.innerHTML = `<p class="muted" style="margin:0;color:var(--muted)">No learner attempts yet.</p>`;
        return;
      }
      els.attempts.innerHTML = "";
      items.forEach((attempt) => {
        const div = document.createElement("div");
        div.className = "attempt";
        const summary =
          attempt.verification_result?.summary ||
          attempt.verification_result?.message ||
          "";
        div.innerHTML = `
          <div class="attempt-head">
            <span class="attempt-status ${attempt.status}">${attempt.status}</span>
            <span style="color:var(--muted);font-size:12px">${new Date(attempt.created_at).toLocaleString()}</span>
          </div>
          <div>${attempt.steps_completed}/${attempt.steps_total} steps · ${attempt.learner_label || attempt.learner_key.slice(0, 18)}</div>
          <div style="color:var(--muted);font-size:13px;margin-top:4px">${escapeHtml(summary)}</div>
          <div class="attempt-actions">
            <button type="button" class="primary pass" data-id="${attempt.id}">Mark passed</button>
            <button type="button" class="secondary retry" data-id="${attempt.id}">Needs retry</button>
          </div>
        `;
        els.attempts.appendChild(div);
      });
    } catch (err) {
      els.attempts.innerHTML = `<p style="color:var(--danger);margin:0">${escapeHtml(err.message)}</p>`;
    }
  }

  async function save(publish) {
    if (!draft) return;
    collectDraftFromDom();
    if (!draft.title) {
      showBanner("Title is required.", true);
      return;
    }
    if (!draft.steps.length) {
      showBanner("Add at least one step before saving.", true);
      return;
    }
    for (const step of draft.steps) {
      if (!step.title) {
        showBanner("Every step needs a title.", true);
        return;
      }
    }

    showBanner(publish ? "Publishing…" : "Saving draft…");
    const result = await api(`/api/tutorials/${tutorialId}/save`, {
      method: "PUT",
      body: JSON.stringify({
        title: draft.title,
        description: draft.description,
        steps: draft.steps,
        publish,
      }),
    });
    if (publish && result.share_url) {
      showBanner(`Published! Share: ${result.share_url}`);
    } else {
      showBanner(result.message || "Saved.");
    }
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
      await loadTutorial();
    } catch (err) {
      showBanner(err.message || String(err), true);
    }
  });

  els.saveDraft.addEventListener("click", () => {
    save(false).catch((err) => showBanner(err.message || String(err), true));
  });
  els.publish.addEventListener("click", () => {
    save(true).catch((err) => showBanner(err.message || String(err), true));
  });

  els.saveCriteria?.addEventListener("click", async () => {
    try {
      showBanner("Saving success criteria…");
      await api(`/api/tutorials/${tutorialId}/completion`, {
        method: "PUT",
        body: JSON.stringify(criteriaPayload()),
      });
      showBanner("Success criteria saved.");
    } catch (err) {
      showBanner(err.message || String(err), true);
    }
  });

  els.autofillCriteria?.addEventListener("click", async () => {
    try {
      showBanner("Auto-filling criteria from steps…");
      const tutorial = await api(`/api/tutorials/${tutorialId}/completion/autofill`, {
        method: "POST",
        body: "{}",
      });
      fillCriteriaForm(tutorial.completion_criteria || {});
      showBanner("Criteria auto-filled from the final step.");
    } catch (err) {
      showBanner(err.message || String(err), true);
    }
  });

  els.refreshAttempts?.addEventListener("click", () => {
    loadAttempts().catch((err) => showBanner(err.message || String(err), true));
  });

  els.attempts?.addEventListener("click", async (event) => {
    const passBtn = event.target.closest(".pass");
    const retryBtn = event.target.closest(".retry");
    const btn = passBtn || retryBtn;
    if (!btn) return;
    const id = btn.dataset.id;
    const status = passBtn ? "passed" : "needs_retry";
    try {
      await api(`/api/tutorials/${tutorialId}/attempts/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          status,
          reviewer_notes: status === "passed" ? "Approved by creator" : "Please try again",
        }),
      });
      showBanner(`Attempt marked ${status}.`);
      await loadAttempts();
    } catch (err) {
      showBanner(err.message || String(err), true);
    }
  });

  // Restore session
  const savedBase = localStorage.getItem("sms_api_base");
  if (savedBase) els.apiBase.value = savedBase;
  const savedEmail = localStorage.getItem("sms_email");
  if (savedEmail) els.email.value = savedEmail;

  if (token()) {
    loadTutorial().catch((err) => showBanner(err.message || String(err), true));
  } else {
    showBanner(
      tutorialId
        ? "Log in to review this tutorial."
        : "Log in to see your tutorials, or open a link like /review/?tutorial_id=…"
    );
  }
})();
