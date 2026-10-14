/** Patterns and heuristics for excluding sensitive form data from recordings. */

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

/**
 * @param {HTMLElement | Element | null} el
 * @returns {boolean}
 */
export function isSensitiveElement(el) {
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

/**
 * Return a safe value for recording (never passwords / secrets).
 * @param {HTMLElement} el
 * @returns {string | null}
 */
export function safeValue(el) {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) {
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
  // Cap length to avoid dumping large payloads
  return value.length > 200 ? `${value.slice(0, 200)}…` : value;
}

/**
 * Temporarily mask sensitive fields before a screenshot, then restore.
 * @returns {() => void} restore function
 */
export function maskSensitiveFieldsForScreenshot() {
  /** @type {{el: HTMLElement, type?: string, value?: string, text?: string}[]} */
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
      const el = /** @type {HTMLInputElement | HTMLTextAreaElement} */ (change.el);
      if (change.type !== undefined && el instanceof HTMLInputElement) {
        try {
          el.type = change.type;
        } catch {
          /* ignore */
        }
      }
      if (change.value !== undefined) {
        el.value = change.value;
      }
    }
  };
}
