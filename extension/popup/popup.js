import { login } from "../lib/api.js";

const els = {
  authSection: document.getElementById("auth-section"),
  recordSection: document.getElementById("record-section"),
  apiBase: document.getElementById("api-base"),
  email: document.getElementById("email"),
  password: document.getElementById("password"),
  loginBtn: document.getElementById("login-btn"),
  logoutBtn: document.getElementById("logout-btn"),
  userEmail: document.getElementById("user-email"),
  tutorialTitle: document.getElementById("tutorial-title"),
  startBtn: document.getElementById("start-btn"),
  stopBtn: document.getElementById("stop-btn"),
  guideSlug: document.getElementById("guide-slug"),
  guideStartBtn: document.getElementById("guide-start-btn"),
  guideStopBtn: document.getElementById("guide-stop-btn"),
  statusText: document.getElementById("status-text"),
  counts: document.getElementById("counts"),
  error: document.getElementById("error"),
};

function showError(message) {
  if (!message) {
    els.error.classList.add("hidden");
    els.error.textContent = "";
    return;
  }
  els.error.textContent = message;
  els.error.classList.remove("hidden");
}

function parseSlug(input) {
  const raw = (input || "").trim();
  if (!raw) return "";
  try {
    if (raw.includes("/")) {
      const u = new URL(raw);
      const parts = u.pathname.split("/").filter(Boolean);
      const tIndex = parts.indexOf("t");
      if (tIndex >= 0 && parts[tIndex + 1]) return parts[tIndex + 1];
    }
  } catch {
    /* treat as slug */
  }
  return raw.replace(/^\/+/, "").split("/").pop();
}

async function loadStored() {
  const data = await chrome.storage.local.get([
    "apiBase",
    "accessToken",
    "userEmail",
    "lastTutorialTitle",
    "lastGuideSlug",
  ]);
  els.apiBase.value = data.apiBase || "http://localhost:8000";
  els.email.value = data.userEmail || "";
  els.tutorialTitle.value = data.lastTutorialTitle || "";
  els.guideSlug.value = data.lastGuideSlug || "";

  if (data.accessToken) {
    showLoggedIn(data.userEmail || "Signed in");
  } else {
    showLoggedOut();
  }
}

function showLoggedIn(email) {
  els.authSection.classList.add("hidden");
  els.recordSection.classList.remove("hidden");
  els.userEmail.textContent = email;
}

function showLoggedOut() {
  els.authSection.classList.remove("hidden");
  els.recordSection.classList.add("hidden");
  els.userEmail.textContent = "";
}

function setRecordingUi(recording) {
  els.startBtn.disabled = recording;
  els.stopBtn.disabled = !recording;
  els.tutorialTitle.disabled = recording;
  els.guideStartBtn.disabled = recording;
}

function setGuideUi(guiding) {
  els.guideStartBtn.disabled = Boolean(guiding);
  els.guideStopBtn.disabled = !guiding;
}

async function refreshState() {
  const state = await chrome.runtime.sendMessage({ type: "SMS_GET_STATE" });
  if (!state) return;

  if (state.guiding) {
    els.statusText.textContent =
      state.guideStatus ||
      `Guiding: step ${(state.guideStepIndex || 0) + 1}/${state.guideStepCount || "?"}`;
    els.counts.textContent = state.guideTitle
      ? `${state.guideTitle} · ${state.guideSlug || ""}`
      : state.guideSlug || "";
  } else if (state.recording) {
    els.statusText.textContent = state.statusMessage || "Recording…";
    const parts = [];
    if (state.actionCount) parts.push(`${state.actionCount} actions`);
    if (state.screenshotCount) parts.push(`${state.screenshotCount} screenshots`);
    els.counts.textContent = parts.join(" · ");
  } else {
    els.statusText.textContent = state.guideStatus || state.statusMessage || "Idle";
    els.counts.textContent = "";
  }

  setRecordingUi(Boolean(state.recording));
  setGuideUi(Boolean(state.guiding));
  if (state.recording) {
    els.guideStartBtn.disabled = true;
    els.guideStopBtn.disabled = true;
  }
}

els.loginBtn.addEventListener("click", async () => {
  showError("");
  els.loginBtn.disabled = true;
  try {
    const apiBase = els.apiBase.value.trim() || "http://localhost:8000";
    const email = els.email.value.trim();
    const password = els.password.value;
    if (!email || !password) {
      throw new Error("Email and password required");
    }
    const result = await login({ apiBase, email, password });
    await chrome.storage.local.set({
      apiBase,
      accessToken: result.access_token,
      refreshToken: result.refresh_token,
      userEmail: result.user?.email || email,
    });
    els.password.value = "";
    showLoggedIn(result.user?.email || email);
  } catch (err) {
    showError(err.message || String(err));
  } finally {
    els.loginBtn.disabled = false;
  }
});

els.logoutBtn.addEventListener("click", async () => {
  await chrome.storage.local.remove([
    "accessToken",
    "refreshToken",
    "userEmail",
  ]);
  showLoggedOut();
  showError("");
});

els.startBtn.addEventListener("click", async () => {
  showError("");
  els.startBtn.disabled = true;
  const title = els.tutorialTitle.value.trim();
  await chrome.storage.local.set({
    lastTutorialTitle: title,
    apiBase: els.apiBase.value.trim() || "http://localhost:8000",
  });
  try {
    const result = await chrome.runtime.sendMessage({
      type: "SMS_START_RECORDING",
      title,
    });
    if (!result?.ok) {
      throw new Error(result?.error || "Could not start recording");
    }
    await refreshState();
  } catch (err) {
    showError(err.message || String(err));
    setRecordingUi(false);
  }
});

els.stopBtn.addEventListener("click", async () => {
  showError("");
  els.stopBtn.disabled = true;
  els.statusText.textContent = "Uploading…";
  try {
    const result = await chrome.runtime.sendMessage({
      type: "SMS_STOP_RECORDING",
    });
    if (!result?.ok) {
      throw new Error(result?.error || "Could not stop recording");
    }
    els.statusText.textContent = `AI draft: ${result.stepCount} steps`;
    els.counts.textContent = `${result.actionCount} actions · ${result.screenshotCount} screenshots`;
    if (result.reviewUrl) {
      els.counts.textContent += " · review tab opened";
    }
    setRecordingUi(false);
  } catch (err) {
    showError(err.message || String(err));
    await refreshState();
  }
});

els.guideStartBtn.addEventListener("click", async () => {
  showError("");
  const slug = parseSlug(els.guideSlug.value);
  if (!slug) {
    showError("Paste a share link or slug first");
    return;
  }
  await chrome.storage.local.set({
    lastGuideSlug: els.guideSlug.value.trim(),
    apiBase: els.apiBase.value.trim() || "http://localhost:8000",
  });
  els.guideStartBtn.disabled = true;
  try {
    // Opens the tutorial website in a new tab, then starts highlighting
    const result = await chrome.runtime.sendMessage({
      type: "SMS_LAUNCH_GUIDE",
      slug,
    });
    if (!result?.ok) {
      throw new Error(result?.error || "Could not start guide");
    }
    await refreshState();
    window.close();
  } catch (err) {
    showError(err.message || String(err));
    setGuideUi(false);
  }
});

els.guideStopBtn.addEventListener("click", async () => {
  showError("");
  await chrome.runtime.sendMessage({ type: "SMS_STOP_GUIDE" });
  await refreshState();
});

els.apiBase.addEventListener("change", async () => {
  await chrome.storage.local.set({
    apiBase: els.apiBase.value.trim() || "http://localhost:8000",
  });
});

loadStored().then(refreshState);
setInterval(refreshState, 1000);
