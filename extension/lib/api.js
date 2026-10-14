const DEFAULT_API_BASE = "http://localhost:8000";

/**
 * @param {string} [baseUrl]
 */
export function getApiBase(baseUrl) {
  return (baseUrl || DEFAULT_API_BASE).replace(/\/$/, "");
}

/**
 * @param {{ apiBase: string, email: string, password: string }} opts
 */
export async function login({ apiBase, email, password }) {
  const res = await fetch(`${getApiBase(apiBase)}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.detail || "Login failed");
  }
  return data;
}

/**
 * @param {{ apiBase: string, token: string, title: string, description?: string }} opts
 */
export async function createTutorial({ apiBase, token, title, description }) {
  const res = await fetch(`${getApiBase(apiBase)}/api/tutorials`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      title,
      description: description || "Recorded with ShowMeSteps Chrome extension",
      status: "draft",
      steps: [],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      typeof data.detail === "string" ? data.detail : "Failed to create tutorial"
    );
  }
  return data;
}

/**
 * @param {{ apiBase: string, token: string, tutorialId: string, steps: object[] }} opts
 */
export async function addTutorialSteps({ apiBase, token, tutorialId, steps }) {
  const results = [];
  for (const step of steps) {
    const res = await fetch(
      `${getApiBase(apiBase)}/api/tutorials/${tutorialId}/steps`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(step),
      }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(
        typeof data.detail === "string" ? data.detail : "Failed to add step"
      );
    }
    results.push(data);
  }
  return results;
}

/**
 * Upload a screenshot (PNG blob) or recording JSON to the backend.
 * @param {{
 *   apiBase: string,
 *   token: string,
 *   tutorialId: string,
 *   mediaType: 'screenshot' | 'recording',
 *   blob: Blob,
 *   fileName: string,
 *   metadata?: object,
 * }} opts
 */
export async function uploadMedia({
  apiBase,
  token,
  tutorialId,
  mediaType,
  blob,
  fileName,
  metadata,
}) {
  const form = new FormData();
  form.append("tutorial_id", tutorialId);
  form.append("media_type", mediaType);
  form.append("file", blob, fileName);
  if (metadata) {
    form.append("metadata", JSON.stringify(metadata));
  }

  const res = await fetch(`${getApiBase(apiBase)}/api/media/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      typeof data.detail === "string" ? data.detail : "Upload failed"
    );
  }
  return data;
}

/**
 * @param {string} dataUrl
 * @returns {Blob}
 */
export function dataUrlToBlob(dataUrl) {
  const [header, base64] = dataUrl.split(",");
  const mime = header.match(/:(.*?);/)?.[1] || "image/png";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

/**
 * Ask the backend (Groq) to turn a recording into tutorial steps.
 * @param {{
 *   apiBase: string,
 *   token: string,
 *   tutorialId: string,
 *   actions?: object[],
 * }} opts
 */
/**
 * Fetch a published tutorial for guided learning (no auth).
 * @param {{ apiBase: string, slug: string }} opts
 */
export async function fetchPublicTutorial({ apiBase, slug }) {
  const res = await fetch(
    `${getApiBase(apiBase)}/api/public/tutorials/${encodeURIComponent(slug)}`
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      typeof data.detail === "string" ? data.detail : "Tutorial not found"
    );
  }
  return data;
}

/**
 * @param {{ apiBase: string, body: object }} opts
 */
export async function helpMistake({ apiBase, body }) {
  const res = await fetch(`${getApiBase(apiBase)}/api/public/help/mistake`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(typeof data.detail === "string" ? data.detail : "Help failed");
  }
  return data;
}

/**
 * @param {{ apiBase: string, body: object }} opts
 */
export async function helpAsk({ apiBase, body }) {
  const res = await fetch(`${getApiBase(apiBase)}/api/public/help/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(typeof data.detail === "string" ? data.detail : "Ask failed");
  }
  return data;
}

/**
 * @param {{ apiBase: string, body: object }} opts
 */
export async function helpRecover({ apiBase, body }) {
  const res = await fetch(`${getApiBase(apiBase)}/api/public/help/recover`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(typeof data.detail === "string" ? data.detail : "Recover failed");
  }
  return data;
}

export async function startAttempt({ apiBase, slug, learnerKey, learnerLabel }) {
  const res = await fetch(
    `${getApiBase(apiBase)}/api/public/tutorials/${encodeURIComponent(slug)}/attempts`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        learner_key: learnerKey,
        learner_label: learnerLabel || null,
      }),
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      typeof data.detail === "string" ? data.detail : "Could not start attempt"
    );
  }
  return data;
}

export async function completeAttempt({
  apiBase,
  slug,
  attemptId,
  completedStepIndexes,
  pageEvidence,
  requestManualReview = false,
  notes,
}) {
  const res = await fetch(
    `${getApiBase(apiBase)}/api/public/tutorials/${encodeURIComponent(slug)}/attempts/${attemptId}/complete`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        completed_step_indexes: completedStepIndexes,
        page_evidence: pageEvidence || null,
        request_manual_review: requestManualReview,
        notes: notes || null,
      }),
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      typeof data.detail === "string" ? data.detail : "Verification failed"
    );
  }
  return data;
}

export async function logFriction({
  apiBase,
  slug,
  attemptId,
  learnerKey,
  stepIndex,
  mistakeType,
  clickedSummary,
}) {
  const res = await fetch(
    `${getApiBase(apiBase)}/api/public/tutorials/${encodeURIComponent(slug)}/attempts/${attemptId}/friction`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        learner_key: learnerKey,
        step_index: stepIndex,
        mistake_type: mistakeType || null,
        clicked_summary: clickedSummary || null,
      }),
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      typeof data.detail === "string" ? data.detail : "Could not log friction"
    );
  }
  return data;
}

export async function uploadAttemptEvidence({
  apiBase,
  slug,
  attemptId,
  learnerKey,
  blob,
  fileName,
}) {
  const form = new FormData();
  form.append("learner_key", learnerKey);
  form.append("file", blob, fileName || "evidence.bin");
  const res = await fetch(
    `${getApiBase(apiBase)}/api/public/tutorials/${encodeURIComponent(slug)}/attempts/${attemptId}/evidence`,
    { method: "POST", body: form }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      typeof data.detail === "string" ? data.detail : "Evidence upload failed"
    );
  }
  return data;
}

export async function generateTutorial({ apiBase, token, tutorialId, actions }) {
  const res = await fetch(
    `${getApiBase(apiBase)}/api/tutorials/${tutorialId}/generate`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        actions: actions || null,
        replace_existing_steps: true,
        update_title: true,
      }),
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      typeof data.detail === "string"
        ? data.detail
        : "AI tutorial generation failed"
    );
  }
  return data;
}
