const EXPECTED_BACKEND_VERSION = "2026.09.06.1";
const state = { kind: "prompt", q: "", searchScope: "all", searchField: "all", category: "", categoryPrefix: "", groupId: null, imageFilter: "", viewMode: "card", viewColumns: 3, ratingMin: "", ratingMax: "", ratingUnrated: false, style: "", styleUnclassified: false, artistClassificationView: "rating-first", favoritesOnly: false, sort: "title", batchSize: 30, offset: 0, total: 0, loading: false, hasMore: true, selectionMode: false, selectedIds: new Set(), entries: [], imageList: [], imageIndex: 0, viewerEntry: null };
const groupsByKind = { artist: [], prompt: [] };
const categoriesByKind = { artist: [], prompt: [] };
const expandedCategories = { artist: new Set(), prompt: new Set() };
const expansionInitialized = { artist: false, prompt: false };
const libraryHost = document.querySelector("[data-dean-library-host]");
const libraryRoot = libraryHost?.shadowRoot || document;
const libraryBody = libraryRoot.querySelector("body") || document.body;
const libraryUrl = () => new URL(libraryHost?.dataset.libraryUrl || location.href, location.origin);
const $ = (selector) => libraryRoot.querySelector(selector);
const gallery = $("#gallery");
let vocabularyTimer = 0;
let vocabularyRequest = 0;
let vocabularyPopup = null;

function currentVocabularyToken(textarea) {
  const cursor = textarea.selectionStart ?? textarea.value.length;
  const before = textarea.value.slice(0, cursor);
  const start = Math.max(before.lastIndexOf(","), before.lastIndexOf("\n")) + 1;
  return { query: before.slice(start).trim(), start, cursor };
}

function hideVocabularyPopup() {
  if (vocabularyPopup) vocabularyPopup.hidden = true;
}

function ensureVocabularyPopup() {
  if (vocabularyPopup) return vocabularyPopup;
  vocabularyPopup = document.createElement("div");
  vocabularyPopup.className = "vocabulary-autocomplete";
  vocabularyPopup.hidden = true;
  libraryBody.appendChild(vocabularyPopup);
  return vocabularyPopup;
}

function acceptVocabularyTag(textarea, tag, start, cursor) {
  const left = textarea.value.slice(0, start).replace(/\s*$/, "");
  const right = textarea.value.slice(cursor).replace(/^\s*,?\s*/, "");
  const inserted = `${left}${left ? " " : ""}${tag}, `;
  textarea.value = inserted + right;
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  hideVocabularyPopup();
  textarea.focus();
  textarea.setSelectionRange(inserted.length, inserted.length);
}

function positionVocabularyPopup(textarea) {
  const popup = ensureVocabularyPopup();
  const rect = textarea.getBoundingClientRect();
  popup.style.left = `${Math.max(8, rect.left)}px`;
  popup.style.top = `${Math.min(window.innerHeight - 280, rect.bottom + 4)}px`;
  popup.style.width = `${Math.max(260, rect.width)}px`;
}

function queryVocabularyFor(textarea) {
  const token = currentVocabularyToken(textarea);
  window.clearTimeout(vocabularyTimer);
  if (token.query.length < 2) {
    hideVocabularyPopup();
    return;
  }
  const requestId = ++vocabularyRequest;
  vocabularyTimer = window.setTimeout(async () => {
    try {
      const response = await fetch(`/api/vocabulary/search?q=${encodeURIComponent(token.query)}&limit=8`);
      const data = response.ok ? await response.json() : { items: [] };
      if (requestId !== vocabularyRequest) return;
      const popup = ensureVocabularyPopup();
      popup.replaceChildren();
      (data.items || []).forEach(item => {
        const button = document.createElement("button");
        button.type = "button";
        const name = document.createElement("strong");
        name.textContent = item.name;
        const translation = document.createElement("small");
        translation.textContent = item.translation || "\u6682\u65e0\u4e2d\u6587\u91ca\u4e49";
        button.append(name, translation);
        button.addEventListener("mousedown", event => event.preventDefault());
        button.addEventListener("click", () => acceptVocabularyTag(textarea, item.name, token.start, token.cursor));
        popup.appendChild(button);
      });
      positionVocabularyPopup(textarea);
      popup.hidden = !popup.childElementCount;
    } catch {
      hideVocabularyPopup();
    }
  }, 180);
}

function initVocabularyAutocomplete() {
  ["entry-content", "entry-negative"].forEach(id => {
    const textarea = $("#" + id);
    if (!textarea) return;
    textarea.addEventListener("input", () => queryVocabularyFor(textarea));
    textarea.addEventListener("keydown", event => {
      if (event.key === "Escape") hideVocabularyPopup();
    });
    textarea.addEventListener("blur", () => window.setTimeout(hideVocabularyPopup, 120));
  });
}
let searchTimer;
let toastTimer;
let entryRequestId = 0;
let navigationRequestId = 0;
let infiniteObserver;
let draggedCategoryPath = "";
let categoryScrollFrame = 0;
let categoryScrollSpeed = 0;
let masonryObserver = null;
let editorViewSnapshot = null;
let viewSaveTimer = 0;
let restoringViewPosition = false;
let imageDialogViewPosition = null;
const VIEW_STATE_KEY = "nai-library-view-state-v2";
const LEGACY_VIEW_STATE_KEY = "nai-library-view-state-v1";
const COPY_HISTORY_KEY = "nai-library-copy-history-v1";
const REVEAL_AFTER_SAVE_KEY = "nai-library-reveal-after-save-v1";
let artistStyles = [];
let artistRatingCounts = {};
const imageFilterGraceIds = new Set();
let metadataRequestId = 0;
let draggedEntryId = null;
let entryScrollFrame = 0;
let entryScrollSpeed = 0;
let suppressCardClick = false;

function reportBrowserError(payload) {
  fetch("/api/client-log", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    keepalive: true,
  }).catch(() => {});
}

window.addEventListener("error", event => {
  reportBrowserError({
    kind: "error",
    message: String(event.message || "").slice(0, 12000),
    stack: String(event.error?.stack || "").slice(0, 12000),
    source: String(event.filename || "").slice(0, 2000),
    line: event.lineno,
    column: event.colno,
  });
});

window.addEventListener("unhandledrejection", event => {
  reportBrowserError({
    kind: "unhandled-rejection",
    message: String(event.reason?.message || event.reason || "").slice(0, 12000),
    stack: String(event.reason?.stack || "").slice(0, 12000),
  });
});

function resizeMasonryCard(card) {
  if (!card || !card.isConnected) return;
  const styles = getComputedStyle(gallery);
  const rowHeight = parseFloat(styles.gridAutoRows) || 8;
  const rowGap = parseFloat(styles.rowGap) || 18;
  const height = card.getBoundingClientRect().height;
  card.style.gridRowEnd = `span ${Math.max(1, Math.ceil((height + rowGap) / (rowHeight + rowGap)))}`;
}

function observeMasonryCard(card) {
  if (!masonryObserver) {
    masonryObserver = new ResizeObserver(entries => {
      requestAnimationFrame(() => entries.forEach(entry => resizeMasonryCard(entry.target)));
    });
  }
  masonryObserver.observe(card);
  requestAnimationFrame(() => resizeMasonryCard(card));
}

function stopCategoryAutoScroll() {
  categoryScrollSpeed = 0;
  if (categoryScrollFrame) cancelAnimationFrame(categoryScrollFrame);
  categoryScrollFrame = 0;
  $("#category-list").classList.remove("auto-scroll-up", "auto-scroll-down");
}

function updateCategoryAutoScroll(clientX, clientY) {
  if (!draggedCategoryPath) return stopCategoryAutoScroll();
  const list = $("#category-list");
  const rect = list.getBoundingClientRect();
  if (clientX < rect.left - 35 || clientX > rect.right + 35 || clientY < rect.top - 40 || clientY > rect.bottom + 40) {
    return stopCategoryAutoScroll();
  }
  const edge = Math.min(72, Math.max(42, rect.height * 0.16));
  let speed = 0;
  if (clientY < rect.top + edge) {
    speed = -Math.max(3, Math.min(18, ((rect.top + edge - clientY) / edge) * 18));
  } else if (clientY > rect.bottom - edge) {
    speed = Math.max(3, Math.min(18, ((clientY - (rect.bottom - edge)) / edge) * 18));
  }
  categoryScrollSpeed = speed;
  list.classList.toggle("auto-scroll-up", speed < 0);
  list.classList.toggle("auto-scroll-down", speed > 0);
  if (!speed) return stopCategoryAutoScroll();
  if (!categoryScrollFrame) {
    const step = () => {
      if (!categoryScrollSpeed || !draggedCategoryPath) return stopCategoryAutoScroll();
      list.scrollTop += categoryScrollSpeed;
      categoryScrollFrame = requestAnimationFrame(step);
    };
    categoryScrollFrame = requestAnimationFrame(step);
  }
}

function stopEntryAutoScroll() {
  entryScrollSpeed = 0;
  if (entryScrollFrame) cancelAnimationFrame(entryScrollFrame);
  entryScrollFrame = 0;
  libraryBody.classList.remove("entry-auto-scroll-up", "entry-auto-scroll-down");
}

function updateEntryAutoScroll(clientY) {
  if (!draggedEntryId) return stopEntryAutoScroll();
  const viewportHeight = libraryHost?.clientHeight || document.documentElement.clientHeight;
  const edge = Math.min(120, Math.max(72, viewportHeight * 0.14));
  let speed = 0;
  if (clientY < edge) {
    speed = -Math.max(3, Math.min(26, ((edge - clientY) / edge) * 26));
  } else if (clientY > viewportHeight - edge) {
    speed = Math.max(3, Math.min(26, ((clientY - (viewportHeight - edge)) / edge) * 26));
  }
  entryScrollSpeed = speed;
  libraryBody.classList.toggle("entry-auto-scroll-up", speed < 0);
  libraryBody.classList.toggle("entry-auto-scroll-down", speed > 0);
  if (!speed) return stopEntryAutoScroll();
  if (!entryScrollFrame) {
    const step = () => {
      if (!entryScrollSpeed || !draggedEntryId) return stopEntryAutoScroll();
      window.scrollBy(0, entryScrollSpeed);
      entryScrollFrame = requestAnimationFrame(step);
    };
    entryScrollFrame = requestAnimationFrame(step);
  }
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 1800);
}

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, cache: "no-store", headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  if (!response.ok) throw new Error((await response.text()) || `请求失败：${response.status}`);
  return response.status === 204 ? null : response.json();
}

function readCopyHistory() {
  try {
    const value = JSON.parse(localStorage.getItem(COPY_HISTORY_KEY) || "[]");
    return Array.isArray(value) ? value.filter(item => item && typeof item.text === "string").slice(0, 50) : [];
  } catch (_error) {
    return [];
  }
}

function writeCopyHistory(items) {
  localStorage.setItem(COPY_HISTORY_KEY, JSON.stringify(items.slice(0, 50)));
}

async function copyPrompt(text, details = {}, options = {}) {
  const value = String(text || "").trim();
  if (!value) return false;
  await navigator.clipboard.writeText(value);
  if (options.record !== false) {
    const history = readCopyHistory().filter(item => item.text !== value);
    history.unshift({
      text: value,
      title: String(details.title || "未命名 Prompt"),
      type: String(details.type || "Prompt"),
      library: String(details.library || state.kind),
      copiedAt: new Date().toISOString(),
    });
    writeCopyHistory(history);
  }
  return true;
}

function formatCopyTime(value) {
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? "" : time.toLocaleString("zh-CN", { hour12: false });
}

function renderCopyHistory() {
  const list = $("#copy-history-list");
  list.replaceChildren();
  const history = readCopyHistory();
  if (!history.length) {
    const empty = document.createElement("div");
    empty.className = "copy-history-empty";
    empty.textContent = "还没有复制过 Prompt";
    list.append(empty);
    return;
  }
  history.forEach(item => {
    const article = document.createElement("article");
    article.className = "copy-history-item";
    const header = document.createElement("header");
    const title = document.createElement("strong");
    title.textContent = item.title;
    const meta = document.createElement("small");
    meta.textContent = `${item.type} · ${formatCopyTime(item.copiedAt)}`;
    header.append(title, meta);
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "复制";
    button.addEventListener("click", async () => {
      await copyPrompt(item.text, item);
      renderCopyHistory();
      showToast("Prompt 已复制");
    });
    const prompt = document.createElement("pre");
    prompt.textContent = item.text;
    article.append(header, button, prompt);
    list.append(article);
  });
}

function captureViewPosition(excludeEntryId = null) {
  const cards = [...libraryRoot.querySelectorAll(".card")].filter(card => Number(card.dataset.entryId) !== Number(excludeEntryId));
  const anchor = cards.find(card => card.getBoundingClientRect().bottom > 92) || cards[0] || null;
  return {
    entryId: anchor ? Number(anchor.dataset.entryId) : null,
    anchorTop: anchor ? anchor.getBoundingClientRect().top : null,
    scrollY: window.scrollY,
    categoryScrollTop: $("#category-list").scrollTop,
    loadedCount: state.entries.length,
  };
}

function currentLibraryViewState(position = captureViewPosition()) {
  return {
    kind: state.kind,
    q: state.q,
    searchScope: state.searchScope,
    searchField: state.searchField,
    category: state.category,
    categoryPrefix: state.categoryPrefix,
    groupId: state.groupId,
    imageFilter: state.imageFilter,
    viewMode: state.viewMode,
    viewColumns: state.viewColumns,
    ratingMin: state.ratingMin,
    ratingValues: selectedArtistRatings().join(","),
    ratingMax: state.ratingMax,
    ratingUnrated: state.ratingUnrated,
    style: state.style,
    styleUnclassified: state.styleUnclassified,
    artistClassificationView: state.artistClassificationView,
    favoritesOnly: state.favoritesOnly,
    sort: state.sort,
    position,
  };
}

function readViewStateStore() {
  try {
    const saved = JSON.parse(localStorage.getItem(VIEW_STATE_KEY) || "null");
    if (saved && saved.libraries && typeof saved.libraries === "object") return saved;
  } catch (_) {
    // 旧数据或损坏数据会在下面迁移/重建。
  }
  return { activeKind: "prompt", libraries: {} };
}

function persistViewState(position = captureViewPosition()) {
  const store = readViewStateStore();
  store.activeKind = state.kind;
  store.libraries[state.kind] = currentLibraryViewState(position);
  localStorage.setItem(VIEW_STATE_KEY, JSON.stringify(store));
}

function applyLibraryViewState(saved, kind) {
  state.kind = kind;
  if (!saved) {
    state.q = "";
    state.searchScope = "all";
    state.searchField = "all";
    state.category = "";
    state.categoryPrefix = "";
    state.groupId = null;
    state.imageFilter = "";
    state.viewMode = "card";
    state.viewColumns = 3;
    state.ratingMin = "";
    state.ratingValues = "";
    state.ratingMax = "";
    state.ratingUnrated = false;
    state.style = "";
    state.styleUnclassified = false;
    state.artistClassificationView = "rating-first";
    state.favoritesOnly = false;
    state.sort = kind === "artist" ? "rating_desc" : "title";
    return null;
  }
  state.q = String(saved.q || "");
  state.searchScope = saved.searchScope === "directory" ? "directory" : "all";
  state.searchField = ["all", "title", "content", "negative", "tags", "path"].includes(saved.searchField) ? saved.searchField : "all";
  state.category = String(saved.category || "");
  state.categoryPrefix = String(saved.categoryPrefix || "");
  state.groupId = Number.isInteger(Number(saved.groupId)) && saved.groupId !== null ? Number(saved.groupId) : null;
  state.imageFilter = ["with", "without"].includes(saved.imageFilter) ? saved.imageFilter : "";
  state.viewMode = ["card", "list", "text"].includes(saved.viewMode) ? saved.viewMode : "card";
  state.viewColumns = [3, 4, 5].includes(Number(saved.viewColumns)) ? Number(saved.viewColumns) : 3;
  state.ratingMin = String(saved.ratingMin || "");
  state.ratingMax = String(saved.ratingMax || "");
  if (kind === "artist" && !state.ratingMax && state.ratingMin === "8") state.ratingMax = "8";
  if (kind === "artist" && !state.ratingMax && state.ratingMin === "6") state.ratingMax = "7";
  state.ratingUnrated = Boolean(saved.ratingUnrated);
  state.ratingValues = typeof saved.ratingValues === "string" ? saved.ratingValues : undefined;
  state.ratingValues = selectedArtistRatings().join(",");
  state.style = String(saved.style || "");
  state.styleUnclassified = Boolean(saved.styleUnclassified);
  state.artistClassificationView = saved.artistClassificationView === "style-first" ? "style-first" : "rating-first";
  state.favoritesOnly = Boolean(saved.favoritesOnly);
  state.sort = ["rating_desc", "rating_asc", "newest", "created_desc", "title", "manual", "usage_desc"].includes(saved.sort)
    ? saved.sort
    : (kind === "artist" ? "rating_desc" : "title");
  return saved.position || null;
}

function savedLibraryViewState(kind) {
  return readViewStateStore().libraries[kind] || null;
}

function restoreStoredViewState() {
  try {
    const store = readViewStateStore();
    const activeKind = ["artist", "prompt"].includes(store.activeKind) ? store.activeKind : "prompt";
    if (store.libraries[activeKind]) return applyLibraryViewState(store.libraries[activeKind], activeKind);

    const legacy = JSON.parse(localStorage.getItem(LEGACY_VIEW_STATE_KEY) || "null");
    if (legacy && ["artist", "prompt"].includes(legacy.kind)) {
      const position = applyLibraryViewState(legacy, legacy.kind);
      persistViewState(position);
      return position;
    }
    return applyLibraryViewState(null, activeKind);
  } catch (_) {
    applyLibraryViewState(null, "prompt");
    return null;
  }
}

function syncViewControls() {
  libraryRoot.querySelectorAll(".module-button").forEach(button => button.classList.toggle("active", button.dataset.kind === state.kind));
  $("#rating-section").hidden = state.kind !== "artist";
  $("#artist-classification-view").value = state.artistClassificationView;
  $("#section-title").textContent = state.kind === "artist" ? "画师串库" : "场景提示词库";
  $("#directory-heading").textContent = state.kind === "artist" ? "画师串目录" : "场景目录";
  $("#section-eyebrow").textContent = state.kind === "artist" ? "ARTIST STRINGS" : "SCENE PROMPTS";
  $("#sort").value = state.sort;
  $("#search").value = state.q;
  updateSearchHint();
  $("#search-field").value = state.searchField;
  updateSearchScopeControl();
  $("#favorite-filter").classList.toggle("active", state.favoritesOnly);
  $("#favorite-icon").textContent = state.favoritesOnly ? "♥" : "♡";
  $("#favorite-filter").title = state.favoritesOnly ? "关闭仅查看收藏" : "仅查看收藏";
  updateImageFilterControl();
  applyViewLayout(false);
  renderArtistClassificationFilters();
}

const ARTIST_RATING_FILTERS = [
  { value: "", label: "全部评分 / 清除" },
  ...Array.from({ length: 10 }, (_, index) => ({ value: String(10 - index), label: (10 - index) / 2 + "★" })),
  { value: "unrated", label: "未评分" },
];

function selectedArtistRatings() {
  const values = typeof state.ratingValues === "string" ? state.ratingValues.split(",")
    : state.ratingUnrated ? ["unrated"]
    : state.ratingMin || state.ratingMax ? Array.from({ length: 10 }, (_, i) => i + 1).filter(n => n >= Number(state.ratingMin || 1) && n <= Number(state.ratingMax || 10)).map(String) : [];
  return ARTIST_RATING_FILTERS.map(item => item.value).filter(value => value && values.includes(value));
}

function selectedArtistStyleRow() {
  if (state.styleUnclassified) return artistStyles.find(item => !item.name) || null;
  return artistStyles.find(item => item.name === state.style) || null;
}

function renderArtistClassificationFilters() {
  const view = $("#artist-classification-view");
  const stack = $("#artist-filter-stack");
  const ratingPanel = $("#rating-filter-panel");
  const stylePanel = $("#style-filter-panel");
  if (!view || !stack || !ratingPanel || !stylePanel) return;
  view.value = state.artistClassificationView;
  stack.replaceChildren();
  if (state.artistClassificationView === "style-first") stack.append(stylePanel, ratingPanel);
  else stack.append(ratingPanel, stylePanel);

  const ratingSelect = $("#artist-rating-filter");
  const styleSelect = $("#artist-style-filter");
  const selected = selectedArtistRatings();
  ratingSelect.replaceChildren();
  ARTIST_RATING_FILTERS.forEach(filter => {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox"; input.value = filter.value;
    input.checked = filter.value ? selected.includes(filter.value) : !selected.length;
    label.append(input, document.createTextNode(filter.label)); ratingSelect.append(label);
  });
  $("#artist-rating-summary").textContent = (selected.length ? ARTIST_RATING_FILTERS.filter(item => selected.includes(item.value)).map(item => item.label).join("、") : "全部评分") + "（多选）";

  styleSelect.replaceChildren();
  const allStyles = document.createElement("option");
  allStyles.value = "";
  allStyles.textContent = "全部风格";
  styleSelect.append(allStyles);
  artistStyles.forEach(style => {
    const option = document.createElement("option");
    option.value = style.name ? `style:${style.name}` : "unclassified";
    option.textContent = style.name || "未分类风格";
    styleSelect.append(option);
  });
  styleSelect.value = state.styleUnclassified ? "unclassified" : (state.style ? `style:${state.style}` : "");
}

const SEARCH_FIELD_LABELS = {
  all: "全部字段",
  title: "标题",
  content: "正向词",
  negative: "负向词",
  tags: "标签",
  path: "路径",
};

function updateSearchHint() {
  $("#search-box")?.classList.toggle("has-query", Boolean($("#search").value.trim()));
}

function updateSearchFieldControl() {
  const control = $("#search-field-control");
  const toggle = $("#search-field-toggle");
  if (!control || !toggle) return;
  const directory = state.searchScope === "directory";
  control.hidden = directory;
  if (directory) {
    $("#search-field-menu").hidden = true;
    toggle.setAttribute("aria-expanded", "false");
  }
  const label = SEARCH_FIELD_LABELS[state.searchField] || SEARCH_FIELD_LABELS.all;
  toggle.title = `搜索字段：${label}`;
  toggle.setAttribute("aria-label", toggle.title);
  libraryRoot.querySelectorAll("#search-field-menu button").forEach(button => {
    button.classList.toggle("active", button.dataset.searchField === state.searchField);
  });
}

function updateSearchScopeControl() {
  const button = $("#search-scope");
  const directory = state.searchScope === "directory";
  const libraryName = state.kind === "artist" ? "全画师串" : "全场景";
  button.textContent = directory ? "当前目录" : libraryName;
  button.classList.toggle("directory", directory);
  button.title = directory
    ? `当前仅搜索所选目录；点击切换为${libraryName}搜索`
    : `当前为${libraryName}搜索；点击切换为当前目录`;
  button.setAttribute("aria-label", button.title);
  updateSearchFieldControl();
}

function updateImageFilterControl() {
  const labels = { "": ["▧", "全部"], with: ["▣", "有图"], without: ["□", "无图"] };
  const [icon, label] = labels[state.imageFilter] || labels[""];
  const button = $("#image-filter-toggle");
  $("#image-filter-icon").textContent = icon;
  $("#image-filter-value").textContent = label;
  button.title = `图片筛选：${label}`;
  button.setAttribute("aria-label", button.title);
  button.classList.toggle("active", Boolean(state.imageFilter));
  libraryRoot.querySelectorAll("#image-filter-menu button").forEach(item => {
    item.classList.toggle("active", item.dataset.imageFilter === state.imageFilter);
  });
}

function applyViewLayout(save = true) {
  gallery.classList.remove("view-card", "view-list", "view-text", "columns-3", "columns-4", "columns-5");
  gallery.classList.add(`view-${state.viewMode}`, `columns-${state.viewColumns}`);
  gallery.classList.toggle("manual-sort", state.sort === "manual");
  libraryRoot.querySelectorAll("[data-view-mode]").forEach(button => {
    button.classList.toggle("active", button.dataset.viewMode === state.viewMode);
  });
  libraryRoot.querySelectorAll("[data-view-columns]").forEach(button => {
    button.classList.toggle("active", Number(button.dataset.viewColumns) === state.viewColumns);
  });
  $("#view-column-options").classList.toggle("disabled", state.viewMode === "list");
  requestAnimationFrame(() => libraryRoot.querySelectorAll(".card").forEach(resizeMasonryCard));
  if (save) persistViewState();
}

async function changeViewLayout(mode = null, columns = null) {
  const position = captureViewPosition();
  if (mode) state.viewMode = mode;
  if (columns) state.viewColumns = Number(columns);
  applyViewLayout();
  await restoreViewPosition(position);
}

async function restoreViewPosition(position) {
  if (!position) return;
  while (position.entryId && !libraryRoot.querySelector(`.card[data-entry-id="${position.entryId}"]`) && state.hasMore && state.entries.length < Math.min(Number(position.loadedCount || 0), 5000)) {
    await loadEntries(false);
  }
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const anchor = position.entryId ? libraryRoot.querySelector(`.card[data-entry-id="${position.entryId}"]`) : null;
  if (anchor && position.anchorTop !== null) {
    window.scrollBy(0, anchor.getBoundingClientRect().top - Number(position.anchorTop));
  } else {
    window.scrollTo(0, Number(position.scrollY || 0));
  }
  $("#category-list").scrollTop = Number(position.categoryScrollTop || 0);
}

async function reloadPreservingView(position = captureViewPosition()) {
  restoringViewPosition = true;
  try {
    await Promise.all([loadNavigation(), loadEntries(true, position.loadedCount)]);
    await restoreViewPosition(position);
    persistViewState(position);
  } finally {
    restoringViewPosition = false;
  }
}

async function revealSavedEntry(entryId, payload) {
  const startingScrollY = window.scrollY;
  const previousMinHeight = gallery.style.minHeight;
  gallery.style.minHeight = `${Math.ceil(gallery.getBoundingClientRect().height)}px`;
  let delayedRelease = false;
  restoringViewPosition = true;
  try {
    const previousKind = state.kind;
    state.kind = payload.kind;
    state.category = payload.category || "未分类";
    state.categoryPrefix = "";
    state.groupId = null;
    state.q = "";
    state.ratingMin = "";
    state.ratingValues = "";
    state.ratingMax = "";
    state.ratingUnrated = false;
    state.style = "";
    state.styleUnclassified = false;
    state.favoritesOnly = false;
    state.imageFilter = "";
    if (previousKind !== state.kind) state.sort = state.kind === "artist" ? "rating_desc" : "title";
    syncViewControls();
    await Promise.all([loadNavigation(), loadEntries(true)]);
    let card = libraryRoot.querySelector(`.card[data-entry-id="${entryId}"]`);
    while (!card && state.hasMore) {
      const previousCount = state.entries.length;
      await loadEntries(false);
      if (state.entries.length === previousCount) break;
      card = libraryRoot.querySelector(`.card[data-entry-id="${entryId}"]`);
    }
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    card = card || libraryRoot.querySelector(`.card[data-entry-id="${entryId}"]`);
    if (card) {
      window.scrollTo(0, startingScrollY);
      card.scrollIntoView({ behavior: "smooth", block: "center" });
      card.classList.add("revealed-card");
      delayedRelease = true;
      setTimeout(() => {
        gallery.style.minHeight = previousMinHeight;
        card.classList.remove("revealed-card");
        persistViewState(captureViewPosition());
      }, 1200);
    } else {
      showToast("资料已保存，但当前排序中未找到对应卡片");
    }
  } finally {
    if (!delayedRelease) gallery.style.minHeight = previousMinHeight;
    restoringViewPosition = false;
  }
}

function starElement(rating) {
  const wrap = document.createElement("div");
  wrap.className = "stars";
  for (let i = 1; i <= 5; i++) {
    const star = document.createElement("span");
    star.className = "star";
    star.textContent = "★";
    if (rating >= i * 2) star.classList.add("full");
    else if (rating === i * 2 - 1) star.classList.add("half");
    wrap.append(star);
  }
  const number = document.createElement("span");
  number.className = "rating-number";
  number.textContent = rating ? `${rating / 2} / 5` : "未评分";
  wrap.append(number);
  return wrap;
}

function appendHighlightedText(node, value) {
  const text = String(value || "");
  const query = state.q.trim();
  if (!query) {
    node.textContent = text;
    return;
  }
  const lowerText = text.toLocaleLowerCase();
  const lowerQuery = query.toLocaleLowerCase();
  let start = 0;
  let found = lowerText.indexOf(lowerQuery, start);
  while (found >= 0) {
    node.append(document.createTextNode(text.slice(start, found)));
    const mark = document.createElement("mark");
    mark.className = "search-highlight";
    mark.textContent = text.slice(found, found + query.length);
    node.append(mark);
    start = found + query.length;
    found = lowerText.indexOf(lowerQuery, start);
  }
  node.append(document.createTextNode(text.slice(start)));
}

function openImages(entry, index = 0) {
  if (!entry.images.length) return;
  const dialog = $("#image-dialog");
  if (!dialog.open) imageDialogViewPosition = captureViewPosition();
  state.viewerEntry = entry;
  state.imageList = entry.images;
  state.imageIndex = index;
  updateImageDialog();
  dialog.showModal();
}

async function restoreAfterImageDialog() {
  const position = imageDialogViewPosition;
  if (!position) return;
  restoringViewPosition = true;
  try {
    await restoreViewPosition(position);
    persistViewState(position);
  } finally {
    imageDialogViewPosition = null;
    restoringViewPosition = false;
  }
}

function updateImageDialog() {
  const image = state.imageList[state.imageIndex];
  const entry = state.viewerEntry;
  $("#full-image").src = image.url;
  $("#viewer-original").href = image.url;
  $("#viewer-title").textContent = entry.title;
  $("#viewer-meta").textContent = `${state.imageIndex + 1} / ${state.imageList.length} · ${entry.category}`;
  const negativeLibrary = entry.category === "负面提示词";
  $("#viewer-positive").textContent = entry.content || "（没有提示词内容）";
  $("#copy-positive").textContent = negativeLibrary ? "复制负面" : "复制正向";
  $("#viewer-copy").textContent = negativeLibrary ? "复制负面" : "复制正向";
  $("#copy-positive").previousElementSibling.textContent = negativeLibrary ? "负面提示词" : "正向提示词";
  $("#viewer-negative").textContent = entry.negative_prompt || "（使用通用负面提示词或尚未填写）";
  $("#viewer-negative-section").hidden = !entry.negative_prompt;
  $("#viewer-favorite").classList.toggle("active", Boolean(entry.favorite));
  $("#viewer-favorite").textContent = entry.favorite ? "♥ 已收藏" : "♡ 收藏";
  const coverButton = $("#viewer-set-cover");
  const currentCover = state.imageIndex === 0;
  coverButton.textContent = currentCover ? "当前卡片封面" : "设为卡片封面";
  coverButton.disabled = currentCover || state.imageList.length < 2;
  $("#image-counter").textContent = `${state.imageIndex + 1} / ${state.imageList.length}`;
  $(".image-nav.previous").hidden = state.imageList.length < 2;
  $(".image-nav.next").hidden = state.imageList.length < 2;
  loadViewerMetadata(image).catch(error => {
    $("#viewer-embedded-section").hidden = false;
    $("#viewer-embedded-empty").hidden = false;
    $("#viewer-embedded-empty").textContent = error.message;
  });
}

function renderViewerMetadata(metadata) {
  const entry = state.viewerEntry;
  $("#viewer-embedded-section").hidden = false;
  $("#viewer-embedded-source").textContent = metadata.source && metadata.source !== "none" ? `来源：${metadata.source}` : "";
  const positive = String(metadata.positive_prompt || "");
  const negative = String(metadata.negative_prompt || "");
  $("#viewer-embedded-positive-section").hidden = !positive;
  $("#viewer-embedded-positive").textContent = positive;
  $("#viewer-embedded-negative-section").hidden = !negative;
  $("#viewer-embedded-negative").textContent = negative;
  const characters = Array.isArray(metadata.characters) ? metadata.characters : [];
  const characterList = $("#viewer-character-prompts");
  characterList.replaceChildren();
  characters.forEach((prompt, index) => {
    const block = document.createElement("section");
    block.className = "character-prompt-block";
    const header = document.createElement("header");
    const label = document.createElement("strong");
    label.textContent = `图片角色提示词 ${index + 1}`;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "复制";
    button.addEventListener("click", async () => {
      await copyPrompt(prompt, { title: entry?.title, type: `图片角色 ${index + 1}`, library: entry?.kind });
      showToast(`角色提示词 ${index + 1} 已复制`);
    });
    const content = document.createElement("pre");
    content.textContent = prompt;
    header.append(label, button);
    block.append(header, content);
    characterList.append(block);
  });
  const parameters = metadata.parameters && typeof metadata.parameters === "object" ? metadata.parameters : {};
  const parameterList = $("#viewer-generation-parameters");
  parameterList.replaceChildren();
  Object.entries(parameters).forEach(([key, value]) => {
    const term = document.createElement("dt");
    term.textContent = key;
    const description = document.createElement("dd");
    description.textContent = typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);
    parameterList.append(term, description);
  });
  const empty = !positive && !negative && !characters.length && !Object.keys(parameters).length;
  $("#viewer-embedded-empty").hidden = !empty;
  $("#viewer-embedded-empty").textContent = "没有读到常规图片参数；如果图片由 NovelAI 生成但参数被隐藏，可以尝试“深度读取”。";
  $("#viewer-read-deep").hidden = !empty;
}

async function loadViewerMetadata(image, deep = false) {
  const requestId = ++metadataRequestId;
  $("#viewer-embedded-section").hidden = false;
  $("#viewer-embedded-source").textContent = "正在读取…";
  $("#viewer-embedded-empty").hidden = true;
  const metadata = await api(`/api/assets/${image.id}/metadata${deep ? "?deep=1" : ""}`);
  if (requestId !== metadataRequestId || state.imageList[state.imageIndex]?.id !== image.id) return;
  image.metadata = metadata;
  renderViewerMetadata(metadata);
}

async function setViewerImageAsCover() {
  const entry = state.viewerEntry;
  const image = state.imageList[state.imageIndex];
  if (!entry || !image || state.imageIndex === 0) return;
  const button = $("#viewer-set-cover");
  button.disabled = true;
  try {
    const position = imageDialogViewPosition || captureViewPosition();
    await api(`/api/entries/${entry.id}/images/cover`, {
      method: "PUT",
      body: JSON.stringify({ asset_id: image.id }),
    });
    entry.images = [image, ...entry.images.filter(item => item.id !== image.id)];
    state.imageList = entry.images;
    state.imageIndex = 0;
    updateImageDialog();
    await reloadPreservingView(position);
    showToast("卡片封面已更换");
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = state.imageIndex === 0;
  }
}

async function deleteViewerImage() {
  const entry = state.viewerEntry;
  const image = state.imageList[state.imageIndex];
  if (!entry || !image) return;
  if (!confirm(`确定从“${entry.title}”中移除当前示例图吗？\n无人引用的原图副本和缩略图将永久删除；共享图片及外部关联原文件保留。`)) return;
  const button = $("#viewer-delete-image");
  button.disabled = true;
  try {
    const position = imageDialogViewPosition || captureViewPosition();
    const result = await api(`/api/entries/${entry.id}/images/${image.id}`, { method: "DELETE" });
    entry.images = entry.images.filter(item => item.id !== image.id);
    state.imageList = entry.images;
    if (!state.imageList.length) {
      imageDialogViewPosition = null;
      $("#image-dialog").close();
      state.viewerEntry = null;
      showToast("示例图片已移除");
    } else {
      state.imageIndex = Math.min(state.imageIndex, state.imageList.length - 1);
      updateImageDialog();
      showToast("当前示例图片已移除");
    }
    await reloadPreservingView(position);
    showCleanupResult(result?.cleanup);
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
}

function imageStrip(entry) {
  if (!entry.images.length) {
    const empty = document.createElement("div");
    empty.className = "no-image";
    empty.textContent = entry.kind === "artist" ? "ART" : "PROMPT";
    return empty;
  }
  const strip = document.createElement("div");
  strip.className = "image-strip";
  entry.images.slice(0, 1).forEach((image, index) => {
    const img = document.createElement("img");
    img.loading = "lazy";
    img.decoding = "async";
    img.fetchPriority = "low";
    img.src = image.thumbnail_url;
    img.alt = entry.title;
    if (Number(image.width) > 0 && Number(image.height) > 0) {
      img.width = Number(image.width);
      img.height = Number(image.height);
      strip.style.aspectRatio = `${image.width} / ${image.height}`;
    }
    img.addEventListener("load", () => {
      if (!strip.style.aspectRatio && img.naturalWidth && img.naturalHeight) {
        strip.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
      }
      resizeMasonryCard(strip.closest(".card"));
    });
    img.addEventListener("error", () => strip.classList.add("image-failed"));
    strip.append(img);
  });
  const original = document.createElement("button");
  original.className = "original-button";
  original.textContent = "↗ 原图";
  original.addEventListener("click", event => { event.stopPropagation(); openImages(entry, 0); });
  strip.append(original);
  return strip;
}

async function toggleFavorite(entry, button = null) {
  entry.favorite = entry.favorite ? 0 : 1;
  try {
    await api(`/api/entries/${entry.id}`, { method: "PUT", body: JSON.stringify({ favorite: Boolean(entry.favorite) }) });
    if (button) {
      button.classList.toggle("active", Boolean(entry.favorite));
      button.textContent = entry.favorite ? "♥" : "♡";
    }
    if (state.viewerEntry?.id === entry.id) updateImageDialog();
    await loadNavigation();
    if (state.favoritesOnly && !entry.favorite) loadEntries();
    showToast(entry.favorite ? "已加入收藏" : "已取消收藏");
  } catch (error) {
    entry.favorite = entry.favorite ? 0 : 1;
    showToast(error.message);
  }
}

async function togglePinned(entry, button, card) {
  const previous = Boolean(entry.pinned);
  entry.pinned = previous ? 0 : 1;
  button.textContent = entry.pinned ? "取消置顶" : "置顶";
  card.classList.toggle("pinned-card", Boolean(entry.pinned));
  try {
    await api(`/api/entries/${entry.id}`, { method: "PUT", body: JSON.stringify({ pinned: Boolean(entry.pinned) }) });
    showToast(entry.pinned ? "已置顶" : "已取消置顶");
    await loadEntries();
  } catch (error) {
    entry.pinned = previous ? 1 : 0;
    button.textContent = previous ? "取消置顶" : "置顶";
    card.classList.toggle("pinned-card", previous);
    showToast(error.message);
  }
}

async function recordEntryUse(entry) {
  try {
    const result = await api(`/api/entries/${entry.id}/use`, { method: "POST", body: "{}" });
    entry.usage_count = Number(result.usage_count || 0);
    entry.last_used_at = result.last_used_at;
    libraryRoot.querySelectorAll(`.usage-count[data-entry-id="${entry.id}"]`).forEach(badge => {
      badge.hidden = false;
      badge.textContent = `使用 ${entry.usage_count} 次`;
    });
    if (state.sort === "usage_desc") {
      await reloadPreservingView(captureViewPosition());
    }
  } catch (error) {
    console.error("Failed to record entry usage", error);
  }
}

async function moveManualEntry(sourceId, targetId, placeAfter = false) {
  if (state.sort !== "manual" || sourceId === targetId) return;
  const sourceIndex = state.entries.findIndex(entry => entry.id === sourceId);
  const originalTargetIndex = state.entries.findIndex(entry => entry.id === targetId);
  if (sourceIndex < 0 || originalTargetIndex < 0) return;

  const previous = [...state.entries];
  const [moved] = state.entries.splice(sourceIndex, 1);
  let targetIndex = state.entries.findIndex(entry => entry.id === targetId);
  if (placeAfter) targetIndex += 1;
  state.entries.splice(targetIndex, 0, moved);

  const sourceCard = gallery.querySelector(`.card[data-entry-id="${sourceId}"]`);
  const targetCard = gallery.querySelector(`.card[data-entry-id="${targetId}"]`);
  if (sourceCard && targetCard) {
    gallery.insertBefore(sourceCard, placeAfter ? targetCard.nextSibling : targetCard);
    requestAnimationFrame(() => {
      libraryRoot.querySelectorAll(".card").forEach(resizeMasonryCard);
      updateManualOrderButtons();
    });
  }

  try {
    await api("/api/entries/order", {
      method: "PUT",
      body: JSON.stringify({ kind: state.kind, entry_ids: state.entries.map(entry => entry.id) }),
    });
    showToast("自定义顺序已保存");
    await revealSavedEntry(sourceId, moved);
  } catch (error) {
    state.entries = previous;
    showToast(error.message);
    await loadEntries(true, previous.length);
  }
}

function moveManualEntryByStep(entryId, offset) {
  const index = state.entries.findIndex(entry => entry.id === entryId);
  const target = state.entries[index + offset];
  if (!target) return;
  moveManualEntry(entryId, target.id, offset > 0).catch(error => showToast(error.message));
}

async function moveManualEntryToPosition(entry, input) {
  const position = Number(input.value);
  if (!Number.isInteger(position) || position < 1) {
    input.value = entry.manual_order || "";
    return showToast("自定义排序 ID 必须是正整数");
  }
  input.disabled = true;
  try {
    const result = await api(`/api/entries/${entry.id}/manual-order`, {
      method: "PUT",
      body: JSON.stringify({ position }),
    });
    entry.manual_order = result.manual_order;
    showToast(`已移动到自定义排序 ID ${result.manual_order}`);
    await revealSavedEntry(entry.id, entry);
  } catch (error) {
    input.disabled = false;
    input.value = entry.manual_order || "";
    showToast(error.message);
  }
}

function updateManualOrderButtons() {
  const cards = [...gallery.querySelectorAll(".card")];
  cards.forEach((card, index) => {
    const up = card.querySelector('[data-manual-direction="up"]');
    const down = card.querySelector('[data-manual-direction="down"]');
    if (up) up.disabled = index === 0;
    if (down) down.disabled = index === cards.length - 1;
  });
}

function createCard(entry) {
  const card = document.createElement("article");
  card.className = `card ${entry.kind}-card${entry.pinned ? " pinned-card" : ""}${state.selectedIds.has(entry.id) ? " selected" : ""}`;
  card.dataset.entryId = entry.id;
  if (state.sort === "manual") {
    card.draggable = true;
    card.addEventListener("dragstart", event => {
      if (event.target.closest("button, input, a, select, textarea")) {
        event.preventDefault();
        return;
      }
      draggedEntryId = entry.id;
      suppressCardClick = true;
      card.classList.add("manual-dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", String(entry.id));
    });
    card.addEventListener("dragover", event => {
      if (!draggedEntryId || draggedEntryId === entry.id) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      card.classList.add("manual-drag-over");
    });
    card.addEventListener("dragleave", () => card.classList.remove("manual-drag-over"));
    card.addEventListener("drop", event => {
      event.preventDefault();
      card.classList.remove("manual-drag-over");
      const sourceId = Number(event.dataTransfer.getData("text/plain") || draggedEntryId);
      const placeAfter = event.clientY > card.getBoundingClientRect().top + card.getBoundingClientRect().height / 2;
      moveManualEntry(sourceId, entry.id, placeAfter).catch(error => showToast(error.message));
    });
    card.addEventListener("dragend", () => {
      stopEntryAutoScroll();
      draggedEntryId = null;
      card.classList.remove("manual-dragging");
      libraryRoot.querySelectorAll(".manual-drag-over").forEach(item => item.classList.remove("manual-drag-over"));
      setTimeout(() => { suppressCardClick = false; }, 120);
    });
  }
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "card-select";
  checkbox.checked = state.selectedIds.has(entry.id);
  checkbox.tabIndex = -1;
  card.append(checkbox);
  card.append(imageStrip(entry));
  const body = document.createElement("div");
  body.className = "card-body";
  const top = document.createElement("div");
  top.className = "card-topline";
  const title = document.createElement("h2");
  appendHighlightedText(title, entry.title);
  title.title = entry.title;
  const edit = document.createElement("button");
  edit.className = "edit-button";
  edit.textContent = "编辑";
  edit.addEventListener("click", event => { event.stopPropagation(); openEditor(entry); });
  top.append(title, edit);
  body.append(top);
  if (entry.kind === "artist") body.append(starElement(entry.rating));
  if (state.q && entry.search_matches?.length) {
    const labels = { title: "标题", content: "正向词", negative_prompt: "负向词", tags: "标签", category: "路径" };
    const matches = document.createElement("div");
    matches.className = "search-match-row";
    entry.search_matches.forEach(field => {
      const badge = document.createElement("span");
      badge.className = "search-match-badge";
      badge.textContent = `命中：${labels[field] || field}`;
      matches.append(badge);
    });
    body.append(matches);
  }
  const excerpt = document.createElement("p");
  excerpt.className = "excerpt";
  appendHighlightedText(excerpt, entry.content || "（暂无提示词内容）");
  body.append(excerpt);
  const tags = document.createElement("div");
  tags.className = "tag-row";
  entry.tags.slice(0, 4).forEach(value => {
    const tag = document.createElement("span"); tag.className = "tag"; tag.textContent = value; tags.append(tag);
  });
  (entry.groups || []).forEach(group => {
    const tag = document.createElement("span"); tag.className = "tag group-tag"; tag.textContent = `分组 · ${group.name}`; tags.append(tag);
  });
  if (entry.kind === "artist" && entry.style) {
    const style = document.createElement("span");
    style.className = "tag";
    style.textContent = `风格 · ${entry.style}`;
    tags.append(style);
  }
  const usage = document.createElement("span");
  usage.className = "tag usage-count";
  usage.dataset.entryId = entry.id;
  usage.textContent = `使用 ${Number(entry.usage_count || 0)} 次`;
  usage.hidden = !entry.usage_count && state.sort !== "usage_desc";
  tags.append(usage);
  if (state.imageFilter === "without" && imageFilterGraceIds.has(entry.id)) {
    const temporary = document.createElement("span");
    temporary.className = "tag temporary-filter-tag";
    temporary.textContent = "刚添加图片 · 临时保留";
    tags.append(temporary);
  }
  body.append(tags);
  const meta = document.createElement("div");
  meta.className = "meta-row";
  const category = document.createElement("span"); appendHighlightedText(category, entry.category);
  const action = document.createElement("span"); action.className = "copy-hint"; action.textContent = "点击复制";
  meta.append(category, action);
  body.append(meta);
  const actions = document.createElement("div");
  actions.className = "card-actions";
  if (state.sort === "manual") {
    const index = state.entries.findIndex(item => item.id === entry.id);
    const up = document.createElement("button");
    up.className = "manual-order-button";
    up.dataset.manualDirection = "up";
    up.textContent = "↑";
    up.title = "在自定义顺序中上移";
    up.disabled = index <= 0;
    up.addEventListener("click", event => { event.stopPropagation(); moveManualEntryByStep(entry.id, -1); });
    const down = document.createElement("button");
    down.className = "manual-order-button";
    down.dataset.manualDirection = "down";
    down.textContent = "↓";
    down.title = "在自定义顺序中下移";
    down.disabled = index < 0 || index >= state.entries.length - 1;
    down.addEventListener("click", event => { event.stopPropagation(); moveManualEntryByStep(entry.id, 1); });
    const positionControl = document.createElement("span");
    positionControl.className = "manual-order-position";
    positionControl.title = "输入全库自定义排序 ID，然后点击移动";
    positionControl.addEventListener("click", event => event.stopPropagation());
    const positionLabel = document.createElement("span");
    positionLabel.textContent = "ID";
    const positionInput = document.createElement("input");
    positionInput.type = "number";
    positionInput.min = "1";
    positionInput.step = "1";
    positionInput.value = entry.manual_order || "";
    positionInput.setAttribute("aria-label", `${entry.title} 的自定义排序 ID`);
    const moveButton = document.createElement("button");
    moveButton.type = "button";
    moveButton.textContent = "移动";
    moveButton.addEventListener("click", event => {
      event.stopPropagation();
      moveManualEntryToPosition(entry, positionInput);
    });
    positionInput.addEventListener("keydown", event => {
      if (event.key === "Enter") {
        event.preventDefault();
        moveButton.click();
      }
    });
    positionControl.append(positionLabel, positionInput, moveButton);
    actions.append(positionControl, up, down);
  }
  const pin = document.createElement("button");
  pin.textContent = entry.pinned ? "取消置顶" : "置顶";
  pin.title = entry.pinned ? "取消置顶" : "将这张卡固定在最前面";
  pin.addEventListener("click", event => { event.stopPropagation(); togglePinned(entry, pin, card); });
  actions.append(pin);
  if (entry.images.length > 1) {
    const more = document.createElement("button");
    more.textContent = `更多作品 · ${entry.images.length}`;
    more.addEventListener("click", event => { event.stopPropagation(); openImages(entry, 0); });
    actions.append(more);
  }
  const favorite = document.createElement("button");
  favorite.className = "favorite-button" + (entry.favorite ? " active" : "");
  favorite.textContent = entry.favorite ? "♥" : "♡";
  favorite.title = entry.favorite ? "取消收藏" : "收藏";
  favorite.addEventListener("click", event => { event.stopPropagation(); toggleFavorite(entry, favorite); });
  actions.append(favorite);
  body.append(actions);
  card.append(body);
  card.addEventListener("click", async () => {
    if (suppressCardClick) return;
    if (state.selectionMode) {
      if (state.selectedIds.has(entry.id)) state.selectedIds.delete(entry.id);
      else state.selectedIds.add(entry.id);
      card.classList.toggle("selected", state.selectedIds.has(entry.id));
      checkbox.checked = state.selectedIds.has(entry.id);
      updateBatchToolbar();
      return;
    }
    if (!entry.content) return showToast("这条资料还没有可复制的内容");
    await copyPrompt(entry.content, {
      title: entry.title,
      type: entry.category === "负面提示词" ? "负面提示词" : (entry.kind === "artist" ? "画师串" : "场景提示词"),
      library: entry.kind,
    });
    void recordEntryUse(entry);
    showToast(entry.category === "负面提示词" ? "负面提示词已复制" : (entry.kind === "artist" ? "画师串已复制" : "提示词已复制"));
  });
  observeMasonryCard(card);
  return card;
}

function entryQueryParams(limit, offset) {
  const params = new URLSearchParams({ kind: state.kind, sort: state.sort, limit: String(limit), offset: String(offset) });
  if (state.q) {
    params.set("q", state.q);
    params.set("search_scope", state.searchScope);
    if (state.searchScope === "all") params.set("search_field", state.searchField);
  }
  if (state.category) params.set("category", state.category);
  else if (state.categoryPrefix) params.set("category_prefix", state.categoryPrefix);
  if (state.kind === "artist" && selectedArtistRatings().length) params.set("ratings", selectedArtistRatings().join(","));
  if (state.style) params.set("style", state.style);
  if (state.styleUnclassified) params.set("style_unclassified", "1");
  if (state.favoritesOnly) params.set("favorites_only", "1");
  if (state.groupId) params.set("group_id", String(state.groupId));
  if (state.imageFilter) params.set("image_filter", state.imageFilter);
  if (state.imageFilter === "without" && imageFilterGraceIds.size) {
    params.set("image_filter_include_ids", [...imageFilterGraceIds].join(","));
  }
  return params;
}

async function loadEntries(reset = true, initialLimit = null) {
  if (reset) {
    entryRequestId += 1;
    state.offset = 0;
    state.entries = [];
    if (state.selectionMode) {
      state.selectedIds.clear();
      updateBatchToolbar();
    }
    state.hasMore = true;
    state.loading = false;
    if (masonryObserver) masonryObserver.disconnect();
    gallery.replaceChildren();
  }
  if (state.loading || !state.hasMore) return;
  const requestId = entryRequestId;
  state.loading = true;
  $("#load-more-text").textContent = "正在加载更多资料…";
  const requestLimit = reset && initialLimit
    ? Math.min(1000, Math.max(state.batchSize, Number(initialLimit) || state.batchSize))
    : state.batchSize;
  const params = entryQueryParams(requestLimit, state.offset);
  try {
    const data = await api(`/api/entries?${params}`);
    if (requestId !== entryRequestId) return;
    state.entries.push(...data.entries);
    state.total = data.total;
    state.offset += data.entries.length;
    state.hasMore = state.offset < data.total;
    data.entries.forEach(entry => gallery.append(createCard(entry)));
    if (state.sort === "manual") updateManualOrderButtons();
    $("#result-summary").textContent = `找到 ${data.total} 条资料，已按需载入 ${state.entries.length} 条`;
    $("#empty-state").hidden = state.entries.length > 0;
    $("#load-more-sentinel").hidden = data.total === 0;
    $("#load-more-text").textContent = state.hasMore ? "继续向下滚动加载" : `已加载全部 ${data.total} 条资料`;
    updateActiveFilter();
  } catch (error) {
    if (requestId !== entryRequestId) return;
    $("#result-summary").textContent = "载入失败";
    $("#load-more-text").textContent = "加载失败，滚动到此处可重试";
    showToast(error.message);
  } finally {
    if (requestId === entryRequestId) state.loading = false;
  }
}

async function loadNavigation() {
  const requestId = ++navigationRequestId;
  const requestedKind = state.kind;
  const nav = await api("/api/navigation");
  if (requestId !== navigationRequestId || requestedKind !== state.kind) return;
  $("#artist-count").textContent = nav.totals.artist || 0;
  $("#prompt-count").textContent = nav.totals.prompt || 0;
  $("#favorite-count").textContent = nav.favorites[state.kind] || 0;
  artistStyles = nav.styles || [];
  artistRatingCounts = nav.ratings || {};
  renderArtistClassificationFilters();
  $("#images-all-count").textContent = nav.image_counts?.[state.kind]?.all || 0;
  $("#images-with-count").textContent = nav.image_counts?.[state.kind]?.with_images || 0;
  $("#images-without-count").textContent = nav.image_counts?.[state.kind]?.without_images || 0;
  groupsByKind.artist = nav.groups?.artist || [];
  groupsByKind.prompt = nav.groups?.prompt || [];
  categoriesByKind.artist = nav.categories?.artist || [];
  categoriesByKind.prompt = nav.categories?.prompt || [];
  renderCategoryTree(nav.categories[state.kind] || [], nav.totals[state.kind] || 0);
  renderGroupList();
  renderCategoryChips(nav.categories[state.kind] || [], nav.totals[state.kind] || 0);
}

function renderCategoryChips(items, total) {
  const chips = $("#category-chips");
  const selectedPath = state.category || state.categoryPrefix;
  const selectedHasChildren = Boolean(selectedPath && items.some(item => item.name.startsWith(`${selectedPath}/`)));
  const selectedIsDirectView = Boolean(
    state.category && selectedHasChildren
    && Number(items.find(item => item.name === selectedPath)?.count || 0) > 0
  );
  const parentPath = selectedPath
    ? (selectedIsDirectView ? selectedPath : categoryPathParent(selectedPath))
    : "";
  const children = new Map();
  items.forEach(item => {
    const prefix = parentPath ? `${parentPath}/` : "";
    if (parentPath && !item.name.startsWith(prefix)) return;
    const remainder = parentPath ? item.name.slice(prefix.length) : item.name;
    const childName = remainder.split("/").filter(Boolean)[0];
    if (!childName) return;
    const childPath = parentPath ? `${parentPath}/${childName}` : childName;
    children.set(childPath, (children.get(childPath) || 0) + Number(item.count || 0));
  });
  const parentDirectCount = parentPath
    ? Number(items.find(item => item.name === parentPath)?.count || 0)
    : 0;
  const scopeTotal = parentPath
    ? items.filter(item => item.name === parentPath || item.name.startsWith(`${parentPath}/`))
      .reduce((sum, item) => sum + Number(item.count || 0), 0)
    : total;
  const colors = ["#df4d78", "#cc3ba0", "#4775d1", "#d27a35", "#8d43d4", "#39b982"];
  chips.replaceChildren();
  const addChip = (name, count, index, active, onClick) => {
    const button = document.createElement("button");
    button.className = `category-chip${active ? " active" : ""}`;
    button.style.setProperty("--chip-color", colors[index % colors.length]);
    const label = document.createElement("span"); label.textContent = name;
    const number = document.createElement("b"); number.textContent = count;
    button.append(label, number);
    button.addEventListener("click", onClick);
    chips.append(button);
  };
  addChip("全部", scopeTotal, 0, parentPath
    ? state.categoryPrefix === parentPath
    : !state.category && !state.categoryPrefix && !state.groupId, () => {
    state.category = "";
    state.categoryPrefix = parentPath;
    state.groupId = null;
    loadNavigation(); loadEntries();
  });
  let colorIndex = 1;
  if (parentPath && parentDirectCount > 0 && children.size) {
    addChip("未分类", parentDirectCount, colorIndex++, selectedIsDirectView && selectedPath === parentPath, () => {
      state.category = parentPath;
      state.categoryPrefix = "";
      state.groupId = null;
      loadNavigation(); loadEntries();
    });
  }
  [...children.entries()].sort(([a], [b]) => a.localeCompare(b, "zh-CN", { numeric: true })).forEach(([path, count]) => {
    const active = selectedPath === path;
    addChip(path.split("/").at(-1), count, colorIndex++, active, () => {
      const hasChildren = items.some(item => item.name.startsWith(`${path}/`));
      state.category = hasChildren ? "" : path;
      state.categoryPrefix = hasChildren ? path : "";
      state.groupId = null;
      loadNavigation(); loadEntries();
    });
  });
  renderCategoryBreadcrumb(items);
}

function renderCategoryBreadcrumb(items) {
  const breadcrumb = $("#category-breadcrumb");
  breadcrumb.replaceChildren();
  const addButton = (label, path, current = false, exact = false) => {
    const button = document.createElement("button");
    button.className = `breadcrumb-button${current ? " current" : ""}`;
    button.textContent = label;
    button.addEventListener("click", () => {
      if (!path) {
        state.category = ""; state.categoryPrefix = ""; state.groupId = null;
      } else if (exact) {
        state.category = path;
        state.categoryPrefix = "";
        state.groupId = null;
      } else {
        const hasChildren = items.some(item => item.name.startsWith(`${path}/`));
        state.category = hasChildren ? "" : path;
        state.categoryPrefix = hasChildren ? path : "";
        state.groupId = null;
      }
      loadNavigation(); loadEntries();
    });
    breadcrumb.append(button);
  };
  addButton("全部", "", !state.category && !state.categoryPrefix && !state.groupId);
  if (state.groupId) {
    const group = groupsByKind[state.kind].find(item => item.id === state.groupId);
    if (group) {
      const separator = document.createElement("span"); separator.className = "breadcrumb-separator"; separator.textContent = "›"; breadcrumb.append(separator);
      addButton(`自定义分组 · ${group.name}`, "", true);
    }
    return;
  }
  const path = state.category || state.categoryPrefix;
  const directUnderParent = Boolean(
    state.category
    && items.some(item => item.name.startsWith(`${state.category}/`))
    && Number(items.find(item => item.name === state.category)?.count || 0) > 0
  );
  const parts = path.split("/").filter(Boolean);
  parts.forEach((part, index) => {
    const separator = document.createElement("span"); separator.className = "breadcrumb-separator"; separator.textContent = "›"; breadcrumb.append(separator);
    addButton(part, parts.slice(0, index + 1).join("/"), index === parts.length - 1 && !directUnderParent);
  });
  if (directUnderParent) {
    const separator = document.createElement("span"); separator.className = "breadcrumb-separator"; separator.textContent = "›"; breadcrumb.append(separator);
    addButton("未分类", state.category, true, true);
  }
}

function renderGroupList() {
  const list = $("#group-list");
  list.replaceChildren();
  groupsByKind[state.kind].forEach(group => {
    const button = document.createElement("button");
    button.className = `nav-item${state.groupId === group.id ? " active" : ""}`;
    const name = document.createElement("span"); name.textContent = group.name;
    const count = document.createElement("b"); count.textContent = group.count;
    button.append(name, count);
    button.addEventListener("click", () => {
      state.groupId = state.groupId === group.id ? null : group.id;
      if (state.kind === "prompt" && state.groupId) {
        state.category = "";
        state.categoryPrefix = "";
      }
      loadNavigation();
      loadEntries();
    });
    list.append(button);
  });
  if (!groupsByKind[state.kind].length) {
    const empty = document.createElement("p");
    empty.className = "group-empty";
    empty.textContent = "还没有自定义分组";
    list.append(empty);
  }
}

function renderCategoryTree(items, total = 0) {
  const list = $("#category-list");
  list.replaceChildren();
  const nodes = new Map();
  items.forEach(item => {
    const parts = item.name.split("/").filter(Boolean);
    parts.forEach((part, index) => {
      const path = parts.slice(0, index + 1).join("/");
      if (!nodes.has(path)) nodes.set(path, { name: part, path, children: new Set(), count: 0, directCount: 0, sortOrder: 0 });
      if (index === parts.length - 1) {
        nodes.get(path).count = Number(item.count || 0);
        nodes.get(path).sortOrder = Number(item.sort_order || 0);
      }
      if (index) nodes.get(parts.slice(0, index).join("/")).children.add(path);
    });
  });
  nodes.forEach(node => {
    const childCount = [...node.children]
      .map(path => Number(nodes.get(path)?.count || 0))
      .reduce((sum, count) => sum + count, 0);
    node.directCount = Math.max(0, node.count - childCount);
  });
  if (!expansionInitialized[state.kind]) {
    nodes.forEach(node => { if (node.children.size) expandedCategories[state.kind].add(node.path); });
    if (state.kind === "prompt") expandedCategories.prompt.add("__all_scenes__");
    expansionInitialized[state.kind] = true;
  }

  const categoryNodeSort = (a, b) => {
    const aCustom = a.sortOrder > 0;
    const bCustom = b.sortOrder > 0;
    if (aCustom !== bCustom) return aCustom ? -1 : 1;
    if (aCustom && a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.name.localeCompare(b.name, "zh-CN", { numeric: true });
  };

  function appendDropGap(parentPath, beforePath, depth) {
    const gap = document.createElement("div");
    gap.className = "category-drop-gap";
    gap.style.marginLeft = `${depth * 9 + 12}px`;
    gap.dataset.label = parentPath ? `放入 ${parentPath.split("/").at(-1)}` : "放到顶层";
    gap.addEventListener("dragover", event => {
      if (!draggedCategoryPath || draggedCategoryPath === beforePath) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      gap.classList.add("drag-over");
    });
    gap.addEventListener("dragleave", () => gap.classList.remove("drag-over"));
    gap.addEventListener("drop", event => {
      event.preventDefault();
      event.stopPropagation();
      gap.classList.remove("drag-over");
      const source = event.dataTransfer.getData("text/plain") || draggedCategoryPath;
      if (source && source !== beforePath) placeCategoryDirect(source, parentPath, beforePath);
    });
    list.append(gap);
  }

  function appendDirectUnclassified(node, depth) {
    const row = document.createElement("div");
    row.className = `category-row category-virtual-row category-level-${Math.min(depth + 1, 4)}`;
    row.style.paddingLeft = `${depth * 9}px`;
    const disclosure = document.createElement("button");
    disclosure.className = "category-disclosure";
    disclosure.disabled = true;
    const button = document.createElement("button");
    button.className = `nav-item category-virtual${state.category === node.path ? " active" : ""}`;
    button.title = `只显示直接位于“${node.path}”且尚未进入二级目录的资料`;
    const name = document.createElement("span"); name.textContent = "未分类";
    const count = document.createElement("b"); count.textContent = node.directCount;
    button.append(name, count);
    button.addEventListener("click", () => {
      if (state.kind === "prompt") state.groupId = null;
      state.category = node.path;
      state.categoryPrefix = "";
      loadNavigation();
      loadEntries();
    });
    row.append(disclosure, button);
    list.append(row);
  }

  function appendNode(node, depth) {
    const hasChildren = node.children.size > 0;
    const expanded = hasChildren && expandedCategories[state.kind].has(node.path);
    const active = hasChildren ? state.categoryPrefix === node.path : state.category === node.path;
    const row = document.createElement("div");
    row.className = `category-row category-level-${Math.min(depth + 1, 4)}`;
    row.style.paddingLeft = `${depth * 9}px`;
    const disclosure = document.createElement("button");
    disclosure.className = "category-disclosure";
    disclosure.disabled = !hasChildren;
    disclosure.textContent = hasChildren ? (expanded ? "▾" : "▸") : "";
    disclosure.title = expanded ? "折叠子目录" : "展开子目录";
    disclosure.addEventListener("click", () => {
      if (expanded) expandedCategories[state.kind].delete(node.path);
      else expandedCategories[state.kind].add(node.path);
      renderCategoryTree(items, total);
    });
    const button = document.createElement("button");
    button.className = `nav-item${hasChildren ? " category-parent" : ""}${active ? " active" : ""}`;
    button.title = `${node.path}（拖到标题上可合并）`;
    button.draggable = true;
    button.addEventListener("dragstart", event => {
      draggedCategoryPath = node.path;
      libraryBody.classList.add("category-dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", node.path);
      row.classList.add("dragging");
    });
    button.addEventListener("dragend", () => {
      draggedCategoryPath = "";
      stopCategoryAutoScroll();
      libraryBody.classList.remove("category-dragging");
      row.classList.remove("dragging");
      libraryRoot.querySelectorAll(".drag-over").forEach(item => item.classList.remove("drag-over"));
    });
    row.addEventListener("dragover", event => {
      if (!draggedCategoryPath || draggedCategoryPath === node.path) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      row.classList.add("drag-over");
    });
    row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
    row.addEventListener("drop", event => {
      event.preventDefault();
      event.stopPropagation();
      row.classList.remove("drag-over");
      const source = event.dataTransfer.getData("text/plain") || draggedCategoryPath;
      if (source && source !== node.path) mergeCategoryDirect(source, node.path);
    });
    const name = document.createElement("span"); name.textContent = node.name;
    const count = document.createElement("b"); count.textContent = node.count;
    button.append(name, count);
    button.addEventListener("click", () => {
      if (state.kind === "prompt") state.groupId = null;
      if (hasChildren) {
        state.categoryPrefix = state.categoryPrefix === node.path ? "" : node.path;
        state.category = "";
      } else {
        state.category = state.category === node.path ? "" : node.path;
        state.categoryPrefix = "";
      }
      loadNavigation(); loadEntries();
    });
    row.append(disclosure, button);
    list.append(row);
    const children = [...node.children].map(path => nodes.get(path)).sort(categoryNodeSort);
    if (expanded) {
      if (node.directCount > 0) appendDirectUnclassified(node, depth + 1);
      appendSiblings(children, depth + 1, node.path);
    }
    else appendDropGap(node.path, "", depth + 1);
  }

  function appendSiblings(siblings, depth, parentPath) {
    appendDropGap(parentPath, siblings[0]?.path || "", depth);
    siblings.forEach((node, index) => {
      appendNode(node, depth);
      appendDropGap(parentPath, siblings[index + 1]?.path || "", depth);
    });
  }

  const rootNodes = [...nodes.values()].filter(node => !node.path.includes("/")).sort(categoryNodeSort);
  if (state.kind === "prompt") {
    const sceneRootKey = "__all_scenes__";
    const expanded = expandedCategories.prompt.has(sceneRootKey);
    const row = document.createElement("div");
    row.className = "category-row category-root-row";
    const disclosure = document.createElement("button");
    disclosure.className = "category-disclosure";
    disclosure.textContent = expanded ? "▾" : "▸";
    disclosure.title = expanded ? "折叠全部场景目录" : "展开全部场景目录";
    disclosure.addEventListener("click", () => {
      if (expanded) expandedCategories.prompt.delete(sceneRootKey);
      else expandedCategories.prompt.add(sceneRootKey);
      renderCategoryTree(items, total);
    });
    const button = document.createElement("button");
    button.className = `nav-item category-zero${!state.category && !state.categoryPrefix && !state.groupId ? " active" : ""}`;
    const name = document.createElement("span"); name.textContent = "全部场景";
    const count = document.createElement("b"); count.textContent = total;
    button.append(name, count);
    button.addEventListener("click", () => {
      state.category = ""; state.categoryPrefix = ""; state.groupId = null;
      loadNavigation(); loadEntries();
    });
    row.append(disclosure, button);
    list.append(row);
    if (expanded) appendSiblings(rootNodes, 1, "");
  } else {
    appendSiblings(rootNodes, 0, "");
  }
}

function updateActiveFilter() {
  const values = [];
  const directoryScopeActive = !state.q || state.searchScope === "directory";
  if (directoryScopeActive && state.category) {
    const directUnderParent = categoriesByKind[state.kind].some(item => item.name.startsWith(`${state.category}/`))
      && Number(categoriesByKind[state.kind].find(item => item.name === state.category)?.count || 0) > 0;
    values.push(`目录：${state.category}${directUnderParent ? "/未分类" : ""}`);
  }
  else if (directoryScopeActive && state.categoryPrefix) values.push(`目录：${state.categoryPrefix}（含子目录）`);
  if (selectedArtistRatings().length) values.push("评分：" + selectedArtistRatings().map(value => value === "unrated" ? "未评分" : Number(value) / 2 + "★").join("、"));
  if (state.style) values.push(`风格：${state.style}`);
  if (state.styleUnclassified) values.push("风格：未分类");
  if (state.imageFilter === "with") values.push("仅有图卡片");
  if (state.imageFilter === "without") values.push("仅无图卡片");
  if (state.q) {
    values.push(`关键词：${state.q}`, state.searchScope === "all" ? (state.kind === "artist" ? "范围：全部画师串" : "范围：全部场景") : "范围：当前目录");
    if (state.searchScope === "all" && state.searchField !== "all") {
      const labels = { title: "标题", content: "正向词", negative: "负向词", tags: "标签", path: "路径" };
      values.push(`搜索字段：${labels[state.searchField]}`);
    }
  }
  if (state.favoritesOnly) values.push("仅查看收藏");
  if (directoryScopeActive && state.groupId) {
    const group = groupsByKind[state.kind].find(item => item.id === state.groupId);
    if (group) values.push(`分组：${group.name}`);
  }
  const node = $("#active-filter");
  node.hidden = !values.length;
  node.textContent = values.length ? `当前筛选 · ${values.join(" · ")}` : "";
}

async function setKind(kind) {
  setSelectionMode(false);
  $("#library-menu").hidden = true;
  $("#library-menu-toggle").setAttribute("aria-expanded", "false");
  if (!["artist", "prompt"].includes(kind) || kind === state.kind) return;

  persistViewState(captureViewPosition());
  const position = applyLibraryViewState(savedLibraryViewState(kind), kind);
  syncViewControls();
  imageFilterGraceIds.clear();
  restoringViewPosition = true;
  try {
    await Promise.all([loadNavigation(), loadEntries(true, position?.loadedCount)]);
    if (position) {
      await restoreViewPosition(position);
    } else {
      window.scrollTo(0, 0);
      $("#category-list").scrollTop = 0;
    }
    persistViewState(position || captureViewPosition());
  } finally {
    restoringViewPosition = false;
  }
}

function updateFormKind() {
  const artist = $("#entry-kind").value === "artist";
  const negativeLibrary = $("#entry-category").value.trim() === "负面提示词";
  $("#rating-field").hidden = !artist;
  $("#style-field").hidden = !artist;
  $("#content-label").textContent = negativeLibrary ? "负面提示词内容" : (artist ? "画师串 / 正向提示词" : "场景正向提示词");
}

function populateGroupOptions(kind, selectedGroups = []) {
  const selectedIds = new Set(selectedGroups.map(group => Number(group.id)));
  const select = $("#entry-groups");
  select.replaceChildren();
  groupsByKind[kind].forEach(group => {
    const option = document.createElement("option");
    option.value = group.id;
    option.textContent = group.name;
    option.selected = selectedIds.has(group.id);
    select.append(option);
  });
}

function categoryPathParent(path) {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

function renderCategoryPicker(kind, selectedPath = "", pickerSelector = "#entry-category-picker", hiddenSelector = "#entry-category", onChange = updateFormKind) {
  const picker = $(pickerSelector);
  const hidden = $(hiddenSelector);
  const known = new Set(["未分类"]);
  const orderMap = new Map();
  (categoriesByKind[kind] || []).forEach(item => {
    const parts = item.name.split("/").filter(Boolean);
    parts.forEach((_, index) => known.add(parts.slice(0, index + 1).join("/")));
    orderMap.set(item.name, Number(item.sort_order || 0));
  });
  if (selectedPath) {
    const parts = selectedPath.split("/").filter(Boolean);
    parts.forEach((_, index) => known.add(parts.slice(0, index + 1).join("/")));
  }
  const sortPaths = (a, b) => {
    const ao = orderMap.get(a) || 0;
    const bo = orderMap.get(b) || 0;
    if ((ao > 0) !== (bo > 0)) return ao > 0 ? -1 : 1;
    if (ao > 0 && ao !== bo) return ao - bo;
    return a.localeCompare(b, "zh-CN", { numeric: true });
  };
  picker.replaceChildren();
  let parent = "";
  let level = 1;
  while (level <= 12) {
    const parentAtLevel = parent;
    const children = [...known].filter(path => categoryPathParent(path) === parent).sort(sortPaths);
    if (!children.length) break;
    const select = document.createElement("select");
    select.setAttribute("aria-label", `第 ${level} 级目录`);
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = level === 1 ? "选择一级目录" : "使用当前目录 / 选择下一级";
    select.append(placeholder);
    children.forEach(path => {
      const option = document.createElement("option");
      option.value = path;
      option.textContent = path.split("/").at(-1);
      select.append(option);
    });
    const selectedChild = children.find(path => selectedPath === path || selectedPath.startsWith(`${path}/`)) || "";
    select.value = selectedChild;
    select.addEventListener("change", () => {
      const nextPath = select.value || parentAtLevel || "未分类";
      hidden.value = nextPath;
      renderCategoryPicker(kind, nextPath, pickerSelector, hiddenSelector, onChange);
      onChange();
    });
    picker.append(select);
    if (!selectedChild) break;
    parent = selectedChild;
    level += 1;
  }
  hidden.value = selectedPath || parent || "未分类";
}

function openEditor(entry = null) {
  editorViewSnapshot = captureViewPosition(entry?.id || null);
  $("#entry-form").reset();
  $("#entry-id").value = entry?.id || "";
  $("#dialog-title").textContent = entry ? "编辑资料" : "新建资料";
  $("#entry-kind").value = entry?.kind || state.kind;
  $("#entry-title").value = entry?.title || "";
  $("#entry-rating").value = entry?.rating || "";
  $("#entry-style").value = entry?.style || "";
  const styleSuggestions = $("#artist-style-suggestions");
  styleSuggestions.replaceChildren(...artistStyles.filter(item => item.name).map(item => {
    const option = document.createElement("option");
    option.value = item.name;
    return option;
  }));
  $("#reveal-after-save").checked = localStorage.getItem(REVEAL_AFTER_SAVE_KEY) !== "false";
  const category = entry?.category || state.category || state.categoryPrefix || "未分类";
  $("#entry-category").value = category;
  renderCategoryPicker($("#entry-kind").value, category);
  $("#entry-content").value = entry?.content || "";
  $("#entry-negative").value = entry?.negative_prompt || "";
  $("#entry-tags").value = (entry?.tags || []).join(", ");
  populateGroupOptions($("#entry-kind").value, entry?.groups || []);
  $("#delete-entry").hidden = !entry;
  updateFormKind();
  $("#edit-dialog").showModal();
}

async function saveEntry(event) {
  event.preventDefault();
  const id = $("#entry-id").value;
  const isNew = !id;
  const groupIds = Array.from($("#entry-groups").selectedOptions, option => Number(option.value));
  const payload = {
    kind: $("#entry-kind").value,
    title: $("#entry-title").value,
    rating: $("#entry-rating").value || null,
    style: $("#entry-kind").value === "artist" ? $("#entry-style").value.trim() : "",
    category: $("#entry-category").value || "未分类",
    content: $("#entry-content").value,
    negative_prompt: $("#entry-negative").value,
    tags: $("#entry-tags").value,
    ...(isNew ? { group_ids: groupIds } : {}),
  };
  let savedId = id;
  try {
    const result = await api(id ? `/api/entries/${id}` : "/api/entries", { method: id ? "PUT" : "POST", body: JSON.stringify(payload) });
    savedId = id || result.id;
    // New entries save groups atomically with the entry itself.
    if (!isNew) {
      await api(`/api/entries/${savedId}/groups`, { method: "PUT", body: JSON.stringify({ group_ids: groupIds }) });
    }
    const files = Array.from($("#entry-images").files || []);
    if (files.length) {
      const formData = new FormData();
      files.forEach(file => formData.append("images", file));
      const uploadResponse = await fetch(`/api/entries/${savedId}/images`, { method: "POST", body: formData });
      if (!uploadResponse.ok) throw new Error((await uploadResponse.text()) || "图片上传失败");
    }
    const folderPath = $("#entry-folder").value.trim();
    let folderJob = null;
    if (folderPath) {
      folderJob = await api(`/api/entries/${savedId}/link-folder`, {
        method: "POST", body: JSON.stringify({ path: folderPath, recursive: true })
      });
    }
    if (!isNew && state.imageFilter === "without" && (files.length || folderPath)) {
      imageFilterGraceIds.add(Number(savedId));
    }
    $("#edit-dialog").close();
    if (folderJob) {
      showToast("资料已保存，图片文件夹正在后台扫描");
    }
    else showToast(files.length ? `资料已保存，并添加 ${files.length} 张图片` : "资料已保存");
    if ($("#reveal-after-save").checked) {
      await revealSavedEntry(Number(savedId), payload);
    } else if (editorViewSnapshot) {
      await reloadPreservingView(editorViewSnapshot);
    } else {
      await Promise.all([loadNavigation(), loadEntries(true)]);
    }
    if (folderJob) watchBackgroundJob(folderJob.id);
    editorViewSnapshot = null;
  } catch (error) {
    showToast(savedId && isNew ? `资料主体已保存，但后续处理失败：${error.message}` : error.message);
  }
}

async function watchBackgroundJob(jobId) {
  while (true) {
    await new Promise(resolve => setTimeout(resolve, 700));
    try {
      const job = await api(`/api/jobs/${jobId}`);
      if (job.status === "completed") {
        const result = job.result;
        showToast(`后台扫描完成：关联 ${result.added} 张，复用 ${result.reused} 张，失败 ${result.failed} 张`);
        await reloadPreservingView();
        return;
      }
      if (job.status === "failed") {
        showToast(`后台扫描失败：${job.error}`);
        return;
      }
      if (job.total) showToast(`${job.phase}：${job.processed} / ${job.total}`);
    } catch (error) {
      showToast(error.message);
      return;
    }
  }
}

async function deleteEntry() {
  const id = $("#entry-id").value;
  if (!id || !confirm("删除这条资料，并永久清理无人引用的原图副本及缩略图？共享图片和外部关联原文件保留。")) return;
  const result = await api(`/api/entries/${id}`, { method: "DELETE" });
  $("#edit-dialog").close(); showToast("资料记录已删除");
  await reloadPreservingView(editorViewSnapshot);
  editorViewSnapshot = null;
  showCleanupResult(result?.cleanup);
}

function showCleanupResult(result) {
  if (!result) return;
  if (result.queued) {
    showToast("资料已删除，原图副本正在后台清理");
    let polls = 0;
    const poll = async () => {
      try {
        const response = await fetch("/api/jobs/" + result.job_id);
        if (!response.ok) throw new Error("后台状态暂不可用");
        const job = await response.json();
        if (job.status === "completed") { showCleanupResult(job.result); return; }
        if (job.status === "failed") { showToast("资料已删除；后台清理未完成，可在图片检查与空间清理中重试"); return; }
        if (++polls < 120) setTimeout(poll, 2000);
      } catch { showToast("资料已删除；清理任务已记入本地队列，可稍后检查"); }
    };
    setTimeout(poll, 1000);
    return;
  }
  showToast(result.errors?.length
    ? `资料已移除，${result.errors.length} 个文件清理失败；请在“图片检查与空间清理”重试`
    : `已清理 ${result.removed_files} 个无引用副本文件（${formatMaintenanceBytes(result.removed_bytes)}）`);
}

function formatMaintenanceBytes(value) {
  return `${(Number(value || 0) / 1024 / 1024).toFixed(2)} MB`;
}

let maintenanceReport = null;
let maintenanceMarkdown = '';
let maintenancePreview = null;
let maintenancePage = 1;
let maintenanceRunning = false;
const maintenanceTypes = [
  ['missing_originals', '原图缺失 / 无法读取'], ['missing_thumbnails', '缩略图缺失'],
  ['images_without_prompt', '图片无可读取提示词'], ['prompt_mismatches', '提示词疑似不匹配'],
  ['unrecorded_character_prompts', '角色提示词疑似遗漏'], ['shared_by_three_or_more', '三张以上卡片共享图片'],
];

function renderMaintenanceReport() {
  if (!maintenanceReport) return;
  const rows = maintenanceReport[$('#maintenance-filter').value] || [];
  const pages = Math.max(1, Math.ceil(rows.length / 30));
  maintenancePage = Math.min(maintenancePage, pages);
  const container = $('#maintenance-results');
  container.replaceChildren();
  for (const item of rows.slice((maintenancePage - 1) * 30, maintenancePage * 30)) {
    const row = document.createElement('div'); row.className = 'maintenance-result-row';
    const title = document.createElement('strong');
    title.textContent = `图片 #${item.asset_id} · ${item.entry_title || (item.entry_titles || []).join('、') || '无关联卡片'}`;
    const path = document.createElement('small'); path.textContent = item.path;
    row.append(title, path);
    if (item.coverage != null) {
      const metric = document.createElement('span'); metric.textContent = `提示词覆盖率：${Math.round(item.coverage * 100)}%`; row.append(metric);
    }
    const ids = item.entry_id ? [item.entry_id] : item.entry_ids || [];
    for (const id of ids) {
      const button = document.createElement('button'); button.className = 'secondary-button';
      button.type = 'button'; button.textContent = `定位卡片 #${id}`;
      button.addEventListener('click', async () => {
        try { const entry = await api(`/api/entries/${id}`); $('#export-dialog').close(); await revealSavedEntry(id, entry); }
        catch (error) { showToast(error.message); }
      });
      row.append(button);
    }
    container.append(row);
  }
  if (!rows.length) container.textContent = '本项没有发现问题。';
  $('#maintenance-page').textContent = `${maintenancePage} / ${pages} · ${rows.length} 项`;
  $('#maintenance-prev').disabled = maintenancePage <= 1;
  $('#maintenance-next').disabled = maintenancePage >= pages;
}

async function runMaintenance(operation) {
  if (maintenanceRunning) return;
  if (operation === 'cleanup' && (!maintenancePreview || !confirm(`永久清理预览中的 ${maintenancePreview.files} 个副本文件（${formatMaintenanceBytes(maintenancePreview.bytes)}）？\n执行前会重新核对引用，不会删除仍被卡片使用的图片或外部原文件。此操作不可撤销。`))) return;
  maintenanceRunning = true;
  libraryRoot.querySelectorAll('.maintenance-action').forEach(button => { button.disabled = true; });
  const status = $('#maintenance-status');
  const progress = $('#maintenance-progress'); progress.hidden = false; progress.removeAttribute('value');
  status.textContent = '正在启动后台任务…';
  try {
    const started = await api('/api/library-maintenance/jobs', { method: 'POST', body: JSON.stringify({
      operation, token: maintenancePreview?.token,
      deep: $('#maintenance-deep').checked, full: $('#maintenance-full').checked,
    }) });
    if (operation !== 'audit') { maintenancePreview = null; $('#maintenance-preview-result').hidden = true; }
    let job;
    do {
      await new Promise(resolve => setTimeout(resolve, 600));
      job = await api(`/api/jobs/${started.id}`);
      status.textContent = `${job.phase}${job.total != null ? ` · ${job.processed} / ${job.total}` : ''}`;
      if (job.total != null) { progress.max = Math.max(1, job.total); progress.value = job.processed; }
      if (job.status === 'failed') throw new Error(job.error || '任务失败');
    } while (job.status !== 'completed');
    progress.max = 1; progress.value = 1;
    const result = job.result;
    if (operation === 'audit') {
      maintenanceReport = result.report; maintenanceMarkdown = result.markdown; maintenancePage = 1;
      const summary = maintenanceReport.summary;
      $('#maintenance-summary').textContent = `检查 ${summary.assets} 张图片，读取 ${summary.scanned} 张、复用缓存 ${summary.cached} 张，用时 ${summary.elapsed_seconds} 秒。`;
      const filter = $('#maintenance-filter'); filter.replaceChildren();
      for (const [key, label] of maintenanceTypes) { const option = document.createElement('option'); option.value = key; option.textContent = `${label} · ${maintenanceReport[key]?.length || 0}`; filter.append(option); }
      $('#maintenance-audit-result').hidden = false; renderMaintenanceReport();
    } else if (operation === 'preview') {
      maintenancePreview = result;
      const preview = $('#maintenance-preview-result'); preview.hidden = false; preview.replaceChildren();
      const summary = document.createElement('p'); summary.textContent = `可清理 ${result.assets} 条无引用资产、${result.files} 个副本文件，共 ${formatMaintenanceBytes(result.bytes)}。保留 ${result.external_kept} 个外部原文件。预览有效期 30 分钟。`; preview.append(summary);
      const examples = document.createElement('pre'); examples.textContent = result.examples.join('\n') || '没有可清理文件。'; preview.append(examples);
    } else {
      status.textContent = `清理完成：${result.removed_files} 个文件，释放 ${formatMaintenanceBytes(result.removed_bytes)}；跳过 ${result.skipped} 项，失败 ${result.errors.length} 项。`;
      if (result.errors.length) { const preview = $('#maintenance-preview-result'); preview.hidden = false; preview.textContent = result.errors.map(item => `${item.path}：${item.error}`).join('\n'); }
    }
    if (operation !== 'cleanup') status.textContent = '检查完成。';
  } catch (error) { status.textContent = `未完成：${error.message}`; showToast(error.message); }
  finally {
    maintenanceRunning = false;
    libraryRoot.querySelectorAll('.maintenance-action').forEach(button => { button.disabled = false; });
    $('#maintenance-cleanup').disabled = !maintenancePreview || (!maintenancePreview.files && !maintenancePreview.assets);
  }
}

function safeFence(value) {
  return String(value || "").replaceAll("```", "``\u200b`");
}

function desktopBridge() {
  try { return window.pywebview?.api || window.parent?.pywebview?.api; }
  catch { return window.pywebview?.api; }
}

async function downloadText(filename, content, type) {
  const bridge = desktopBridge();
  if (bridge?.save_text) {
    const result = await bridge.save_text(content, filename);
    if (result?.cancelled) return false;
    if (!result?.ok) throw new Error(result?.error || "Windows 保存接口没有返回成功状态");
    return true;
  }
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  libraryBody.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

async function exportCurrentMarkdown() {
  const now = new Date();
  const title = state.kind === "artist" ? "画师串库" : "场景提示词库";
  const entries = [];
  let offset = 0;
  while (true) {
    const batch = await api(`/api/entries?${entryQueryParams(1000, offset)}`);
    entries.push(...batch.entries);
    offset += batch.entries.length;
    if (!batch.entries.length || offset >= batch.total) break;
  }
  const lines = [`# ${title}导出`, "", `导出时间：${now.toLocaleString("zh-CN")}`, `资料数量：${entries.length}`, ""];
  entries.forEach((entry, index) => {
    lines.push(`## ${index + 1}. ${entry.title}`, "", `- 目录：${entry.category || "未分类"}`);
    if (entry.rating) lines.push(`- 评分：${entry.rating / 2} / 5`);
    else if (entry.kind === "artist" && entry.category !== "负面提示词") lines.push("- 评分：未评分");
    lines.push(`- 收藏：${entry.favorite ? "是" : "否"}`, "", entry.category === "负面提示词" ? "### 负面提示词" : "### 正向提示词", "", "```text", safeFence(entry.content), "```", "");
    if (entry.negative_prompt) lines.push("### 负面提示词", "", "```text", safeFence(entry.negative_prompt), "```", "");
    if (entry.images.length) {
      lines.push("### 图片", "");
      entry.images.forEach(image => lines.push(`- ${image.external_path || image.path}`));
      lines.push("");
    }
  });
  const stamp = now.toISOString().slice(0, 19).replaceAll(":", "-");
  const saved = await downloadText(`${title}-${stamp}.md`, `\ufeff${lines.join("\n")}`, "text/markdown;charset=utf-8");
  if (saved) showToast(`已导出当前筛选下的 ${entries.length} 条资料`);
}

async function createBackup() {
  const button = $("#create-backup");
  const resultNode = $("#backup-result");
  button.disabled = true;
  button.textContent = "正在创建…";
  try {
    const result = await api("/api/backups", { method: "POST", body: "{}" });
    resultNode.hidden = false;
    resultNode.replaceChildren(document.createTextNode(`备份完成：${result.path}（${(result.size / 1024 / 1024).toFixed(1)} MB）`));
    const bridge = desktopBridge();
    if (bridge?.show_in_folder) {
      const reveal = document.createElement("button");
      reveal.type = "button";
      reveal.className = "secondary-button backup-reveal";
      reveal.textContent = "在文件夹中显示";
      reveal.addEventListener("click", () => bridge.show_in_folder(result.path));
      resultNode.append(reveal);
    }
    showToast("完整备份已创建");
  } catch (error) {
    resultNode.hidden = false;
    resultNode.textContent = `备份失败：${error.message}`;
  } finally {
    button.disabled = false;
    button.textContent = "创建备份";
  }
}

function currentCategoryPath() {
  return state.category || state.categoryPrefix || "";
}

async function refreshAfterCategoryMove(message) {
  state.category = "";
  state.categoryPrefix = "";
  expandedCategories[state.kind].clear();
  expansionInitialized[state.kind] = false;
  await Promise.all([loadNavigation(), loadEntries()]);
  showToast(message);
}

async function mergeCategoryDirect(source, target) {
  if (!confirm(`把“${source}”合并到“${target}”吗？\n资料会归入目标目录，图片不会删除。`)) return;
  try {
    await api("/api/categories", {
      method: "PUT",
      body: JSON.stringify({ kind: state.kind, old_path: source, new_path: target }),
    });
    await refreshAfterCategoryMove("目录已合并");
  } catch (error) { showToast(error.message); }
}

async function placeCategoryDirect(source, parentPath, beforePath) {
  try {
    await api("/api/categories/place", {
      method: "PUT",
      body: JSON.stringify({ kind: state.kind, source_path: source, parent_path: parentPath, before_path: beforePath }),
    });
    await refreshAfterCategoryMove(parentPath ? `已放入“${parentPath}”` : "顶层顺序已调整");
  } catch (error) { showToast(error.message); }
}

async function addCategory() {
  const parent = currentCategoryPath();
  const path = prompt("输入新目录路径（使用 / 分隔层级）：", parent ? `${parent}/新目录` : "新目录");
  if (!path?.trim()) return;
  try {
    const result = await api("/api/categories", { method: "POST", body: JSON.stringify({ kind: state.kind, path }) });
    state.category = result.path;
    state.categoryPrefix = "";
    expansionInitialized[state.kind] = false;
    await Promise.all([loadNavigation(), loadEntries()]);
    showToast(result.created ? "目录已新增" : "目录已存在");
  } catch (error) { showToast(error.message); }
}

async function renameCategory() {
  const oldPath = currentCategoryPath();
  if (!oldPath) return showToast("请先在左侧选择一个目录");
  const newPath = prompt("输入新的完整目录路径；修改父级路径即可移动目录：", oldPath);
  if (!newPath?.trim() || newPath.trim() === oldPath) return;
  try {
    const result = await api("/api/categories", { method: "PUT", body: JSON.stringify({ kind: state.kind, old_path: oldPath, new_path: newPath }) });
    state.category = result.new_path;
    state.categoryPrefix = "";
    expandedCategories[state.kind].clear();
    expansionInitialized[state.kind] = false;
    await Promise.all([loadNavigation(), loadEntries()]);
    showToast("目录已改名或移动");
  } catch (error) { showToast(error.message); }
}

async function deleteCategory() {
  const path = currentCategoryPath();
  if (!path) return showToast("请先在左侧选择一个目录");
  if (!confirm(`删除目录“${path}”及其子目录吗？\n其中的资料会移到“未分类”，图片文件不会删除。`)) return;
  try {
    const result = await api("/api/categories", { method: "DELETE", body: JSON.stringify({ kind: state.kind, path }) });
    state.category = "";
    state.categoryPrefix = "";
    expansionInitialized[state.kind] = false;
    await Promise.all([loadNavigation(), loadEntries()]);
    showToast(`目录已删除，${result.moved_entries} 条资料移到未分类`);
  } catch (error) { showToast(error.message); }
}

function currentGroup() {
  return groupsByKind[state.kind].find(group => group.id === state.groupId) || null;
}

async function addGroup() {
  const name = prompt("输入新分组名称：", state.kind === "prompt" ? "测试用" : "常用画师串");
  if (!name?.trim()) return;
  try {
    const result = await api("/api/groups", { method: "POST", body: JSON.stringify({ kind: state.kind, name }) });
    state.groupId = result.id;
    await Promise.all([loadNavigation(), loadEntries()]);
    showToast(result.created ? "分组已新增" : "已切换到现有分组");
  } catch (error) { showToast(error.message); }
}

async function renameGroup() {
  const group = currentGroup();
  if (!group) return showToast("请先选择一个自定义分组");
  const name = prompt("输入新的分组名称：", group.name);
  if (!name?.trim() || name.trim() === group.name) return;
  try {
    await api(`/api/groups/${group.id}`, { method: "PUT", body: JSON.stringify({ name }) });
    await loadNavigation();
    updateActiveFilter();
    showToast("分组已重命名");
  } catch (error) { showToast(error.message); }
}

async function deleteGroup() {
  const group = currentGroup();
  if (!group) return showToast("请先选择一个自定义分组");
  if (!confirm(`删除分组“${group.name}”吗？资料卡和图片都不会被删除。`)) return;
  try {
    await api(`/api/groups/${group.id}`, { method: "DELETE" });
    state.groupId = null;
    await Promise.all([loadNavigation(), loadEntries()]);
    showToast("分组已删除，资料卡已保留");
  } catch (error) { showToast(error.message); }
}

function updateBatchToolbar() {
  $("#selected-count").textContent = state.selectedIds.size;
  $("#delete-selected").disabled = state.selectedIds.size === 0;
  $("#move-selected").disabled = state.selectedIds.size === 0;
  libraryRoot.querySelectorAll(".card").forEach(card => {
    const selected = state.selectedIds.has(Number(card.dataset.entryId));
    card.classList.toggle("selected", selected);
    const checkbox = card.querySelector(".card-select");
    if (checkbox) checkbox.checked = selected;
  });
}

function openBatchMoveDialog() {
  if (!state.selectedIds.size) return showToast("请先选择需要移动的资料");
  const initialPath = state.category || state.categoryPrefix || "未分类";
  $("#batch-move-count").textContent = state.selectedIds.size;
  $("#batch-move-category").value = initialPath;
  renderCategoryPicker(state.kind, initialPath, "#batch-move-category-picker", "#batch-move-category", () => {});
  $("#batch-move-dialog").showModal();
}

async function moveSelectedEntries(event) {
  event.preventDefault();
  const ids = [...state.selectedIds];
  const category = $("#batch-move-category").value || "未分类";
  if (!ids.length) return $("#batch-move-dialog").close();
  const button = $("#batch-move-form button[type='submit']");
  button.disabled = true;
  try {
    const position = captureViewPosition();
    const result = await api("/api/entries/batch-move", {
      method: "POST",
      body: JSON.stringify({ ids, kind: state.kind, category }),
    });
    $("#batch-move-dialog").close();
    setSelectionMode(false);
    await reloadPreservingView(position);
    showToast(`已将 ${result.moved} 条资料移动到“${result.category}”`);
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
}

function setSelectionMode(enabled) {
  state.selectionMode = enabled;
  if (!enabled) state.selectedIds.clear();
  libraryBody.classList.toggle("selection-mode", enabled);
  $("#batch-toolbar").hidden = !enabled;
  $("#batch-mode").textContent = enabled ? "退出批量管理" : "批量管理";
  updateBatchToolbar();
}

async function selectAllCurrentResults() {
  const button = $("#select-all");
  button.disabled = true;
  button.textContent = "正在选择…";
  try {
    const params = entryQueryParams(1, 0);
    params.delete("limit");
    params.delete("offset");
    const result = await api(`/api/entries/ids?${params}`);
    state.selectedIds = new Set(result.ids);
    updateBatchToolbar();
    showToast(`已选择当前筛选下的 ${result.total} 条资料`);
  } catch (error) { showToast(error.message); }
  finally {
    button.disabled = false;
    button.textContent = "全选当前结果";
  }
}

async function deleteSelectedEntries() {
  const ids = [...state.selectedIds];
  if (!ids.length) return;
  if (!confirm(`删除选中的 ${ids.length} 条资料，并永久清理无人引用的原图副本和缩略图？\n共享图片及外部关联原文件保留。此操作不能撤销。`)) return;
  try {
    const result = await api("/api/entries/batch-delete", { method: "POST", body: JSON.stringify({ ids }) });
    setSelectionMode(false);
    await Promise.all([loadNavigation(), loadEntries()]);
    showToast(`已删除 ${result.deleted} 条资料`);
    showCleanupResult(result.cleanup);
  } catch (error) { showToast(error.message); }
}

function applyTheme(theme) {
  libraryBody.dataset.theme = theme;
  const icon = $("#theme-icon");
  const label = $("#theme-label");
  if (icon) icon.textContent = theme === "light" ? "☾" : "☀";
  if (label) label.textContent = theme === "light" ? "切换深色主题" : "切换浅色主题";
  $("#theme-toggle").title = theme === "light" ? "切换到深色主题" : "切换到浅色主题";
  localStorage.setItem("nai-library-theme", theme);
}

function resetEntriesAndLoad() {
  loadEntries();
}

for (let score = 1; score <= 10; score++) {
  const option = document.createElement("option"); option.value = score; option.textContent = `${score / 2}★`; $("#entry-rating").append(option);
}
libraryRoot.querySelectorAll(".module-button").forEach(button => button.addEventListener("click", () => {
  setKind(button.dataset.kind).catch(error => showToast(error.message));
}));
$("#library-menu-toggle").addEventListener("click", event => {
  event.stopPropagation();
  const menu = $("#library-menu");
  menu.hidden = !menu.hidden;
  $("#library-menu-toggle").setAttribute("aria-expanded", String(!menu.hidden));
});
$("#library-menu").addEventListener("click", event => event.stopPropagation());
$("#utility-menu-toggle").addEventListener("click", event => {
  event.stopPropagation();
  const menu = $("#utility-menu");
  menu.hidden = !menu.hidden;
  $("#utility-menu-toggle").classList.toggle("active", !menu.hidden);
  $("#utility-menu-toggle").setAttribute("aria-expanded", String(!menu.hidden));
});
$("#utility-menu").addEventListener("click", event => {
  if (event.target.closest("#image-filter-toggle, #image-filter-menu")) event.stopPropagation();
});
$("#search-field-toggle").addEventListener("click", event => {
  event.stopPropagation();
  const menu = $("#search-field-menu");
  menu.hidden = !menu.hidden;
  $("#search-field-toggle").classList.toggle("active", !menu.hidden);
  $("#search-field-toggle").setAttribute("aria-expanded", String(!menu.hidden));
});
$("#search-field-menu").addEventListener("click", event => event.stopPropagation());
libraryRoot.querySelectorAll("#search-field-menu button").forEach(button => button.addEventListener("click", () => {
  $("#search-field").value = button.dataset.searchField || "all";
  $("#search-field").dispatchEvent(new Event("change", { bubbles: true }));
  $("#search-field-menu").hidden = true;
  $("#search-field-toggle").classList.remove("active");
  $("#search-field-toggle").setAttribute("aria-expanded", "false");
}));


libraryRoot.addEventListener("click", () => {
  $("#library-menu").hidden = true;
  $("#library-menu-toggle").setAttribute("aria-expanded", "false");
  $("#image-filter-menu").hidden = true;
  $("#image-filter-toggle").setAttribute("aria-expanded", "false");
  $("#utility-menu").hidden = true;
  $("#utility-menu-toggle").classList.remove("active");
  $("#utility-menu-toggle").setAttribute("aria-expanded", "false");
  $("#search-field-menu").hidden = true;
  $("#search-field-toggle").classList.remove("active");
  $("#search-field-toggle").setAttribute("aria-expanded", "false");
});
libraryRoot.addEventListener("dragover", event => {
  if (draggedCategoryPath) updateCategoryAutoScroll(event.clientX, event.clientY);
  if (draggedEntryId) updateEntryAutoScroll(event.clientY);
}, true);
libraryRoot.addEventListener("drop", () => {
  stopCategoryAutoScroll();
  stopEntryAutoScroll();
}, true);
libraryRoot.addEventListener("wheel", event => {
  if (!draggedEntryId) return;
  event.preventDefault();
  const multiplier = event.deltaMode === WheelEvent.DOM_DELTA_LINE
    ? 18
    : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
      ? (libraryHost?.clientHeight || document.documentElement.clientHeight)
      : 1;
  window.scrollBy(0, event.deltaY * multiplier);
}, { capture: true, passive: false });
$("#favorite-filter").addEventListener("click", () => {
  state.favoritesOnly = !state.favoritesOnly;
  $("#favorite-filter").classList.toggle("active", state.favoritesOnly);
  $("#favorite-icon").textContent = state.favoritesOnly ? "♥" : "♡";
  $("#favorite-filter").title = state.favoritesOnly ? "关闭仅查看收藏" : "仅查看收藏";
  resetEntriesAndLoad();
});
$("#artist-classification-view").addEventListener("change", event => {
  state.artistClassificationView = event.target.value === "style-first" ? "style-first" : "rating-first";
  renderArtistClassificationFilters();
  persistViewState();
});
$("#artist-rating-filter").addEventListener("change", event => {
  const value = event.target.value;
  state.ratingValues = !value ? "" : (event.target.checked ? [...selectedArtistRatings(), value] : selectedArtistRatings().filter(item => item !== value)).join(",");
  state.ratingMin = ""; state.ratingMax = ""; state.ratingUnrated = false;
  renderArtistClassificationFilters();
  resetEntriesAndLoad();
});
$("#artist-style-filter").addEventListener("change", event => {
  const value = event.target.value;
  state.styleUnclassified = value === "unclassified";
  state.style = value.startsWith("style:") ? value.slice(6) : "";
  renderArtistClassificationFilters();
  resetEntriesAndLoad();
});
$("#image-filter-toggle").addEventListener("click", event => {
  event.stopPropagation();
  const menu = $("#image-filter-menu");
  menu.hidden = !menu.hidden;
  $("#image-filter-toggle").setAttribute("aria-expanded", String(!menu.hidden));
});
$("#image-filter-menu").addEventListener("click", event => event.stopPropagation());
libraryRoot.querySelectorAll("#image-filter-menu button").forEach(button => button.addEventListener("click", () => {
  imageFilterGraceIds.clear();
  state.imageFilter = button.dataset.imageFilter || "";
  updateImageFilterControl();
  $("#image-filter-menu").hidden = true;
  $("#image-filter-toggle").setAttribute("aria-expanded", "false");
  resetEntriesAndLoad();
}));
function submitLibrarySearch() {
  clearTimeout(searchTimer);
  state.q = $("#search").value.trim();
  resetEntriesAndLoad();
}
$("#search").addEventListener("input", () => {
  updateSearchHint();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(submitLibrarySearch, 220);
});
$("#search").addEventListener("search", submitLibrarySearch);
$("#search").addEventListener("keydown", event => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  submitLibrarySearch();
});
$("#search-submit").addEventListener("click", submitLibrarySearch);
$("#search-scope").addEventListener("click", () => {
  state.searchScope = state.searchScope === "all" ? "directory" : "all";
  updateSearchScopeControl();
  persistViewState();
  if (state.q) resetEntriesAndLoad();
});
$("#search-field").addEventListener("change", event => {
  state.searchField = event.target.value;
  updateSearchFieldControl();
  persistViewState();
  if (state.q && state.searchScope === "all") resetEntriesAndLoad();
});
$("#sort").addEventListener("change", event => {
  state.sort = event.target.value;
  applyViewLayout();
  resetEntriesAndLoad();
});
libraryRoot.querySelectorAll("[data-view-mode]").forEach(button => button.addEventListener("click", () => {
  changeViewLayout(button.dataset.viewMode).catch(error => showToast(error.message));
}));
libraryRoot.querySelectorAll("[data-view-columns]").forEach(button => button.addEventListener("click", () => {
  if (state.viewMode !== "list") changeViewLayout(null, button.dataset.viewColumns).catch(error => showToast(error.message));
}));
$("#add-category").addEventListener("click", addCategory);
$("#rename-category").addEventListener("click", renameCategory);
$("#delete-category").addEventListener("click", deleteCategory);
$("#add-group").addEventListener("click", addGroup);
$("#rename-group").addEventListener("click", renameGroup);
$("#delete-group").addEventListener("click", deleteGroup);
$("#theme-toggle").addEventListener("click", () => applyTheme(libraryBody.dataset.theme === "light" ? "dark" : "light"));
const desktopFullscreen = $("#desktop-fullscreen");
const revealDesktopFullscreen = () => { desktopFullscreen.hidden = !window.pywebview?.api?.toggle_fullscreen; };
revealDesktopFullscreen();
window.addEventListener("pywebviewready", revealDesktopFullscreen, { once: true });
desktopFullscreen.addEventListener("click", () => window.pywebview?.api?.toggle_fullscreen?.());
$("#copy-history-toggle").addEventListener("click", () => {
  renderCopyHistory();
  $("#copy-history-dialog").showModal();
});
libraryRoot.querySelectorAll(".close-copy-history").forEach(button => button.addEventListener("click", () => $("#copy-history-dialog").close()));
$("#clear-copy-history").addEventListener("click", () => {
  if (!readCopyHistory().length || confirm("确定清空全部最近复制记录吗？")) {
    writeCopyHistory([]);
    renderCopyHistory();
  }
});
$("#batch-mode").addEventListener("click", () => setSelectionMode(!state.selectionMode));
$("#cancel-batch").addEventListener("click", () => setSelectionMode(false));
$("#select-all").addEventListener("click", selectAllCurrentResults);
$("#clear-selection").addEventListener("click", () => { state.selectedIds.clear(); updateBatchToolbar(); });
$("#move-selected").addEventListener("click", openBatchMoveDialog);
$("#delete-selected").addEventListener("click", deleteSelectedEntries);
$("#batch-move-form").addEventListener("submit", moveSelectedEntries);
libraryRoot.querySelectorAll(".close-batch-move").forEach(button => button.addEventListener("click", () => $("#batch-move-dialog").close()));
$("#add-entry").addEventListener("click", () => openEditor());
$("#open-export").addEventListener("click", () => $("#export-dialog").showModal());
$(".close-export").addEventListener("click", () => $("#export-dialog").close());
$("#export-current").addEventListener("click", () => exportCurrentMarkdown().catch(error => showToast(error.message)));
$("#create-backup").addEventListener("click", createBackup);
$('#maintenance-audit').addEventListener('click', () => runMaintenance('audit'));
$('#maintenance-preview').addEventListener('click', () => runMaintenance('preview'));
$('#maintenance-cleanup').addEventListener('click', () => runMaintenance('cleanup'));
$('#maintenance-filter').addEventListener('change', () => { maintenancePage = 1; renderMaintenanceReport(); });
$('#maintenance-prev').addEventListener('click', () => { maintenancePage--; renderMaintenanceReport(); });
$('#maintenance-next').addEventListener('click', () => { maintenancePage++; renderMaintenanceReport(); });
$('#maintenance-json').addEventListener('click', () => downloadText('资料库图片检查.json', JSON.stringify(maintenanceReport, null, 2), 'application/json').catch(error => showToast(error.message)));
$('#maintenance-markdown').addEventListener('click', () => downloadText('资料库图片检查.md', maintenanceMarkdown, 'text/markdown;charset=utf-8').catch(error => showToast(error.message)));
libraryRoot.querySelectorAll("[data-native-export]").forEach(anchor => anchor.addEventListener("click", async event => {
  const bridge = desktopBridge();
  if (!bridge?.save_export) return;
  event.preventDefault();
  try {
    const result = await bridge.save_export(anchor.getAttribute("href"));
    if (result?.cancelled) return;
    if (!result?.ok) throw new Error(result?.error || "Windows 保存接口没有返回成功状态");
    showToast(`已保存：${result.filename}`);
  } catch (error) {
    showToast(`导出失败：${error.message}`);
  }
}));
$("#entry-kind").addEventListener("change", () => {
  updateFormKind();
  populateGroupOptions($("#entry-kind").value);
  renderCategoryPicker($("#entry-kind").value, "未分类");
});
$("#reveal-after-save").addEventListener("change", event => {
  localStorage.setItem(REVEAL_AFTER_SAVE_KEY, String(event.target.checked));
});
$("#entry-form").addEventListener("submit", saveEntry);
$("#delete-entry").addEventListener("click", deleteEntry);
libraryRoot.querySelectorAll(".close-dialog").forEach(button => button.addEventListener("click", () => $("#edit-dialog").close()));
$(".image-close").addEventListener("click", () => $("#image-dialog").close());
$("#image-dialog").addEventListener("close", () => void restoreAfterImageDialog());
$("#viewer-favorite").addEventListener("click", () => state.viewerEntry && toggleFavorite(state.viewerEntry));
$("#viewer-set-cover").addEventListener("click", setViewerImageAsCover);
$("#viewer-delete-image").addEventListener("click", deleteViewerImage);
$("#viewer-copy").addEventListener("click", async () => {
  if (!state.viewerEntry?.content) return;
  await copyPrompt(state.viewerEntry.content, {
    title: state.viewerEntry.title,
    type: state.viewerEntry.category === "负面提示词" ? "负面提示词" : "正向提示词",
    library: state.viewerEntry.kind,
  });
  void recordEntryUse(state.viewerEntry);
  showToast(state.viewerEntry.category === "负面提示词" ? "负面提示词已复制" : "正向提示词已复制");
});
$("#copy-positive").addEventListener("click", () => $("#viewer-copy").click());
$("#copy-negative").addEventListener("click", async () => {
  if (!state.viewerEntry?.negative_prompt) return;
  await copyPrompt(state.viewerEntry.negative_prompt, { title: state.viewerEntry.title, type: "负面提示词", library: state.viewerEntry.kind });
  void recordEntryUse(state.viewerEntry);
  showToast("负面提示词已复制");
});
$("#copy-embedded-positive").addEventListener("click", async () => {
  const text = $("#viewer-embedded-positive").textContent;
  if (text) { await copyPrompt(text, { title: state.viewerEntry?.title, type: "图片正向提示词", library: state.viewerEntry?.kind }); showToast("图片正向提示词已复制"); }
});
$("#copy-embedded-negative").addEventListener("click", async () => {
  const text = $("#viewer-embedded-negative").textContent;
  if (text) { await copyPrompt(text, { title: state.viewerEntry?.title, type: "图片负向提示词", library: state.viewerEntry?.kind }); showToast("图片负向提示词已复制"); }
});
$("#viewer-read-deep").addEventListener("click", () => {
  const image = state.imageList[state.imageIndex];
  if (image) loadViewerMetadata(image, true).catch(error => showToast(error.message));
});
$("#scroll-top").addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
$("#random-scene").addEventListener("click", async () => {
  try {
    const entry = await api("/api/entries/random-scene");
    await revealSavedEntry(entry.id, entry);
  } catch (error) {
    showToast(`随机选择失败：${error.message || String(error)}`);
  }
});
$("#scroll-bottom").addEventListener("click", () => window.scrollTo({ top: libraryBody.scrollHeight, behavior: "smooth" }));
$(".image-nav.previous").addEventListener("click", () => { state.imageIndex = (state.imageIndex - 1 + state.imageList.length) % state.imageList.length; updateImageDialog(); });
$(".image-nav.next").addEventListener("click", () => { state.imageIndex = (state.imageIndex + 1) % state.imageList.length; updateImageDialog(); });
libraryRoot.addEventListener("keydown", event => {
  if (event.ctrlKey && event.key.toLowerCase() === "k") { event.preventDefault(); $("#search").focus(); }
  if ($("#image-dialog").open && event.key === "ArrowLeft") $(".image-nav.previous").click();
  if ($("#image-dialog").open && event.key === "ArrowRight") $(".image-nav.next").click();
});

function isLoopbackOrigin(value) {
  try {
    const hostname = new URL(value).hostname;
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
  } catch {
    return false;
  }
}

async function importDeanaiDraft(event) {
  const draft = event.data;
  const requestedId = libraryUrl().searchParams.get("nyanovel_import");
  if (
    !isLoopbackOrigin(event.origin) ||
    !draft ||
    draft.type !== "nyanovel-library-import" ||
    !requestedId ||
    draft.requestId !== requestedId ||
    !["artist", "prompt"].includes(draft.kind) ||
    typeof draft.content !== "string"
  ) return;

  try {
    openEditor();
    $("#entry-kind").value = draft.kind;
    const category = draft.kind === state.kind ? (state.category || state.categoryPrefix || "未分类") : "未分类";
    $("#entry-category").value = category;
    renderCategoryPicker(draft.kind, category);
    populateGroupOptions(draft.kind, []);
    updateFormKind();
    $("#entry-content").value = draft.content;
    if (draft.kind === "artist" && typeof draft.negativePrompt === "string") {
      $("#entry-negative").value = draft.negativePrompt;
    }

    if (draft.image?.dataUrl) {
      const response = await fetch(draft.image.dataUrl);
      const blob = await response.blob();
      const file = new File([blob], draft.image.filename || `deanai-${Date.now()}.png`, {
        type: blob.type || "image/png",
        lastModified: Date.now(),
      });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      $("#entry-images").files = transfer.files;
    }

    if (libraryHost) libraryHost.dataset.libraryUrl = "/library-embed/";
    else history.replaceState(null, "", location.pathname);
    $("#entry-title").focus();
    const negativeNote = draft.negativePrompt ? "、负面提示词" : "";
    showToast(draft.image?.dataUrl ? `已从 dean-nai 带入正向词${negativeNote}和示例图` : `已从 dean-nai 带入正向词${negativeNote}`);
    event.source?.postMessage({ type: "nya-library-imported", requestId: draft.requestId }, event.origin);
  } catch (error) {
    event.source?.postMessage(
      { type: "nya-library-import-error", requestId: draft.requestId, message: error.message || String(error) },
      event.origin,
    );
  }
}

window.addEventListener("message", event => void importDeanaiDraft(event));

function signalDeanaiImportReady() {
  const requestId = libraryUrl().searchParams.get("nyanovel_import");
  if (requestId && window.opener) {
    window.opener.postMessage({ type: "nya-library-ready", requestId }, "*");
  }
}

async function consumeSameWindowDraft() {
  const requestId = libraryUrl().searchParams.get("nyanovel_import");
  if (!requestId || window.opener) return;
  try {
    const draft = await api(`/api/library/import-drafts/${encodeURIComponent(requestId)}`);
    await importDeanaiDraft({ data: draft, origin: location.origin, source: null });
  } catch (error) {
    showToast(`无法读取资料库草稿：${error.message || String(error)}`);
  }
}

async function revealRequestedEntry() {
  const url = libraryUrl();
  const rawId = url.searchParams.get("focus_entry");
  if (!rawId || !/^\d+$/.test(rawId)) return;
  url.searchParams.delete("focus_entry");
  if (libraryHost) libraryHost.dataset.libraryUrl = `${url.pathname}${url.search}${url.hash}`;
  else history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  const entryId = Number(rawId);
  try {
    const entry = await api(`/api/entries/${entryId}`);
    await revealSavedEntry(entryId, entry);
  } catch (error) {
    showToast(`无法定位卡片：${error.message || String(error)}`);
  }
}

function startInfiniteScroll() {
  if (infiniteObserver) infiniteObserver.disconnect();
  infiniteObserver = new IntersectionObserver(entries => {
    if (!restoringViewPosition && entries.some(entry => entry.isIntersecting)) loadEntries(false);
  }, { rootMargin: "900px 0px" });
  infiniteObserver.observe($("#load-more-sentinel"));
}
$("#load-more-sentinel").addEventListener("click", () => loadEntries(false));

function initSidebarLayout() {
  const key = "dean-library-directory-layout-v1";
  const sidebar = $("#sidebar-layout-toolbar")?.closest(".sidebar");
  const dockSelect = $("#sidebar-dock");
  const collapse = $("#sidebar-collapse");
  const reopen = $("#sidebar-reopen");
  const resizer = $("#sidebar-resizer");
  if (!sidebar || !dockSelect || !collapse || !reopen || !resizer) return;
  const defaults = { dock: "left", size: 230, collapsed: false, x: 84, y: 76, width: 270, height: Math.round(innerHeight * .72) };
  let state = { ...defaults };
  try {
    const saved = JSON.parse(localStorage.getItem(key) || "null");
    if (saved && typeof saved === "object") state = { ...state, ...saved };
  } catch {}
  const allowed = new Set(["left", "right", "top", "bottom", "floating"]);
  if (!allowed.has(state.dock)) state.dock = "left";

  const save = () => {
    try { localStorage.setItem(key, JSON.stringify(state)); } catch {}
  };
  const apply = () => {
    libraryBody.dataset.sidebarDock = state.dock;
    libraryBody.dataset.sidebarCollapsed = state.collapsed ? "true" : "false";
    libraryBody.style.setProperty("--directory-panel-size", `${state.size}px`);
    libraryBody.style.setProperty("--directory-float-x", `${state.x}px`);
    libraryBody.style.setProperty("--directory-float-y", `${state.y}px`);
    libraryBody.style.setProperty("--directory-float-width", `${state.width}px`);
    libraryBody.style.setProperty("--directory-float-height", `${state.height}px`);
    dockSelect.value = state.dock;
    collapse.textContent = state.collapsed ? "展开" : "收起";
    requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
  };

  dockSelect.addEventListener("change", () => {
    state.dock = allowed.has(dockSelect.value) ? dockSelect.value : "left";
    state.collapsed = false;
    save();
    apply();
  });
  collapse.addEventListener("click", () => {
    state.collapsed = true;
    save();
    apply();
  });
  reopen.addEventListener("click", () => {
    state.collapsed = false;
    save();
    apply();
  });

  resizer.addEventListener("pointerdown", event => {
    if (state.dock === "floating") return;
    event.preventDefault();
    resizer.setPointerCapture(event.pointerId);
    const move = moveEvent => {
      const horizontal = state.dock === "left" || state.dock === "right";
      const hostLeft = libraryHost?.getBoundingClientRect().left ?? 64;
      const raw = state.dock === "left" ? moveEvent.clientX - hostLeft
        : state.dock === "right" ? innerWidth - moveEvent.clientX
        : state.dock === "top" ? moveEvent.clientY
        : innerHeight - moveEvent.clientY;
      state.size = Math.round(Math.max(horizontal ? 180 : 145, Math.min(raw, horizontal ? Math.min(560, innerWidth * .48) : innerHeight * .55)));
      apply();
    };
    const stop = () => {
      resizer.removeEventListener("pointermove", move);
      resizer.removeEventListener("pointerup", stop);
      resizer.removeEventListener("pointercancel", stop);
      save();
    };
    resizer.addEventListener("pointermove", move);
    resizer.addEventListener("pointerup", stop);
    resizer.addEventListener("pointercancel", stop);
  });

  $("#sidebar-layout-toolbar").addEventListener("pointerdown", event => {
    if (state.dock !== "floating" || event.target.closest("button,select")) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const originX = state.x;
    const originY = state.y;
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const move = moveEvent => {
      state.x = Math.round(Math.max(68, Math.min(originX + moveEvent.clientX - startX, innerWidth - 190)));
      state.y = Math.round(Math.max(8, Math.min(originY + moveEvent.clientY - startY, innerHeight - 80)));
      apply();
    };
    const stop = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
      save();
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  });

  if ("ResizeObserver" in window) {
    let frame = 0;
    new ResizeObserver(() => {
      if (state.dock !== "floating" || state.collapsed) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = sidebar.getBoundingClientRect();
        state.width = Math.round(rect.width);
        state.height = Math.round(rect.height);
        save();
      });
    }).observe(sidebar);
  }
  apply();
}

async function boot() {
  try {
    initSidebarLayout();
    initVocabularyAutocomplete();
    applyTheme(localStorage.getItem("nai-library-theme") === "light" ? "light" : "dark");
    const savedPosition = restoreStoredViewState();
    syncViewControls();
    const backend = await api("/api/version");
    if (backend.version !== EXPECTED_BACKEND_VERSION) throw new Error("正在运行的是旧版后端");
    const settings = await api("/api/settings");
    $("#originals-path").textContent = settings.media_dir;
    restoringViewPosition = true;
    await Promise.all([loadNavigation(), loadEntries(true, savedPosition?.loadedCount)]);
    await restoreViewPosition(savedPosition);
    restoringViewPosition = false;
    startInfiniteScroll();
    await revealRequestedEntry();
    await consumeSameWindowDraft();
    persistViewState();
    signalDeanaiImportReady();
  } catch (error) {
    entryRequestId += 1;
    navigationRequestId += 1;
    gallery.replaceChildren();
    const notice = document.createElement("article");
    notice.className = "startup-error";
    notice.innerHTML = "<h2>程序需要重新启动</h2><p>请关闭旧的启动窗口，再双击 start.bat。这样可以确保界面和后端是同一版本。</p>";
    gallery.append(notice);
    $("#result-summary").textContent = error.message;
  }
}

function scheduleViewStateSave() {
  if (restoringViewPosition || imageDialogViewPosition) return;
  clearTimeout(viewSaveTimer);
  viewSaveTimer = setTimeout(() => persistViewState(), 180);
}

window.addEventListener("scroll", scheduleViewStateSave, { passive: true });
$("#category-list").addEventListener("scroll", scheduleViewStateSave, { passive: true });
window.addEventListener("pagehide", () => persistViewState());
libraryHost?.addEventListener("dean-nai:library-url", () => {
  void (async () => {
    await revealRequestedEntry();
    await consumeSameWindowDraft();
  })();
});
boot();
