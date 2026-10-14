(() => {
  const params = new URLSearchParams(location.search);
  const slugFromPath = location.pathname.split("/").filter(Boolean)[1];
  const slug = params.get("slug") || slugFromPath;

  const els = {
    title: document.getElementById("title"),
    summary: document.getElementById("summary"),
    launch: document.getElementById("launch-btn"),
    copy: document.getElementById("copy-btn"),
    banner: document.getElementById("banner"),
    steps: document.getElementById("steps"),
  };

  function apiBase() {
    return location.origin;
  }

  function showBanner(message, isError = false) {
    els.banner.textContent = message;
    els.banner.classList.toggle("error", Boolean(isError));
  }

  async function load() {
    if (!slug) {
      els.title.textContent = "Tutorial not found";
      showBanner("Missing share link slug.", true);
      return;
    }

    try {
      const res = await fetch(`${apiBase()}/api/public/tutorials/${encodeURIComponent(slug)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.detail || "Tutorial not found");
      }

      document.title = `${data.title} · ShowMeSteps`;
      els.title.textContent = data.title;
      els.summary.textContent = data.description || "Follow the steps with the Chrome extension guide.";
      els.launch.href = `${apiBase()}/api/public/tutorials/${encodeURIComponent(slug)}/launch`;
      els.launch.classList.remove("hidden");
      els.copy.classList.remove("hidden");

      if (!data.start_url) {
        showBanner(
          "No launch URL on this tutorial yet. Open the target website, then start the guide from the extension popup using this share link.",
          true
        );
      } else {
        showBanner(
          `${data.step_count} step(s). Click Start — the extension will highlight what to do.`
        );
      }

      els.steps.innerHTML = "";
      (data.steps || []).forEach((step, index) => {
        const li = document.createElement("li");
        li.className = "step";
        li.innerHTML = `
          <div class="step-num">Step ${index + 1}</div>
          <div class="step-title"></div>
          <p class="step-desc"></p>
        `;
        li.querySelector(".step-title").textContent = step.title;
        li.querySelector(".step-desc").textContent = step.description || "";
        els.steps.appendChild(li);
      });

      // Notify extension if installed (optional; launch URL also works)
      window.postMessage(
        { source: "showmesteps", type: "SMS_TUTORIAL_READY", slug, tutorial: data },
        "*"
      );
    } catch (err) {
      els.title.textContent = "Tutorial unavailable";
      showBanner(err.message || String(err), true);
    }
  }

  els.copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(location.href.split("?")[0]);
      showBanner("Share link copied.");
    } catch {
      showBanner("Could not copy link.", true);
    }
  });

  load();
})();
