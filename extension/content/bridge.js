/**
 * Bridge on ShowMeSteps learner pages: Start Guide via the extension
 * (avoids sites like YouTube stripping ?sms_guide= query params).
 */
(() => {
  if (window.__showMeStepsBridge) return;
  window.__showMeStepsBridge = true;

  function slugFromLocation() {
    const parts = location.pathname.split("/").filter(Boolean);
    const idx = parts.indexOf("t");
    if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
    return new URLSearchParams(location.search).get("slug");
  }

  async function launchViaExtension(slug) {
    return chrome.runtime.sendMessage({
      type: "SMS_LAUNCH_GUIDE",
      slug,
    });
  }

  function wireLaunchButton() {
    const btn = document.getElementById("launch-btn");
    if (!btn || btn.dataset.smsWired) return;
    btn.dataset.smsWired = "1";
    btn.addEventListener(
      "click",
      async (event) => {
        const slug = slugFromLocation();
        if (!slug) return;
        event.preventDefault();
        event.stopPropagation();
        btn.textContent = "Starting guide…";
        try {
          const result = await launchViaExtension(slug);
          if (!result?.ok) {
            throw new Error(result?.error || "Extension could not start the guide");
          }
          btn.textContent = "Guide started";
        } catch (err) {
          btn.textContent = "Start guided tutorial";
          alert(err?.message || String(err));
          // Fall back to redirect launch
          location.href = btn.href;
        }
      },
      true
    );
  }

  wireLaunchButton();
  const obs = new MutationObserver(() => wireLaunchButton());
  obs.observe(document.documentElement, { childList: true, subtree: true });

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (data?.source !== "showmesteps") return;
    if (data.type === "SMS_REQUEST_LAUNCH" && data.slug) {
      launchViaExtension(data.slug);
    }
  });
})();
