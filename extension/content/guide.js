/**
 * Interactive guide: highlight, detect mistakes, AI help, recovery.
 */
(() => {
  if (window.__showMeStepsGuideInstalled) {
    chrome.runtime.sendMessage({ type: "SMS_GUIDE_READY" });
    return;
  }
  window.__showMeStepsGuideInstalled = true;

  const ROOT_ID = "showmesteps-guide-root";
  /** @type {any} */
  let currentStep = null;
  let stepIndex = 0;
  let stepCount = 0;
  let tutorialTitle = "";
  let completed = false;
  let advancing = false;
  let helping = false;
  /** @type {MutationObserver | null} */
  let observer = null;
  let findTimer = null;
  let pageCheckTimer = null;
  let wrongClickCooldown = 0;

  function ensureUi() {
    let root = document.getElementById(ROOT_ID);
    if (root) return root;

    root = document.createElement("div");
    root.id = ROOT_ID;
    root.innerHTML = `
      <style>
        #${ROOT_ID} { all: initial; }
        #${ROOT_ID} * { box-sizing: border-box; font-family: "Segoe UI", "Avenir Next", sans-serif; }
        #sms-highlight {
          position: fixed; z-index: 2147483646; pointer-events: none;
          border: 3px solid #0f6e56; border-radius: 10px;
          box-shadow: 0 0 0 9999px rgba(17, 14, 10, 0.45), 0 0 0 4px rgba(15,110,86,0.25);
          transition: all 0.18s ease;
        }
        #sms-highlight.sms-pulse {
          animation: smsPulse 0.9s ease 2;
          border-color: #c0392b;
          box-shadow: 0 0 0 9999px rgba(17, 14, 10, 0.5), 0 0 0 6px rgba(192,57,43,0.35);
        }
        @keyframes smsPulse {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.02); }
        }
        #sms-box {
          position: fixed; z-index: 2147483647; right: 16px; bottom: 16px;
          width: min(360px, calc(100vw - 24px));
          background: #fffdf8; color: #1a1712;
          border: 1px solid #d9cfbf; border-radius: 16px;
          box-shadow: 0 16px 40px rgba(0,0,0,0.18);
          padding: 14px 14px 12px;
          max-height: min(70vh, 520px);
          overflow: auto;
        }
        #sms-box .eyebrow { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: #0f6e56; font-weight: 700; margin-bottom: 4px; }
        #sms-box h2 { margin: 0; font-size: 16px; line-height: 1.25; }
        #sms-box p { margin: 8px 0 0; font-size: 13px; color: #6b6458; line-height: 1.4; }
        #sms-box .row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
        #sms-box button, #sms-box .btn {
          border: 0; border-radius: 999px; padding: 8px 12px; cursor: pointer;
          font: 600 12px/1 "Segoe UI", sans-serif;
        }
        #sms-box .primary { background: #0f6e56; color: #eef8f3; }
        #sms-box .ghost { background: transparent; color: #6b6458; border: 1px solid #d9cfbf; }
        #sms-box .warn { background: #c0392b; color: #fff; }
        #sms-box .done { color: #0f6e56; font-weight: 650; margin-top: 8px; }
        #sms-mistake {
          margin-top: 10px; padding: 10px; border-radius: 12px;
          background: #fdeceb; border: 1px solid #f0c2bc; color: #7a1f16;
        }
        #sms-mistake[hidden], #sms-ask-panel[hidden], #sms-ai-reply[hidden], #sms-done[hidden] { display: none !important; }
        #sms-mistake strong { display: block; margin-bottom: 4px; }
        #sms-ask-panel { margin-top: 10px; display: grid; gap: 8px; }
        #sms-ask-input {
          width: 100%; border: 1px solid #d9cfbf; border-radius: 10px;
          padding: 8px 10px; font: 13px/1.3 "Segoe UI", sans-serif; color: #1a1712;
          background: #fff;
        }
        #sms-ai-reply {
          margin-top: 8px; padding: 10px; border-radius: 12px;
          background: #e8f4ee; border: 1px solid #c6e2d6; color: #0f6e56;
          font-size: 13px; line-height: 1.4;
        }
        #sms-result {
          margin-top: 10px; padding: 10px; border-radius: 12px;
          border: 1px solid #c6e2d6; background: #e8f4ee; color: #0f6e56;
          font-size: 13px; line-height: 1.4;
        }
        #sms-result.fail {
          background: #fdeceb; border-color: #f0c2bc; color: #7a1f16;
        }
        #sms-result[hidden] { display: none !important; }
        #sms-result-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
      </style>
      <div id="sms-highlight" hidden></div>
      <div id="sms-box" hidden>
        <div class="eyebrow"><span id="sms-progress"></span></div>
        <h2 id="sms-title"></h2>
        <p id="sms-desc"></p>
        <div id="sms-done" class="done" hidden>Nice — moving on…</div>
        <div id="sms-mistake" hidden>
          <strong id="sms-mistake-title">Not quite</strong>
          <div id="sms-mistake-body"></div>
        </div>
        <div id="sms-ai-reply" hidden></div>
        <div id="sms-result" hidden>
          <strong id="sms-result-title"></strong>
          <div id="sms-result-body"></div>
          <div id="sms-result-actions">
            <button type="button" class="primary" id="sms-review">Request review</button>
            <button type="button" class="ghost" id="sms-close-result">Close</button>
          </div>
        </div>
        <div id="sms-ask-panel" hidden>
          <input id="sms-ask-input" type="text" maxlength="500" placeholder="Ask about this step…" />
          <div class="row" style="margin-top:0">
            <button type="button" class="primary" id="sms-ask-send">Ask AI</button>
            <button type="button" class="ghost" id="sms-ask-cancel">Cancel</button>
          </div>
        </div>
        <div class="row">
          <button type="button" class="primary" id="sms-next">I did this</button>
          <button type="button" class="ghost" id="sms-ask">Ask AI</button>
          <button type="button" class="ghost" id="sms-recover">Get me back</button>
          <button type="button" class="ghost" id="sms-skip">Skip</button>
          <button type="button" class="ghost" id="sms-exit">Exit</button>
        </div>
      </div>
    `;
    document.documentElement.appendChild(root);

    root.querySelector("#sms-next").addEventListener("click", () => completeStep("manual"));
    root.querySelector("#sms-skip").addEventListener("click", () => completeStep("skip"));
    root.querySelector("#sms-exit").addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "SMS_GUIDE_STOP" });
      teardown();
    });
    root.querySelector("#sms-ask").addEventListener("click", () => {
      document.getElementById("sms-ask-panel").hidden = false;
      document.getElementById("sms-ask-input").focus();
    });
    root.querySelector("#sms-ask-cancel").addEventListener("click", () => {
      document.getElementById("sms-ask-panel").hidden = true;
    });
    root.querySelector("#sms-ask-send").addEventListener("click", () => askAi());
    root.querySelector("#sms-ask-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") askAi();
    });
    root.querySelector("#sms-recover").addEventListener("click", () => recover());
    root.querySelector("#sms-review").addEventListener("click", async () => {
      const btn = root.querySelector("#sms-review");
      btn.disabled = true;
      btn.textContent = "Submitting…";
      try {
        const result = await chrome.runtime.sendMessage({
          type: "SMS_GUIDE_REQUEST_REVIEW",
          notes: "Learner requested manual review from guide overlay",
        });
        if (result?.ok) {
          showResultUI({
            status: "pending_review",
            headline: "Submitted for review",
            body: result.message || "A creator will check your attempt.",
            showReview: false,
          });
        } else {
          btn.textContent = "Request review";
          btn.disabled = false;
          showAiReply(result?.error || "Could not submit for review");
        }
      } catch (err) {
        btn.textContent = "Request review";
        btn.disabled = false;
      }
    });
    root.querySelector("#sms-close-result").addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "SMS_GUIDE_STOP" });
      teardown();
    });

    return root;
  }

  function showResultUI({ status, headline, body, showReview = true }) {
    ensureUi();
    const panel = document.getElementById("sms-result");
    panel.hidden = false;
    panel.classList.toggle("fail", status !== "passed" && status !== "pending_review");
    document.getElementById("sms-result-title").textContent = headline;
    document.getElementById("sms-result-body").textContent = body;
    document.getElementById("sms-review").style.display =
      showReview && status !== "passed" ? "" : "none";
    // Hide guiding controls after result
    document.getElementById("sms-next").style.display = "none";
    document.getElementById("sms-ask").style.display = "none";
    document.getElementById("sms-recover").style.display = "none";
    document.getElementById("sms-skip").style.display = "none";
  }

  function teardown() {
    completed = true;
    if (observer) observer.disconnect();
    if (findTimer) clearInterval(findTimer);
    if (pageCheckTimer) clearInterval(pageCheckTimer);
    document.getElementById(ROOT_ID)?.remove();
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("change", onChange, true);
    document.removeEventListener("submit", onSubmit, true);
  }

  function setBox(step, index, total, title) {
    ensureUi();
    const box = document.getElementById("sms-box");
    box.hidden = false;
    document.getElementById("sms-progress").textContent =
      `${title || "ShowMeSteps"} · Step ${index + 1} of ${total}`;
    document.getElementById("sms-title").textContent = step?.title || "Follow this step";
    document.getElementById("sms-desc").textContent =
      step?.description || "Complete the highlighted action.";
    document.getElementById("sms-done").hidden = true;
    clearMistake();
    document.getElementById("sms-ai-reply").hidden = true;
    document.getElementById("sms-ask-panel").hidden = true;
  }

  function clearMistake() {
    const el = document.getElementById("sms-mistake");
    if (el) el.hidden = true;
  }

  function showMistake(headline, body) {
    ensureUi();
    const panel = document.getElementById("sms-mistake");
    panel.hidden = false;
    document.getElementById("sms-mistake-title").textContent = headline;
    document.getElementById("sms-mistake-body").textContent = body;
  }

  function showAiReply(text) {
    const el = document.getElementById("sms-ai-reply");
    el.hidden = false;
    el.textContent = text;
  }

  function clearHighlight() {
    const hl = document.getElementById("sms-highlight");
    if (hl) {
      hl.hidden = true;
      hl.classList.remove("sms-pulse");
    }
  }

  function highlightEl(el, pulse = false) {
    const hl = document.getElementById("sms-highlight");
    if (!hl || !el) {
      clearHighlight();
      return;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 && rect.height < 2) {
      clearHighlight();
      return;
    }
    const pad = 6;
    hl.hidden = false;
    hl.classList.toggle("sms-pulse", pulse);
    hl.style.left = `${Math.max(0, rect.left - pad)}px`;
    hl.style.top = `${Math.max(0, rect.top - pad)}px`;
    hl.style.width = `${rect.width + pad * 2}px`;
    hl.style.height = `${rect.height + pad * 2}px`;
    try {
      el.scrollIntoView({ block: "center", behavior: "smooth", inline: "nearest" });
    } catch {
      /* ignore */
    }
    if (pulse) {
      setTimeout(() => hl.classList.remove("sms-pulse"), 2000);
    }
  }

  function findTarget(step) {
    const meta = step?.metadata || {};
    const elMeta = meta.element || {};
    const selector = elMeta.cssSelector;
    if (selector) {
      try {
        const found = document.querySelector(selector);
        if (found) return found;
      } catch {
        /* invalid selector */
      }
    }

    const candidates = Array.from(
      document.querySelectorAll(
        "a, button, input, select, textarea, [role='button'], [role='link'], summary, label"
      )
    );
    const needle = (
      elMeta.ariaLabel ||
      elMeta.text ||
      elMeta.placeholder ||
      elMeta.name ||
      elMeta.id ||
      meta.element_hint ||
      ""
    )
      .trim()
      .toLowerCase();

    if (needle) {
      const byText = candidates.find((node) => {
        const t = (
          node.getAttribute("aria-label") ||
          node.innerText ||
          node.textContent ||
          node.getAttribute("placeholder") ||
          node.getAttribute("name") ||
          node.id ||
          ""
        )
          .trim()
          .toLowerCase()
          .replace(/\s+/g, " ");
        return t.includes(needle.slice(0, 40)) || needle.includes(t.slice(0, 40));
      });
      if (byText) return byText;
    }

    if (elMeta.id) {
      const byId = document.getElementById(elMeta.id);
      if (byId) return byId;
    }
    return null;
  }

  function refreshHighlight(pulse = false) {
    if (!currentStep || completed) return;
    const kind = (currentStep.metadata || {}).kind;
    if (kind === "navigation") {
      clearHighlight();
      return;
    }
    const el = findTarget(currentStep);
    if (el) highlightEl(el, pulse);
    else clearHighlight();
  }

  function urlsLooselyMatch(expected, actual) {
    if (!expected || !actual) return false;
    try {
      const a = new URL(expected, location.href);
      const b = new URL(actual, location.href);
      return (
        a.origin === b.origin &&
        a.pathname.replace(/\/$/, "") === b.pathname.replace(/\/$/, "")
      );
    } catch {
      return String(expected).split("?")[0] === String(actual).split("?")[0];
    }
  }

  function elementMatches(target, step) {
    const expected = findTarget(step);
    if (!expected || !target) return false;
    if (expected === target || expected.contains(target) || target.contains?.(expected)) {
      return true;
    }
    const sel = step?.metadata?.element?.cssSelector;
    if (sel) {
      try {
        return target.closest?.(sel) != null;
      } catch {
        return false;
      }
    }
    return false;
  }

  function describeClicked(target) {
    if (!(target instanceof Element)) return "something on the page";
    const el =
      target.closest(
        "a, button, input, select, textarea, [role='button'], [role='link'], summary, label"
      ) || target;
    const label = (
      el.getAttribute("aria-label") ||
      el.getAttribute("placeholder") ||
      el.getAttribute("name") ||
      (el instanceof HTMLElement ? el.innerText : "") ||
      el.id ||
      el.tagName
    )
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 80);
    return label || el.tagName.toLowerCase();
  }

  function isInteractive(target) {
    if (!(target instanceof Element)) return false;
    return Boolean(
      target.closest(
        "a, button, input, select, textarea, summary, [role='button'], [role='link'], [onclick], label"
      )
    );
  }

  function completeStep(reason) {
    if (completed || advancing) return;
    advancing = true;
    const done = document.getElementById("sms-done");
    if (done) {
      done.hidden = false;
      done.textContent = reason === "skip" ? "Skipped…" : "Nice — moving on…";
    }
    clearMistake();
    chrome.runtime.sendMessage({
      type: "SMS_GUIDE_STEP_COMPLETE",
      reason,
      stepIndex,
    });
  }

  async function reportMistake({ mistakeType, clickedSummary }) {
    if (helping || !currentStep) return;
    helping = true;
    showMistake("Checking…", "Figuring out what went wrong…");
    refreshHighlight(true);
    try {
      const result = await chrome.runtime.sendMessage({
        type: "SMS_GUIDE_MISTAKE",
        mistakeType,
        clickedSummary,
        currentUrl: location.href,
        step: currentStep,
        stepIndex,
        tutorialTitle,
      });
      if (result?.ok) {
        showMistake(
          result.headline || "Not quite",
          `${result.explanation || ""}${result.tip ? ` Tip: ${result.tip}` : ""}`
        );
      } else {
        showMistake(
          "Not quite — try again",
          result?.error ||
            "That wasn't the control for this step. Use the green highlight."
        );
      }
    } catch (err) {
      showMistake(
        "Not quite — try again",
        "That wasn't the highlighted control. Click the green outline instead."
      );
    } finally {
      helping = false;
      refreshHighlight(true);
    }
  }

  async function askAi() {
    const input = document.getElementById("sms-ask-input");
    const question = (input?.value || "").trim();
    if (!question || !currentStep) return;
    showAiReply("Thinking…");
    try {
      const result = await chrome.runtime.sendMessage({
        type: "SMS_GUIDE_ASK",
        question,
        currentUrl: location.href,
        step: currentStep,
        tutorialTitle,
      });
      if (result?.ok) {
        showAiReply(
          `${result.answer}${result.next_action ? `\n\nNext: ${result.next_action}` : ""}`
        );
      } else {
        showAiReply(result?.error || "Could not get an answer right now.");
      }
    } catch {
      showAiReply("Could not reach the help service.");
    }
    document.getElementById("sms-ask-panel").hidden = true;
    if (input) input.value = "";
    refreshHighlight(true);
  }

  async function recover() {
    if (!currentStep) return;
    showMistake("Getting you back…", "Preparing a recovery path…");
    try {
      const result = await chrome.runtime.sendMessage({
        type: "SMS_GUIDE_RECOVER",
        currentUrl: location.href,
        step: currentStep,
        stepIndex,
        tutorialTitle,
      });
      if (result?.ok) {
        showMistake(
          result.headline || "Let's get you back",
          `${result.explanation || ""}${result.look_for ? ` Look for: ${result.look_for}` : ""}`
        );
        if (result.navigated) {
          // Page will reload / navigate; guide reinjects
          return;
        }
        refreshHighlight(true);
      } else {
        showMistake("Could not recover", result?.error || "Try the highlighted control again.");
        refreshHighlight(true);
      }
    } catch {
      showMistake("Could not recover", "Stay on this page and use the green highlight.");
      refreshHighlight(true);
    }
  }

  function onClick(event) {
    if (!currentStep || completed || advancing) return;
    if (event.target?.closest?.(`#${ROOT_ID}`)) return;

    const kind = (currentStep.metadata || {}).kind || "click";
    if (elementMatches(event.target, currentStep)) {
      if (kind === "click" || kind === "submit") {
        completeStep("click");
      }
      return;
    }

    // Unexpected interactive click while a click/submit step is active
    if ((kind === "click" || kind === "submit") && isInteractive(event.target)) {
      const now = Date.now();
      if (now - wrongClickCooldown < 1500) return;
      wrongClickCooldown = now;
      reportMistake({
        mistakeType: "wrong_click",
        clickedSummary: describeClicked(event.target),
      });
    }
  }

  function onChange(event) {
    if (!currentStep || completed || advancing) return;
    const kind = (currentStep.metadata || {}).kind;
    if (kind !== "change" && kind !== "input") return;
    if (elementMatches(event.target, currentStep)) {
      completeStep("change");
      return;
    }
    if (isInteractive(event.target)) {
      reportMistake({
        mistakeType: "wrong_field",
        clickedSummary: describeClicked(event.target),
      });
    }
  }

  function onSubmit(event) {
    if (!currentStep || completed || advancing) return;
    const kind = (currentStep.metadata || {}).kind;
    if (kind !== "submit") return;
    if (elementMatches(event.target, currentStep) || elementMatches(event.submitter, currentStep)) {
      completeStep("submit");
    } else {
      reportMistake({
        mistakeType: "wrong_submit",
        clickedSummary: "a form submit",
      });
    }
  }

  function checkNavigationStep() {
    if (!currentStep || completed) return;
    const meta = currentStep.metadata || {};
    if (meta.kind !== "navigation") return;
    const expected = meta.to || meta.url;
    if (urlsLooselyMatch(expected, location.href)) {
      completeStep("navigation");
    }
  }

  function checkOffTrackPage() {
    if (!currentStep || completed || advancing || helping) return;
    const meta = currentStep.metadata || {};
    const expected = meta.url || meta.to;
    if (!expected || typeof expected !== "string" || !expected.startsWith("http")) return;
    // Only warn for clear origin mismatches (avoid noisy SPA path diffs)
    try {
      const exp = new URL(expected, location.href);
      const cur = new URL(location.href);
      if (exp.origin !== cur.origin) {
        const now = Date.now();
        if (now - wrongClickCooldown < 8000) return;
        wrongClickCooldown = now;
        reportMistake({
          mistakeType: "wrong_page",
          clickedSummary: `opened ${cur.hostname}`,
        });
      }
    } catch {
      /* ignore */
    }
  }

  function showStep(payload) {
    completed = false;
    advancing = false;
    helping = false;
    currentStep = payload.step;
    stepIndex = payload.stepIndex;
    stepCount = payload.stepCount;
    tutorialTitle = payload.tutorialTitle || "";
    ensureUi();
    setBox(currentStep, stepIndex, stepCount, tutorialTitle);
    refreshHighlight(true);
    checkNavigationStep();

    if (observer) observer.disconnect();
    observer = new MutationObserver(() => refreshHighlight(false));
    observer.observe(document.documentElement, { childList: true, subtree: true });

    if (findTimer) clearInterval(findTimer);
    findTimer = setInterval(() => refreshHighlight(false), 800);
    if (pageCheckTimer) clearInterval(pageCheckTimer);
    pageCheckTimer = setInterval(checkOffTrackPage, 2500);
  }

  document.addEventListener("click", onClick, true);
  document.addEventListener("change", onChange, true);
  document.addEventListener("submit", onSubmit, true);
  window.addEventListener("scroll", () => refreshHighlight(false), true);
  window.addEventListener("resize", () => refreshHighlight(false));

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "SMS_GUIDE_SHOW_STEP") {
      showStep(message);
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === "SMS_GUIDE_TEARDOWN") {
      teardown();
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === "SMS_GUIDE_PING") {
      sendResponse({ ok: true, guiding: Boolean(currentStep) });
      return;
    }
    if (message?.type === "SMS_GUIDE_REHIGHLIGHT") {
      refreshHighlight(true);
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === "SMS_GUIDE_RESULT") {
      completed = true;
      advancing = true;
      clearHighlight();
      const v = message.verification || {};
      const status = v.status || (v.passed ? "passed" : "needs_retry");
      const headline =
        status === "passed"
          ? "You passed!"
          : status === "pending_review"
            ? "Pending review"
            : "Not quite yet";
      const checks = (v.checks || [])
        .map((c) => `${c.passed ? "✓" : "✗"} ${c.detail}`)
        .join(" · ");
      const body = [
        message.successDefinition ? `Goal: ${message.successDefinition}` : null,
        v.message || v.summary || "",
        checks || null,
      ]
        .filter(Boolean)
        .join("\n");
      showResultUI({
        status,
        headline,
        body,
        showReview: status !== "passed",
      });
      sendResponse({ ok: true });
    }
  });

  chrome.runtime.sendMessage({ type: "SMS_GUIDE_READY" });
})();
