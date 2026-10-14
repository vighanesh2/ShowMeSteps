import {
  completeAttempt,
  createTutorial,
  dataUrlToBlob,
  fetchPublicTutorial,
  generateTutorial,
  helpAsk,
  helpMistake,
  helpRecover,
  logFriction,
  startAttempt,
  uploadAttemptEvidence,
  uploadMedia,
} from "../lib/api.js";

/** @typedef {{
 *  recording: boolean,
 *  tutorialId: string | null,
 *  tutorialTitle: string | null,
 *  tabId: number | null,
 *  startedAt: number | null,
 *  actions: object[],
 *  screenshots: { actionIndex: number, dataUrl: string }[],
 *  statusMessage: string,
 * }} SessionState */

/** @typedef {{
 *  active: boolean,
 *  slug: string | null,
 *  tabId: number | null,
 *  stepIndex: number,
 *  tutorial: object | null,
 *  statusMessage: string,
 *  attemptId: string | null,
 *  learnerKey: string | null,
 *  completedStepIndexes: number[],
 *  lastVerification: object | null,
 * }} GuideState */

/** @type {SessionState} */
let session = emptySession();

/** @type {GuideState} */
let guide = emptyGuide();

function emptySession() {
  return {
    recording: false,
    tutorialId: null,
    tutorialTitle: null,
    tabId: null,
    startedAt: null,
    actions: [],
    screenshots: [],
    statusMessage: "Idle",
  };
}

function emptyGuide() {
  return {
    active: false,
    slug: null,
    tabId: null,
    stepIndex: 0,
    tutorial: null,
    statusMessage: "Idle",
    attemptId: null,
    learnerKey: null,
    completedStepIndexes: [],
    lastVerification: null,
  };
}

async function getLearnerKey() {
  const stored = await chrome.storage.local.get(["learnerKey"]);
  if (stored.learnerKey) return stored.learnerKey;
  const key = `learner-${crypto.randomUUID()}`;
  await chrome.storage.local.set({ learnerKey: key });
  return key;
}

async function loadAuth() {
  const data = await chrome.storage.local.get([
    "apiBase",
    "accessToken",
    "userEmail",
  ]);
  return {
    apiBase: data.apiBase || "http://localhost:8000",
    token: data.accessToken || null,
    email: data.userEmail || null,
  };
}

async function persistSessionSummary() {
  await chrome.storage.session.set({
    smsRecording: session.recording,
    smsActionCount: session.actions.length,
    smsTutorialId: session.tutorialId,
    smsStatus: session.statusMessage,
    smsGuiding: guide.active,
    smsGuideStep: guide.stepIndex,
    smsGuideSlug: guide.slug,
    smsGuideStatus: guide.statusMessage,
  });
}

function stripGuideParams(url) {
  try {
    const u = new URL(url);
    u.searchParams.delete("sms_guide");
    u.searchParams.delete("sms_step");
    return u.toString();
  } catch {
    return url;
  }
}

async function ensureGuideScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "SMS_GUIDE_PING" });
    return true;
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content/guide.js"],
      });
      return true;
    } catch (err) {
      console.warn("Could not inject guide", err);
      return false;
    }
  }
}

async function pushCurrentGuideStep() {
  if (!guide.active || guide.tabId == null || !guide.tutorial) return;
  const steps = guide.tutorial.steps || [];
  if (guide.stepIndex >= steps.length) {
    await finishGuide(true);
    return;
  }
  const step = steps[guide.stepIndex];
  await ensureGuideScript(guide.tabId);
  try {
    await chrome.tabs.sendMessage(guide.tabId, {
      type: "SMS_GUIDE_SHOW_STEP",
      step,
      stepIndex: guide.stepIndex,
      stepCount: steps.length,
      tutorialTitle: guide.tutorial.title,
    });
  } catch (err) {
    console.warn("Failed to show guide step", err);
  }
  guide.statusMessage = `Step ${guide.stepIndex + 1}/${steps.length}`;
  chrome.action.setBadgeText({ text: String(guide.stepIndex + 1) });
  chrome.action.setBadgeBackgroundColor({ color: "#0F6E56" });
  await persistSessionSummary();
}

function pickLaunchUrl(tutorial) {
  if (tutorial?.start_url) return tutorial.start_url;
  const steps = tutorial?.steps || [];
  for (const step of steps) {
    const meta = step.metadata || {};
    for (const key of ["to", "url", "from"]) {
      const value = meta[key];
      if (typeof value === "string" && value.startsWith("http")) return value;
    }
  }
  return null;
}

async function waitForTabComplete(tabId, timeoutMs = 20000) {
  const existing = await chrome.tabs.get(tabId);
  if (existing.status === "complete") return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("Timed out waiting for page load"));
    }, timeoutMs);

    function onUpdated(id, info) {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function startGuide({ slug, tabId, stepIndex = 0 }) {
  if (session.recording) {
    throw new Error("Stop recording before starting a guide");
  }
  const auth = await loadAuth();
  const tutorial = await fetchPublicTutorial({
    apiBase: auth.apiBase,
    slug,
  });
  if (!tutorial.steps?.length) {
    throw new Error("This tutorial has no steps yet");
  }

  let targetTabId = tabId;
  if (targetTabId == null) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    targetTabId = tab?.id ?? null;
  }
  if (targetTabId == null) {
    throw new Error("No tab available for guiding");
  }

  const learnerKey = await getLearnerKey();
  let attemptId = null;
  try {
    const attempt = await startAttempt({
      apiBase: auth.apiBase,
      slug,
      learnerKey,
    });
    attemptId = attempt.id;
  } catch (err) {
    console.warn("Could not start attempt record", err);
  }

  guide = {
    active: true,
    slug,
    tabId: targetTabId,
    stepIndex: Math.max(0, Math.min(stepIndex, tutorial.steps.length - 1)),
    tutorial,
    statusMessage: "Guiding…",
    attemptId,
    learnerKey,
    completedStepIndexes: [],
    lastVerification: null,
  };
  await persistSessionSummary();
  await pushCurrentGuideStep();
  return {
    slug,
    title: tutorial.title,
    stepIndex: guide.stepIndex,
    stepCount: tutorial.steps.length,
    attemptId,
  };
}

/**
 * Open the tutorial site in a new tab and start guiding (no query-param hack).
 */
async function launchGuideFromShare(slug) {
  if (session.recording) {
    throw new Error("Stop recording before starting a guide");
  }
  const auth = await loadAuth();
  const tutorial = await fetchPublicTutorial({
    apiBase: auth.apiBase,
    slug,
  });
  const launchUrl = pickLaunchUrl(tutorial);
  if (!launchUrl) {
    throw new Error(
      "This tutorial has no website URL. Open the site manually, then use Start Guide in the popup."
    );
  }

  const tab = await chrome.tabs.create({ url: launchUrl, active: true });
  await waitForTabComplete(tab.id);
  return startGuide({ slug, tabId: tab.id, stepIndex: 0 });
}

async function advanceGuide(reason = "auto") {
  if (!guide.active || !guide.tutorial) return;
  const finishedIndex = guide.stepIndex;
  if (!guide.completedStepIndexes.includes(finishedIndex)) {
    guide.completedStepIndexes.push(finishedIndex);
  }
  guide.stepIndex += 1;
  if (guide.stepIndex >= (guide.tutorial.steps || []).length) {
    const verification = await verifyAndFinish();
    return { done: true, reason, verification };
  }
  await pushCurrentGuideStep();
  return { done: false, stepIndex: guide.stepIndex, reason };
}

async function collectPageEvidence() {
  if (guide.tabId == null) return { url: null };
  const criteria = guide.tutorial?.completion_criteria?.verification?.page_check || {};
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: guide.tabId },
      args: [criteria],
      func: (pageCheck) => {
        const evidence = {
          url: location.href,
          title: document.title,
          selector_exists: null,
          selector_text: null,
        };
        if (pageCheck?.selector_exists) {
          try {
            const el = document.querySelector(pageCheck.selector_exists);
            evidence.selector_exists = Boolean(el);
            evidence.selector_text = el
              ? (el.innerText || el.textContent || el.getAttribute("aria-label") || "").slice(0, 200)
              : "";
          } catch {
            evidence.selector_exists = false;
          }
        } else if (pageCheck?.selector_text_contains) {
          evidence.selector_text = (document.body?.innerText || "").slice(0, 5000);
          evidence.selector_exists = true;
        }
        return evidence;
      },
    });
    return result || { url: null };
  } catch (err) {
    console.warn("Page evidence failed", err);
    try {
      const tab = await chrome.tabs.get(guide.tabId);
      return { url: tab.url, title: tab.title };
    } catch {
      return { url: null };
    }
  }
}

async function verifyAndFinish() {
  const auth = await loadAuth();
  let verification = null;
  if (guide.attemptId && guide.slug) {
    try {
      const pageEvidence = await collectPageEvidence();
      const result = await completeAttempt({
        apiBase: auth.apiBase,
        slug: guide.slug,
        attemptId: guide.attemptId,
        completedStepIndexes: guide.completedStepIndexes,
        pageEvidence,
      });
      verification = result.verification;
      guide.lastVerification = {
        ...result.verification,
        message: result.message,
        attempt: result.attempt,
        slug: guide.slug,
        completedStepIndexes: [...guide.completedStepIndexes],
      };
    } catch (err) {
      console.warn("Verification submit failed", err);
      verification = {
        status: "needs_retry",
        summary: err?.message || "Could not verify completion",
        passed: false,
      };
      guide.lastVerification = verification;
    }
  }

  const lastVerification = guide.lastVerification;
  const successDefinition =
    guide.tutorial?.completion_criteria?.success_definition || "Complete all steps";
  const resultTabId = guide.tabId;

  if (resultTabId != null) {
    try {
      await chrome.tabs.sendMessage(resultTabId, {
        type: "SMS_GUIDE_RESULT",
        verification: lastVerification,
        successDefinition,
      });
    } catch {
      /* ignore */
    }
  }

  const status = verification?.status || (verification?.passed ? "passed" : "needs_retry");
  guide = {
    ...emptyGuide(),
    statusMessage:
      status === "passed"
        ? "Passed!"
        : status === "pending_review"
          ? "Pending review"
          : "Needs another attempt",
    lastVerification,
  };
  chrome.action.setBadgeText({ text: status === "passed" ? "OK" : "!" });
  chrome.action.setBadgeBackgroundColor({
    color: status === "passed" ? "#0F6E56" : "#C0392B",
  });
  await persistSessionSummary();
  return verification;
}

async function finishGuide(completed) {
  if (completed) {
    return verifyAndFinish();
  }
  if (guide.tabId != null) {
    try {
      await chrome.tabs.sendMessage(guide.tabId, { type: "SMS_GUIDE_TEARDOWN" });
    } catch {
      /* ignore */
    }
  }
  guide = {
    ...emptyGuide(),
    statusMessage: "Guide stopped",
  };
  chrome.action.setBadgeText({ text: "" });
  await persistSessionSummary();
}

function stepUrl(step) {
  const meta = step?.metadata || {};
  for (const key of ["url", "to", "from"]) {
    const value = meta[key];
    if (typeof value === "string" && value.startsWith("http")) return value;
  }
  return null;
}

async function handleMistakeHelp(message) {
  const auth = await loadAuth();
  const step = message.step || guide.tutorial?.steps?.[guide.stepIndex];
  if (!step) throw new Error("No active step");
  const stepIndex =
    typeof message.stepIndex === "number" ? message.stepIndex : guide.stepIndex;

  if (guide.attemptId && guide.slug && guide.learnerKey) {
    try {
      await logFriction({
        apiBase: auth.apiBase,
        slug: guide.slug,
        attemptId: guide.attemptId,
        learnerKey: guide.learnerKey,
        stepIndex,
        mistakeType: message.mistakeType || "wrong_click",
        clickedSummary: message.clickedSummary,
      });
    } catch (err) {
      console.warn("Friction log failed", err);
    }
  }

  const result = await helpMistake({
    apiBase: auth.apiBase,
    body: {
      tutorial_title: message.tutorialTitle || guide.tutorial?.title,
      step: {
        title: step.title,
        description: step.description,
        metadata: step.metadata || {},
      },
      mistake_type: message.mistakeType || "wrong_click",
      clicked_summary: message.clickedSummary,
      current_url: message.currentUrl,
    },
  });
  guide.statusMessage = "Helping with a mistake";
  await persistSessionSummary();
  return result;
}

async function handleAskHelp(message) {
  const auth = await loadAuth();
  const step = message.step || guide.tutorial?.steps?.[guide.stepIndex];
  if (!step) throw new Error("No active step");
  return helpAsk({
    apiBase: auth.apiBase,
    body: {
      tutorial_title: message.tutorialTitle || guide.tutorial?.title,
      step: {
        title: step.title,
        description: step.description,
        metadata: step.metadata || {},
      },
      question: message.question,
      current_url: message.currentUrl,
    },
  });
}

async function handleRecoverHelp(message) {
  const auth = await loadAuth();
  const step = message.step || guide.tutorial?.steps?.[guide.stepIndex];
  if (!step) throw new Error("No active step");

  const result = await helpRecover({
    apiBase: auth.apiBase,
    body: {
      tutorial_title: message.tutorialTitle || guide.tutorial?.title,
      step: {
        title: step.title,
        description: step.description,
        metadata: step.metadata || {},
      },
      current_url: message.currentUrl,
    },
  });

  const targetUrl = result.recovery_url || stepUrl(step);
  let navigated = false;
  if (targetUrl && guide.tabId != null) {
    try {
      const current = await chrome.tabs.get(guide.tabId);
      const same =
        current.url &&
        new URL(current.url).origin === new URL(targetUrl).origin &&
        new URL(current.url).pathname.replace(/\/$/, "") ===
          new URL(targetUrl).pathname.replace(/\/$/, "");
      if (!same) {
        await chrome.tabs.update(guide.tabId, { url: targetUrl });
        await waitForTabComplete(guide.tabId);
        navigated = true;
      }
    } catch (err) {
      console.warn("Recovery navigation failed", err);
    }
  }

  if (guide.tabId != null) {
    await ensureGuideScript(guide.tabId);
    await pushCurrentGuideStep();
    try {
      await chrome.tabs.sendMessage(guide.tabId, { type: "SMS_GUIDE_REHIGHLIGHT" });
    } catch {
      /* ignore */
    }
  }

  guide.statusMessage = "Recovering…";
  await persistSessionSummary();
  return { ...result, navigated, recovery_url: targetUrl };
}

function parseGuideFromUrl(url) {
  try {
    const u = new URL(url);
    const slug = u.searchParams.get("sms_guide");
    if (!slug) return null;
    const step = Number(u.searchParams.get("sms_step") || "0");
    return { slug, stepIndex: Number.isFinite(step) ? step : 0, cleanUrl: stripGuideParams(url) };
  } catch {
    return null;
  }
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "SMS_PING" });
    return true;
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content/recorder.js"],
      });
      return true;
    } catch (err) {
      console.warn("Could not inject recorder", err);
      return false;
    }
  }
}

async function captureScreenshot(tabId, actionIndex) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "SMS_MASK_FOR_SCREENSHOT" });
  } catch {
    /* page may not have script yet */
  }

  // Brief delay so masking paints
  await new Promise((r) => setTimeout(r, 80));

  try {
    const tab = await chrome.tabs.get(tabId);
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: "png",
    });
    session.screenshots.push({ actionIndex, dataUrl });
    session.actions[actionIndex].screenshotIndex =
      session.screenshots.length - 1;
  } catch (err) {
    console.warn("Screenshot failed", err);
  }
}

/**
 * @param {object} action
 * @param {number} [tabId]
 */
async function handleAction(action, tabId) {
  if (!session.recording) return;
  if (session.tabId != null && tabId != null && tabId !== session.tabId) {
    // Only record the tab we started on (plus its navigations)
    return;
  }

  const index = session.actions.length;
  session.actions.push({ ...action, screenshotIndex: null });
  session.statusMessage = `Recorded ${session.actions.length} action(s)`;
  await persistSessionSummary();

  if (action.important && session.tabId != null) {
    await captureScreenshot(session.tabId, index);
  }
}

async function startRecording({ title }) {
  if (session.recording) {
    throw new Error("Already recording");
  }

  const auth = await loadAuth();
  if (!auth.token) {
    throw new Error("Log in first");
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error("No active tab");
  }
  if (!tab.url || tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-extension://")) {
    throw new Error("Cannot record on this page. Open a normal website tab.");
  }

  const tutorialTitle =
    title?.trim() || `Tutorial ${new Date().toLocaleString()}`;

  session.statusMessage = "Creating tutorial…";
  await persistSessionSummary();

  const tutorial = await createTutorial({
    apiBase: auth.apiBase,
    token: auth.token,
    title: tutorialTitle,
  });

  session = {
    recording: true,
    tutorialId: tutorial.id,
    tutorialTitle: tutorial.title,
    tabId: tab.id,
    startedAt: Date.now(),
    actions: [],
    screenshots: [],
    statusMessage: "Recording…",
  };
  await persistSessionSummary();

  await ensureContentScript(tab.id);
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "SMS_START" });
  } catch {
    /* freshly injected script already starts recording */
  }

  chrome.action.setBadgeText({ text: "REC" });
  chrome.action.setBadgeBackgroundColor({ color: "#C0392B" });

  return {
    tutorialId: session.tutorialId,
    title: session.tutorialTitle,
  };
}

async function stopRecording() {
  if (!session.recording) {
    throw new Error("Not recording");
  }

  const snapshot = session;
  session = {
    ...emptySession(),
    statusMessage: "Uploading…",
  };
  await persistSessionSummary();

  chrome.action.setBadgeText({ text: "" });

  if (snapshot.tabId != null) {
    try {
      await chrome.tabs.sendMessage(snapshot.tabId, { type: "SMS_STOP" });
    } catch {
      /* tab may be closed */
    }
  }

  const auth = await loadAuth();
  if (!auth.token || !snapshot.tutorialId) {
    throw new Error("Missing auth or tutorial");
  }

  const recordingPayload = {
    version: 1,
    tutorialId: snapshot.tutorialId,
    title: snapshot.tutorialTitle,
    startedAt: snapshot.startedAt,
    endedAt: Date.now(),
    actions: snapshot.actions,
  };

  const recordingBlob = new Blob([JSON.stringify(recordingPayload, null, 2)], {
    type: "application/json",
  });

  await uploadMedia({
    apiBase: auth.apiBase,
    token: auth.token,
    tutorialId: snapshot.tutorialId,
    mediaType: "recording",
    blob: recordingBlob,
    fileName: `recording-${snapshot.tutorialId}.json`,
    metadata: {
      actionCount: snapshot.actions.length,
      screenshotCount: snapshot.screenshots.length,
      source: "chrome-extension",
    },
  });

  for (let i = 0; i < snapshot.screenshots.length; i += 1) {
    const shot = snapshot.screenshots[i];
    const blob = dataUrlToBlob(shot.dataUrl);
    await uploadMedia({
      apiBase: auth.apiBase,
      token: auth.token,
      tutorialId: snapshot.tutorialId,
      mediaType: "screenshot",
      blob,
      fileName: `step-${shot.actionIndex}-${i}.png`,
      metadata: {
        actionIndex: shot.actionIndex,
        kind: snapshot.actions[shot.actionIndex]?.kind,
      },
    });
  }

  session.statusMessage = "Generating tutorial with AI…";
  await persistSessionSummary();

  const generated = await generateTutorial({
    apiBase: auth.apiBase,
    token: auth.token,
    tutorialId: snapshot.tutorialId,
    actions: snapshot.actions,
  });

  const reviewUrl =
    generated.review_url ||
    `${auth.apiBase.replace(/\/$/, "")}/review/?tutorial_id=${snapshot.tutorialId}`;

  try {
    await chrome.tabs.create({ url: reviewUrl });
  } catch {
    /* popup may still show the link */
  }

  session.statusMessage = `AI draft ready (${generated.steps?.length || 0} steps)`;
  await persistSessionSummary();

  return {
    tutorialId: snapshot.tutorialId,
    actionCount: snapshot.actions.length,
    stepCount: generated.steps?.length || 0,
    screenshotCount: snapshot.screenshots.length,
    reviewUrl,
    title: generated.title,
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message?.type === "SMS_ACTION") {
      await handleAction(message.action, sender.tab?.id);
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === "SMS_GET_STATE") {
      sendResponse({
        recording: session.recording,
        tutorialId: session.tutorialId,
        tutorialTitle: session.tutorialTitle,
        actionCount: session.actions.length,
        screenshotCount: session.screenshots.length,
        statusMessage: session.statusMessage,
        guiding: guide.active,
        guideSlug: guide.slug,
        guideStepIndex: guide.stepIndex,
        guideStepCount: guide.tutorial?.steps?.length || 0,
        guideTitle: guide.tutorial?.title || null,
        guideStatus: guide.statusMessage,
      });
      return;
    }
    if (message?.type === "SMS_START_RECORDING") {
      const result = await startRecording({ title: message.title });
      sendResponse({ ok: true, ...result });
      return;
    }
    if (message?.type === "SMS_STOP_RECORDING") {
      const result = await stopRecording();
      sendResponse({ ok: true, ...result });
      return;
    }
    if (message?.type === "SMS_START_GUIDE") {
      const result = await startGuide({
        slug: message.slug,
        tabId: message.tabId,
        stepIndex: message.stepIndex || 0,
      });
      sendResponse({ ok: true, ...result });
      return;
    }
    if (message?.type === "SMS_LAUNCH_GUIDE") {
      const result = await launchGuideFromShare(message.slug);
      sendResponse({ ok: true, ...result });
      return;
    }
    if (message?.type === "SMS_STOP_GUIDE") {
      await finishGuide(false);
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === "SMS_GUIDE_STEP_COMPLETE") {
      const result = await advanceGuide(message.reason || "auto");
      sendResponse({ ok: true, ...result });
      return;
    }
    if (message?.type === "SMS_GUIDE_STOP") {
      await finishGuide(false);
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === "SMS_GUIDE_READY") {
      if (guide.active && sender.tab?.id === guide.tabId) {
        await pushCurrentGuideStep();
      }
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === "SMS_GUIDE_MISTAKE") {
      const result = await handleMistakeHelp(message);
      sendResponse({ ok: true, ...result });
      return;
    }
    if (message?.type === "SMS_GUIDE_ASK") {
      const result = await handleAskHelp(message);
      sendResponse({ ok: true, ...result });
      return;
    }
    if (message?.type === "SMS_GUIDE_RECOVER") {
      const result = await handleRecoverHelp(message);
      sendResponse({ ok: true, ...result });
      return;
    }
    if (message?.type === "SMS_GUIDE_REQUEST_REVIEW") {
      const auth = await loadAuth();
      const snap = guide.lastVerification || {};
      const attemptId = message.attemptId || snap.attempt?.id || guide.attemptId;
      const resolvedSlug = message.slug || snap.slug || guide.slug;
      if (!attemptId || !resolvedSlug) {
        throw new Error("No attempt to submit for review");
      }
      const result = await completeAttempt({
        apiBase: auth.apiBase,
        slug: resolvedSlug,
        attemptId,
        completedStepIndexes:
          message.completedStepIndexes || snap.completedStepIndexes || [],
        requestManualReview: true,
        notes: message.notes || "Learner requested manual review",
      });
      guide.lastVerification = {
        ...result.verification,
        message: result.message,
        attempt: result.attempt,
        slug: resolvedSlug,
        completedStepIndexes:
          message.completedStepIndexes || snap.completedStepIndexes || [],
      };
      guide.statusMessage = "Pending review";
      await persistSessionSummary();
      sendResponse({ ok: true, ...result });
      return;
    }
    if (message?.type === "SMS_GUIDE_UPLOAD_EVIDENCE") {
      const auth = await loadAuth();
      const attemptId = message.attemptId || guide.attemptId;
      const slug = message.slug || guide.slug;
      const learnerKey = guide.learnerKey || (await getLearnerKey());
      if (!attemptId || !slug) throw new Error("No active attempt for evidence");
      const blob = await (await fetch(message.dataUrl)).blob();
      const result = await uploadAttemptEvidence({
        apiBase: auth.apiBase,
        slug,
        attemptId,
        learnerKey,
        blob,
        fileName: message.fileName || "evidence.png",
      });
      sendResponse({ ok: true, attempt: result });
      return;
    }
  })().catch((err) => {
    sendResponse({ ok: false, error: err?.message || String(err) });
  });
  return true;
});

// Re-inject recorder after full navigations in the recorded tab
chrome.webNavigation.onCompleted.addListener(async (details) => {
  if (details.frameId !== 0) return;

  // Launch from share link: ?sms_guide=slug
  const parsed = parseGuideFromUrl(details.url);
  if (parsed) {
    try {
      await startGuide({
        slug: parsed.slug,
        tabId: details.tabId,
        stepIndex: parsed.stepIndex,
      });
      await chrome.scripting.executeScript({
        target: { tabId: details.tabId },
        func: () => {
          const u = new URL(location.href);
          u.searchParams.delete("sms_guide");
          u.searchParams.delete("sms_step");
          history.replaceState(null, "", u.toString());
        },
      });
    } catch (err) {
      console.warn("Auto-start guide failed", err);
    }
    return;
  }

  if (guide.active && details.tabId === guide.tabId) {
    await ensureGuideScript(details.tabId);
    await pushCurrentGuideStep();
    return;
  }

  if (!session.recording || details.tabId !== session.tabId) return;
  await ensureContentScript(details.tabId);

  session.actions.push({
    kind: "navigation",
    important: true,
    from: null,
    to: details.url,
    url: details.url,
    title: null,
    timestamp: Date.now(),
    element: null,
    screenshotIndex: null,
  });
  const index = session.actions.length - 1;
  session.statusMessage = `Recorded ${session.actions.length} action(s)`;
  await persistSessionSummary();
  await captureScreenshot(details.tabId, index);
});

persistSessionSummary();
