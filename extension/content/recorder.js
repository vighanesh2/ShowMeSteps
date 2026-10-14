/**
 * ShowMeSteps content recorder (classic script, injected while recording).
 * Captures clicks, form actions, and in-page navigations; never stores passwords.
 */
(() => {
  if (window.__showMeStepsRecorderInstalled) return;
  window.__showMeStepsRecorderInstalled = true;

  const SENSITIVE_NAME_RE =
    /pass(word|wd|phrase)?|pwd|secret|token|api[_-]?key|auth|ssn|social.?security|credit.?card|card.?number|cvv|cvc|cc[_-]?num|iban|routing|account.?number|pin|otp|one.?time/i;

  const SENSITIVE_AUTOCOMPLETE = new Set([
    "password",
    "current-password",
    "new-password",
    "one-time-code",
    "cc-number",
    "cc-csc",
    "cc-exp",
    "cc-exp-month",
    "cc-exp-year",
    "cc-name",
    "cc-type",
  ]);

  let recording = true;
  let lastUrl = location.href;
  /** @type {WeakMap<Element, number>} */
  const lastInputAt = new WeakMap();

  function isSensitiveElement(el) {
    if (!el || !(el instanceof HTMLElement)) return false;
    if (el instanceof HTMLInputElement) {
      const type = (el.type || "").toLowerCase();
      if (type === "password" || type === "hidden") return true;
      if (SENSITIVE_AUTOCOMPLETE.has((el.autocomplete || "").toLowerCase())) {
        return true;
      }
    }
    const attrs = [
      el.getAttribute("name"),
      el.getAttribute("id"),
      el.getAttribute("autocomplete"),
      el.getAttribute("aria-label"),
      el.getAttribute("placeholder"),
      el.getAttribute("data-sensitive"),
    ]
      .filter(Boolean)
      .join(" ");
    if (SENSITIVE_NAME_RE.test(attrs)) return true;
    if (el.closest("[data-sensitive], [data-private]")) return true;
    return false;
  }

  function safeValue(el) {
    if (
      !(
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement
      )
    ) {
      return null;
    }
    if (isSensitiveElement(el)) return "[REDACTED]";
    if (el instanceof HTMLInputElement) {
      const type = (el.type || "").toLowerCase();
      if (type === "checkbox" || type === "radio") {
        return el.checked ? "checked" : "unchecked";
      }
      if (type === "file") {
        return el.files?.length ? `[${el.files.length} file(s)]` : "";
      }
    }
    const value = el.value ?? "";
    return value.length > 200 ? `${value.slice(0, 200)}…` : value;
  }

  function cssEscapeIdent(value) {
    if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(value);
    return String(value).replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, "\\$1");
  }

  function buildCssSelector(el) {
    if (!(el instanceof Element)) return "";
    if (el.id && !/^\d/.test(el.id)) return `#${cssEscapeIdent(el.id)}`;

    const parts = [];
    let current = el;
    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 6) {
      const tag = current.tagName.toLowerCase();
      if (current.id && !/^\d/.test(current.id)) {
        parts.unshift(`${tag}#${cssEscapeIdent(current.id)}`);
        break;
      }
      const testId =
        current.getAttribute("data-testid") ||
        current.getAttribute("data-test") ||
        current.getAttribute("data-cy");
      if (testId) {
        parts.unshift(`${tag}[data-testid="${cssEscapeIdent(testId)}"]`);
        break;
      }
      let part = tag;
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(
          (c) => c.tagName === current.tagName
        );
        if (siblings.length > 1) {
          part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
        }
      }
      parts.unshift(part);
      current = parent;
      if (!current || current.tagName === "BODY" || current.tagName === "HTML") {
        if (current) parts.unshift(current.tagName.toLowerCase());
        break;
      }
    }
    return parts.join(" > ");
  }

  function buildXPath(el) {
    if (!(el instanceof Element)) return "";
    if (el.id) return `//*[@id="${el.id}"]`;
    const segments = [];
    let current = el;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      const tag = current.tagName.toLowerCase();
      const parent = current.parentElement;
      if (!parent) {
        segments.unshift(`/${tag}`);
        break;
      }
      const sameTag = Array.from(parent.children).filter(
        (c) => c.tagName === current.tagName
      );
      segments.unshift(`/${tag}[${sameTag.indexOf(current) + 1}]`);
      current = parent;
      if (current.tagName === "HTML") break;
    }
    return segments.join("");
  }

  function describeElement(el) {
    if (!(el instanceof Element)) return { tag: null };
    const htmlEl = /** @type {HTMLElement} */ (el);
    const rect = el.getBoundingClientRect();
    const text = (htmlEl.innerText || htmlEl.textContent || "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 120);
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      name: el.getAttribute("name"),
      type: el.getAttribute("type"),
      role: el.getAttribute("role"),
      ariaLabel: el.getAttribute("aria-label"),
      placeholder: el.getAttribute("placeholder"),
      href: el instanceof HTMLAnchorElement ? el.href : null,
      text: text || null,
      cssSelector: buildCssSelector(el),
      xpath: buildXPath(el),
      boundingRect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        top: Math.round(rect.top),
        left: Math.round(rect.left),
      },
      sensitive: isSensitiveElement(el),
    };
  }

  function interactiveTarget(node) {
    if (!(node instanceof Element)) return null;
    return (
      node.closest(
        "a, button, input, select, textarea, summary, [role='button'], [role='link'], [role='checkbox'], [role='menuitem'], [onclick], label"
      ) || node
    );
  }

  function emit(action) {
    if (!recording) return;
    chrome.runtime.sendMessage({
      type: "SMS_ACTION",
      action: {
        ...action,
        url: location.href,
        title: document.title,
        timestamp: Date.now(),
      },
    });
  }

  function onClick(event) {
    const target = interactiveTarget(event.target);
    if (!target) return;
    // Ignore our own UI if ever injected
    if (target.closest?.("#showmesteps-overlay")) return;

    emit({
      kind: "click",
      important: true,
      button: event.button,
      element: describeElement(target),
      value: safeValue(target),
    });
  }

  function onChange(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (
      !(
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement
      )
    ) {
      return;
    }

    emit({
      kind: "change",
      important: true,
      element: describeElement(target),
      value: safeValue(target),
    });
  }

  function onInput(event) {
    const target = event.target;
    if (
      !(
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement
      )
    ) {
      return;
    }
    // Debounce noisy typing; still never store raw sensitive values
    const now = Date.now();
    const prev = lastInputAt.get(target) || 0;
    if (now - prev < 600) return;
    lastInputAt.set(target, now);

    emit({
      kind: "input",
      important: false,
      element: describeElement(target),
      value: safeValue(target),
    });
  }

  function onSubmit(event) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;

    /** @type {object[]} */
    const fields = [];
    Array.from(form.elements).forEach((el) => {
      if (!(el instanceof HTMLElement)) return;
      if (!("name" in el) && !el.id) return;
      fields.push({
        element: describeElement(el),
        value: safeValue(el),
      });
    });

    emit({
      kind: "submit",
      important: true,
      element: describeElement(form),
      fields,
    });
  }

  function checkNavigation() {
    if (location.href === lastUrl) return;
    const from = lastUrl;
    lastUrl = location.href;
    emit({
      kind: "navigation",
      important: true,
      from,
      to: location.href,
      element: null,
    });
  }

  function maskSensitiveFieldsForScreenshot() {
    const changes = [];
    document.querySelectorAll("input, textarea").forEach((node) => {
      const el = /** @type {HTMLInputElement | HTMLTextAreaElement} */ (node);
      if (!isSensitiveElement(el) && !(el instanceof HTMLInputElement && el.type === "password")) {
        return;
      }
      if (el instanceof HTMLInputElement) {
        changes.push({ el, type: el.type, value: el.value });
        try {
          el.type = "text";
        } catch {
          /* ignore */
        }
        el.value = "••••••••";
      } else {
        changes.push({ el, value: el.value });
        el.value = "••••••••";
      }
    });
    return () => {
      for (const change of changes) {
        const el = change.el;
        if (change.type !== undefined && el instanceof HTMLInputElement) {
          try {
            el.type = change.type;
          } catch {
            /* ignore */
          }
        }
        if (change.value !== undefined) el.value = change.value;
      }
    };
  }

  document.addEventListener("click", onClick, true);
  document.addEventListener("change", onChange, true);
  document.addEventListener("input", onInput, true);
  document.addEventListener("submit", onSubmit, true);
  window.addEventListener("popstate", checkNavigation);
  window.addEventListener("hashchange", checkNavigation);

  // Patch history for SPA navigations
  const origPush = history.pushState.bind(history);
  const origReplace = history.replaceState.bind(history);
  history.pushState = function (...args) {
    origPush(...args);
    queueMicrotask(checkNavigation);
  };
  history.replaceState = function (...args) {
    origReplace(...args);
    queueMicrotask(checkNavigation);
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "SMS_STOP") {
      recording = false;
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === "SMS_START") {
      recording = true;
      lastUrl = location.href;
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === "SMS_MASK_FOR_SCREENSHOT") {
      const restore = maskSensitiveFieldsForScreenshot();
      // Keep masked briefly so capture can complete
      setTimeout(() => restore(), 400);
      sendResponse({ ok: true });
      return true;
    }
    if (message?.type === "SMS_PING") {
      sendResponse({ ok: true, recording, url: location.href });
      return;
    }
  });

  // Announce ready
  emit({
    kind: "session_start",
    important: true,
    element: null,
  });
})();
