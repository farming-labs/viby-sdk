const elements = {
  composer: document.querySelector("#composer"),
  prompt: document.querySelector("#prompt"),
  submit: document.querySelector("#submit-button"),
  submitLabel: document.querySelector("#submit-label"),
  composerLabel: document.querySelector("#composer-label"),
  empty: document.querySelector("#empty-state"),
  messages: document.querySelector("#message-list"),
  conversation: document.querySelector("#conversation-scroll"),
  title: document.querySelector("#project-title"),
  framework: document.querySelector("#framework-chip"),
  download: document.querySelector("#download-button"),
  previewEmpty: document.querySelector("#preview-empty"),
  previewLoading: document.querySelector("#preview-loading"),
  previewLoadingTitle: document.querySelector("#preview-loading-title"),
  previewLoadingCopy: document.querySelector("#preview-loading-copy"),
  previewFrame: document.querySelector("#preview-frame"),
  previewState: document.querySelector("#preview-state"),
  refresh: document.querySelector("#refresh-preview"),
  openPreview: document.querySelector("#open-preview"),
  footerStatus: document.querySelector("#footer-status"),
  versionLabel: document.querySelector("#version-label"),
  eventCount: document.querySelector("#event-count"),
  eventList: document.querySelector("#event-list"),
  activity: document.querySelector("#activity-view"),
  previewSurface: document.querySelector("#preview-surface"),
  error: document.querySelector("#error-banner"),
  errorCopy: document.querySelector("#error-copy"),
  projectList: document.querySelector("#project-list"),
  projectCount: document.querySelector("#project-count"),
  sidebar: document.querySelector("#sidebar"),
  scrim: document.querySelector("#sidebar-scrim"),
};

const state = {
  chatId: null,
  generationId: null,
  version: null,
  events: [],
  busy: false,
  previewUrl: null,
  progress: null,
};

elements.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitPrompt();
});
elements.prompt.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    elements.composer.requestSubmit();
  }
});
document.querySelectorAll("[data-prompt]").forEach((button) => button.addEventListener("click", () => {
  elements.prompt.value = button.dataset.prompt;
  elements.prompt.focus();
}));
document.querySelector("#new-project").addEventListener("click", resetProject);
document.querySelector("#error-close").addEventListener("click", clearError);
elements.download.addEventListener("click", () => {
  if (!state.version || !state.chatId) return;
  window.location.assign(`/api/versions/${encodeURIComponent(state.version.id)}/download?chatId=${encodeURIComponent(state.chatId)}`);
});
elements.refresh.addEventListener("click", () => {
  if (!state.previewUrl) return;
  elements.previewFrame.src = `${state.previewUrl}${state.previewUrl.includes("?") ? "&" : "?"}refresh=${Date.now()}`;
});
document.querySelectorAll("[data-view]").forEach((tab) => tab.addEventListener("click", () => selectView(tab.dataset.view)));
document.querySelector("#menu-button").addEventListener("click", openSidebar);
document.querySelector("#sidebar-close").addEventListener("click", closeSidebar);
elements.scrim.addEventListener("click", closeSidebar);
window.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
    event.preventDefault();
    resetProject();
  }
  if (event.key === "Escape") closeSidebar();
});

void loadProjects();
renderEvents();

async function submitPrompt() {
  const prompt = elements.prompt.value.trim();
  if (!prompt || state.busy) return;
  clearError();
  setBusy(true);
  appendMessage("user", prompt);
  elements.prompt.value = "";
  state.progress = appendProgress();
  setPreviewLoading("Generating source", "Listening to durable generation events…");

  try {
    const payload = state.version
      ? await api(`/api/versions/${encodeURIComponent(state.version.id)}/iterations`, {
          method: "POST",
          body: JSON.stringify({ chatId: state.chatId, prompt }),
        })
      : await api("/api/chats", {
          method: "POST",
          body: JSON.stringify({ prompt }),
        });
    if (payload.chat) {
      state.chatId = payload.chat.id;
      elements.title.textContent = payload.chat.title;
      elements.framework.textContent = payload.chat.framework;
    }
    state.generationId = payload.generation.id;
    await consumeEvents(state.generationId);
    const detail = await api(`/api/generations/${encodeURIComponent(state.generationId)}`);
    if (detail.generation.status !== "succeeded" || !detail.version) {
      throw new Error(detail.generation.error || `Generation finished with ${detail.generation.status}.`);
    }
    state.version = detail.version;
    elements.versionLabel.textContent = `v${detail.version.number}`;
    elements.download.disabled = false;
    appendMessage("assistant", detail.version.summary || "Generated a new project version.");
    completeProgress();
    await startPreview();
    await loadProjects();
    elements.composerLabel.textContent = "Describe the next change";
    elements.prompt.placeholder = "Make the navigation quieter and improve the empty state…";
    elements.submitLabel.textContent = "Iterate";
  } catch (error) {
    showError(error instanceof Error ? error.message : "The generation could not be completed.");
    elements.footerStatus.textContent = "Generation needs attention";
    hidePreviewLoading();
    markProgressFailed();
  } finally {
    setBusy(false);
  }
}

async function consumeEvents(generationId) {
  const response = await fetch(`/api/generations/${encodeURIComponent(generationId)}/events`, {
    headers: { Accept: "text/event-stream" },
  });
  if (!response.ok || !response.body) throw new Error("Could not open the generation stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const event = parseFrame(frame);
      if (!event) continue;
      state.events.push(event);
      renderEvents();
      updateProgress(event);
    }
    if (done) break;
  }
}

function parseFrame(frame) {
  let id = null;
  let type = "message";
  const data = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("id:")) id = line.slice(3).trim();
    else if (line.startsWith("event:")) type = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) return null;
  try {
    const payload = JSON.parse(data.join("\n"));
    return { ...payload, cursor: payload.cursor ?? id, type: payload.type ?? type };
  } catch {
    return null;
  }
}

async function startPreview() {
  if (!state.version || !state.chatId) return;
  setPreviewLoading("Starting preview", "Installing dependencies in an isolated sandbox…");
  elements.footerStatus.textContent = "Starting isolated preview";
  try {
    const preview = await api(`/api/versions/${encodeURIComponent(state.version.id)}/preview`, {
      method: "POST",
      body: JSON.stringify({ chatId: state.chatId }),
    });
    state.previewUrl = preview.url;
    elements.previewFrame.src = preview.url;
    elements.previewFrame.hidden = false;
    elements.previewEmpty.hidden = true;
    elements.previewLoading.hidden = true;
    elements.refresh.disabled = false;
    elements.openPreview.classList.remove("disabled");
    elements.openPreview.href = preview.url;
    elements.previewState.classList.add("live");
    elements.previewState.lastChild.textContent = ` Live · ${preview.provider}`;
    elements.footerStatus.textContent = "Preview is live";
    selectView("preview");
  } catch (error) {
    hidePreviewLoading();
    elements.previewEmpty.hidden = false;
    showError(error instanceof Error ? error.message : "Preview failed to start.");
    elements.footerStatus.textContent = "Source ready · preview unavailable";
  }
}

async function loadProjects() {
  try {
    const payload = await api("/api/chats");
    elements.projectCount.textContent = String(payload.chats.length);
    elements.projectList.replaceChildren();
    if (payload.chats.length === 0) {
      const empty = document.createElement("p");
      empty.className = "project-list-empty";
      empty.textContent = "No projects yet";
      elements.projectList.append(empty);
      return;
    }
    for (const chat of payload.chats) {
      const button = document.createElement("button");
      button.className = `project-item${chat.id === state.chatId ? " active" : ""}`;
      const title = document.createElement("strong");
      title.textContent = chat.title;
      const framework = document.createElement("small");
      framework.textContent = chat.framework;
      const time = document.createElement("small");
      time.className = "project-time";
      time.textContent = relativeTime(chat.updatedAt);
      button.append(title, framework, time);
      button.addEventListener("click", () => void openProject(chat.id));
      elements.projectList.append(button);
    }
  } catch {
    elements.projectList.replaceChildren();
    const error = document.createElement("p");
    error.className = "project-list-empty";
    error.textContent = "Projects unavailable";
    elements.projectList.append(error);
  }
}

async function openProject(chatId) {
  if (state.busy) return;
  clearError();
  try {
    const payload = await api(`/api/chats/${encodeURIComponent(chatId)}`);
    resetProject(false);
    state.chatId = payload.chat.id;
    state.version = payload.versions[0] ?? null;
    elements.title.textContent = payload.chat.title;
    elements.framework.textContent = payload.chat.framework;
    for (const message of payload.messages) appendMessage(message.role, message.content, message.createdAt);
    if (state.version) {
      elements.versionLabel.textContent = `v${state.version.number}`;
      elements.download.disabled = false;
      elements.composerLabel.textContent = "Describe the next change";
      elements.prompt.placeholder = "Make the next focused improvement…";
      elements.submitLabel.textContent = "Iterate";
      elements.previewEmpty.querySelector("h2").textContent = "Preview this version";
      elements.previewEmpty.querySelector("p").textContent = "Submit an iteration to start a fresh isolated preview for the latest version.";
    }
    await loadProjects();
    closeSidebar();
  } catch (error) {
    showError(error instanceof Error ? error.message : "Project could not be opened.");
  }
}

function appendMessage(role, content, createdAt = new Date().toISOString()) {
  elements.empty.hidden = true;
  elements.messages.classList.add("active");
  const article = document.createElement("article");
  article.className = `message ${role}`;
  const meta = document.createElement("div");
  meta.className = "message-meta";
  const author = document.createElement("span");
  author.textContent = role === "user" ? "You" : "Viby";
  const time = document.createElement("time");
  time.dateTime = createdAt;
  time.textContent = new Date(createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const body = document.createElement("p");
  body.className = "message-body";
  body.textContent = content;
  meta.append(author, time);
  article.append(meta, body);
  elements.messages.append(article);
  elements.conversation.scrollTop = elements.conversation.scrollHeight;
  return article;
}

function appendProgress() {
  const article = appendMessage("assistant", "I’m turning that into a runnable source project.");
  const progress = document.createElement("div");
  progress.className = "generation-progress";
  for (const [key, label] of [["plan", "Preparing generation"], ["source", "Writing project source"], ["persist", "Persisting immutable version"]]) {
    const row = document.createElement("div");
    row.className = "progress-row";
    row.dataset.step = key;
    const mark = document.createElement("span");
    mark.className = key === "plan" ? "working" : "pending";
    const copy = document.createElement("span");
    copy.textContent = label;
    row.append(mark, copy);
    progress.append(row);
  }
  article.append(progress);
  return progress;
}

function updateProgress(event) {
  if (!state.progress) return;
  const type = event.type ?? "event";
  if (type === "attempt.started") completeStep("plan");
  if (type === "output.delta" || type === "part.started" || type === "part.delta") {
    completeStep("plan");
    activateStep("source");
  }
  if (type === "attempt.succeeded") {
    completeStep("source");
    activateStep("persist");
  }
  elements.footerStatus.textContent = humanEvent(type);
}

function completeProgress() {
  for (const key of ["plan", "source", "persist"]) completeStep(key);
  state.progress = null;
}

function markProgressFailed() {
  if (!state.progress) return;
  const active = state.progress.querySelector(".working") ?? state.progress.querySelector(".pending");
  if (active) { active.className = "check"; active.textContent = "!"; }
  state.progress = null;
}

function completeStep(key) {
  const mark = state.progress?.querySelector(`[data-step="${key}"] > span`);
  if (!mark) return;
  mark.className = "check";
  mark.textContent = "✓";
}

function activateStep(key) {
  const mark = state.progress?.querySelector(`[data-step="${key}"] > span`);
  if (!mark || mark.className === "check") return;
  mark.className = "working";
}

function renderEvents() {
  elements.eventCount.textContent = `${state.events.length} event${state.events.length === 1 ? "" : "s"}`;
  elements.eventList.replaceChildren();
  if (state.events.length === 0) {
    const empty = document.createElement("li");
    empty.className = "activity-empty";
    empty.textContent = "Events will appear as the generation runs.";
    elements.eventList.append(empty);
    return;
  }
  for (const event of state.events.slice(-100).reverse()) {
    const row = document.createElement("li");
    const cursor = document.createElement("span");
    cursor.className = "event-id";
    cursor.textContent = `#${event.cursor ?? "—"}`;
    const type = document.createElement("span");
    type.className = "event-type";
    type.textContent = event.type;
    const time = document.createElement("time");
    time.textContent = event.createdAt
      ? new Date(event.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
      : "now";
    row.append(cursor, type, time);
    elements.eventList.append(row);
  }
}

function resetProject(render = true) {
  state.chatId = null;
  state.generationId = null;
  state.version = null;
  state.events = [];
  state.previewUrl = null;
  state.progress = null;
  elements.messages.replaceChildren();
  elements.messages.classList.remove("active");
  elements.empty.hidden = false;
  elements.title.textContent = "Untitled";
  elements.framework.textContent = "framework neutral";
  elements.download.disabled = true;
  elements.versionLabel.textContent = "No version";
  elements.composerLabel.textContent = "Describe your project";
  elements.prompt.placeholder = "A calm operations dashboard for…";
  elements.submitLabel.textContent = "Build";
  elements.previewFrame.hidden = true;
  elements.previewFrame.removeAttribute("src");
  elements.previewLoading.hidden = true;
  elements.previewEmpty.hidden = false;
  elements.previewEmpty.querySelector("h2").textContent = "Your preview will appear here";
  elements.previewEmpty.querySelector("p").textContent = "Start with a prompt. Viby will generate source, open an isolated sandbox, and stream the result into this workspace.";
  elements.previewState.classList.remove("live");
  elements.previewState.lastChild.textContent = " No preview";
  elements.refresh.disabled = true;
  elements.openPreview.classList.add("disabled");
  elements.openPreview.removeAttribute("href");
  elements.footerStatus.textContent = "Ready for a prompt";
  clearError();
  renderEvents();
  selectView("preview");
  closeSidebar();
  if (render) void loadProjects();
  elements.prompt.focus();
}

function selectView(view) {
  document.querySelectorAll("[data-view]").forEach((tab) => {
    const selected = tab.dataset.view === view;
    tab.classList.toggle("active", selected);
    tab.setAttribute("aria-selected", String(selected));
  });
  elements.activity.hidden = view !== "activity";
  if (view === "activity") {
    elements.previewEmpty.hidden = true;
    elements.previewLoading.hidden = true;
    elements.previewFrame.hidden = true;
  } else if (state.previewUrl) {
    elements.previewFrame.hidden = false;
    elements.previewEmpty.hidden = true;
    elements.previewLoading.hidden = true;
  } else if (!state.busy) {
    elements.previewEmpty.hidden = false;
  }
}

function setPreviewLoading(title, copy) {
  selectView("preview");
  elements.previewEmpty.hidden = true;
  elements.previewFrame.hidden = true;
  elements.previewLoading.hidden = false;
  elements.previewLoadingTitle.textContent = title;
  elements.previewLoadingCopy.textContent = copy;
}

function hidePreviewLoading() { elements.previewLoading.hidden = true; }
function setBusy(value) {
  state.busy = value;
  elements.submit.disabled = value;
  elements.prompt.disabled = value;
  elements.submitLabel.textContent = value ? "Building" : state.version ? "Iterate" : "Build";
}
function showError(message) { elements.errorCopy.textContent = message; elements.error.hidden = false; }
function clearError() { elements.error.hidden = true; elements.errorCopy.textContent = ""; }
function openSidebar() { elements.sidebar.classList.add("open"); elements.scrim.classList.add("open"); }
function closeSidebar() { elements.sidebar.classList.remove("open"); elements.scrim.classList.remove("open"); }

async function api(path, init = {}) {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed with ${response.status}.`);
  return payload;
}

function humanEvent(type) {
  return ({
    "generation.created": "Generation created",
    "attempt.queued": "Waiting for generation capacity",
    "attempt.started": "Generating project source",
    "output.delta": "Receiving structured source",
    "part.started": "Agent work in progress",
    "part.delta": "Agent work in progress",
    "attempt.succeeded": "Validating generated project",
    "generation.succeeded": "Source version saved",
  })[type] ?? type.replaceAll(".", " ");
}

function relativeTime(value) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}
