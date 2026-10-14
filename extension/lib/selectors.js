/**
 * Build a stable-ish CSS selector and descriptive metadata for an element.
 * Used later to highlight the same control when guiding another user.
 */

/**
 * @param {Element} el
 * @returns {string}
 */
function cssEscapeIdent(value) {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(value);
  return String(value).replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, "\\$1");
}

/**
 * @param {Element} el
 * @returns {string}
 */
export function buildCssSelector(el) {
  if (!(el instanceof Element)) return "";

  if (el.id && !/^\d/.test(el.id)) {
    return `#${cssEscapeIdent(el.id)}`;
  }

  /** @type {string[]} */
  const parts = [];
  let current = el;

  while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 6) {
    const tag = current.tagName.toLowerCase();
    if (current.id && !/^\d/.test(current.id)) {
      parts.unshift(`${tag}#${cssEscapeIdent(current.id)}`);
      break;
    }

    let part = tag;
    const testId =
      current.getAttribute("data-testid") ||
      current.getAttribute("data-test") ||
      current.getAttribute("data-cy");
    if (testId) {
      part += `[data-testid="${cssEscapeIdent(testId)}"]`;
      parts.unshift(part);
      break;
    }

    const parent = current.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(
        (c) => c.tagName === current.tagName
      );
      if (siblings.length > 1) {
        const index = siblings.indexOf(current) + 1;
        part += `:nth-of-type(${index})`;
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

/**
 * @param {Element} el
 * @returns {object}
 */
export function describeElement(el) {
  if (!(el instanceof Element)) {
    return { tag: null };
  }

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
  };
}

/**
 * @param {Element} el
 * @returns {string}
 */
function buildXPath(el) {
  if (!(el instanceof Element)) return "";
  if (el.id) return `//*[@id="${el.id}"]`;

  /** @type {string[]} */
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
    const index = sameTag.indexOf(current) + 1;
    segments.unshift(`/${tag}[${index}]`);
    current = parent;
    if (current.tagName === "HTML") break;
  }

  return segments.join("");
}
