const EXPORT_SCHEMA_VERSION = "2.0.0";

const $ = (id) => document.getElementById(id);
const scanBtn = $("scanBtn");
const exportBtn = $("exportBtn");
const dryRunBtn = $("dryRunBtn");
const statusEl = $("status");
const userNoticeEl = $("userNotice");
const siteEl = $("site");
const summaryEl = $("summary");
const previewEl = $("preview");
const logsEl = $("logs");
const brandLineEl = $("brandLine");
const scanBrandLineEl = $("scanBrandLine");
const progressWrapEl = $("progressWrap");
const progressTitleEl = $("progressTitle");
const progressFillEl = $("progressFill");
const progressCountEl = $("progressCount");
const progressMetaEl = $("progressMeta");
const progressDetailsEl = $("progressDetails");
const resultOverlayEl = $("resultOverlay");
const resultIconEl = $("resultIcon");
const resultTitleEl = $("resultTitle");
const resultMessageEl = $("resultMessage");
const resultDetailsEl = $("resultDetails");
const resultCloseBtn = $("resultCloseBtn");
const scanOverlayEl = $("scanOverlay");
const scanOverlayTitleEl = $("scanOverlayTitle");
const scanOverlayMetaEl = $("scanOverlayMeta");
const mainEl = document.querySelector("main");

const downloadFilesEl = $("downloadFiles");
const includeHintDetailsEl = $("includeHintDetails");
const skipKnownEl = $("skipKnown");

const DEFAULT_RETRY_COUNT = 3;
const DEFAULT_TIMEOUT_MS = 600000;
const ZIP_WARN_LIMIT_BYTES = 100 * 1024 * 1024;

const filterCategoryEl = $("filterCategory");
const filterSolvedEl = $("filterSolved");

const selectAllBtn = $("selectAllBtn");
const selectNoneBtn = $("selectNoneBtn");

const state = { scan: null, selectedChallenges: new Set(), selectedFilesByChallenge: new Map(), lastEstimate: null, activeTab: null, busy: false };
const liveDownloads = new Map();
let downloadEventsAttached = false;
let lastResultStamp = 0;
let storageWarned = false;
let lastBgNotice = "";
const exportProgress = {
  visible: false,
  phase: "idle",
  totalChallenges: 0,
  doneChallenges: 0,
  currentChallenge: "",
  currentLabel: "",
  currentPct: 0,
  currentSpeedBps: 0,
  currentBytes: 0,
  currentTotalBytes: 0,
  details: []
};

function syncActionButtons() {
  const bgRunning = exportProgress.phase === "running";
  if (state.busy || bgRunning) {
    exportBtn.disabled = true;
  } else {
    exportBtn.disabled = false;
  }
}

function logLine(msg, type = "INF") {
  if (!logsEl) return;
  const ts = new Date().toLocaleTimeString();
  logsEl.textContent += `${ts} [${type}] ${msg}\n`;
  logsEl.scrollTop = logsEl.scrollHeight;
}

function setStatus(msg, cls = "") {
  if (statusEl) {
    statusEl.textContent = msg;
    statusEl.className = `status ${cls}`.trim();
  }
  logLine(msg, cls === "err" ? "ERR" : cls === "ok" ? "OK" : "INF");
  void persistUiState();
}

function reportStorageIssue(err, context) {
  if (storageWarned) return;
  storageWarned = true;
  const reason = err?.message || "storage_error";
  logLine(`Storage issue (${context}): ${reason}`, "ERR");
  showNotice("Local extension storage is full/unavailable. Download will continue, but popup state/history may not persist.", "warn", 18000);
}

let noticeTimer = null;
function showNotice(msg, type = "", timeoutMs = 12000) {
  if (!userNoticeEl) return;
  if (noticeTimer) {
    clearTimeout(noticeTimer);
    noticeTimer = null;
  }
  userNoticeEl.textContent = msg;
  userNoticeEl.className = `user-notice ${type}`.trim();
  userNoticeEl.classList.remove("hidden");
  if (timeoutMs > 0) {
    noticeTimer = setTimeout(() => {
      if (!userNoticeEl) return;
      userNoticeEl.classList.add("hidden");
      noticeTimer = null;
    }, timeoutMs);
  }
}

function showResultOverlay({ ok, title, message, details }) {
  if (!resultOverlayEl) return;
  if (resultIconEl) resultIconEl.className = `result-icon ${ok ? "ok" : "err"}`;
  if (resultTitleEl) resultTitleEl.textContent = title || (ok ? "Export Complete" : "Export Error");
  if (resultMessageEl) resultMessageEl.textContent = message || "";
  if (resultDetailsEl) {
    const txt = details || "";
    resultDetailsEl.textContent = txt;
    resultDetailsEl.classList.toggle("hidden", !txt);
  }
  resultOverlayEl.classList.remove("hidden");
}

function hideResultOverlay() {
  if (resultOverlayEl) resultOverlayEl.classList.add("hidden");
}

function setScanOverlay(show, title = "Scanning challenges...") {
  if (!scanOverlayEl || !mainEl) return;
  if (scanOverlayTitleEl) scanOverlayTitleEl.textContent = title;
  if (scanOverlayMetaEl && show && !scanOverlayMetaEl.textContent) scanOverlayMetaEl.textContent = "Please keep the CTF tab open.";
  scanOverlayEl.classList.toggle("hidden", !show);
  mainEl.classList.toggle("scan-active", show);
}

function progressSnapshot() {
  return {
    visible: !!exportProgress.visible,
    phase: exportProgress.phase,
    totalChallenges: exportProgress.totalChallenges,
    doneChallenges: exportProgress.doneChallenges,
    currentChallenge: exportProgress.currentChallenge,
    currentLabel: exportProgress.currentLabel,
    currentPct: exportProgress.currentPct,
    currentSpeedBps: exportProgress.currentSpeedBps,
    currentBytes: exportProgress.currentBytes,
    currentTotalBytes: exportProgress.currentTotalBytes,
    details: Array.isArray(exportProgress.details) ? exportProgress.details.slice(0, 120) : []
  };
}

function applyProgressSnapshot(s) {
  if (!s) return;
  exportProgress.visible = !!s.visible;
  exportProgress.phase = s.phase || "idle";
  exportProgress.totalChallenges = Math.max(0, Number(s.totalChallenges || 0));
  exportProgress.doneChallenges = Math.max(0, Number(s.doneChallenges || 0));
  exportProgress.currentChallenge = s.currentChallenge || "";
  exportProgress.currentLabel = s.currentLabel || "";
  exportProgress.currentPct = Math.max(0, Math.min(100, Number(s.currentPct || 0)));
  exportProgress.currentSpeedBps = Math.max(0, Number(s.currentSpeedBps || 0));
  exportProgress.currentBytes = Math.max(0, Number(s.currentBytes || 0));
  exportProgress.currentTotalBytes = Math.max(0, Number(s.currentTotalBytes || 0));
  exportProgress.details = Array.isArray(s.details) ? s.details : [];
}

function resetProgressState(clearStorage = false) {
  exportProgress.visible = false;
  exportProgress.phase = "idle";
  exportProgress.totalChallenges = 0;
  exportProgress.doneChallenges = 0;
  exportProgress.currentChallenge = "";
  exportProgress.currentLabel = "";
  exportProgress.currentPct = 0;
  exportProgress.currentSpeedBps = 0;
  exportProgress.currentBytes = 0;
  exportProgress.currentTotalBytes = 0;
  exportProgress.details = [];
  renderProgress(true);
  if (clearStorage) {
    chrome.storage.local.remove(["exportJobState"]).catch(() => {});
  }
}

function isNoReceiverError(err) {
  const msg = String(err?.message || err || "");
  return /Receiving end does not exist/i.test(msg) || /Could not establish connection/i.test(msg);
}

function syncProgressFromBackground(bgState) {
  if (!bgState) return;
  applyProgressSnapshot({
    visible: !!(bgState.running || bgState.phase === "done" || bgState.phase === "error"),
    phase: bgState.phase || (bgState.running ? "running" : "idle"),
    totalChallenges: bgState.totalChallenges || 0,
    doneChallenges: bgState.doneChallenges || 0,
    currentChallenge: bgState.currentChallenge || "",
    currentLabel: bgState.currentLabel || "",
    currentPct: bgState.currentPct || 0,
    currentSpeedBps: bgState.currentSpeedBps || 0,
    currentBytes: bgState.currentBytes || 0,
    currentTotalBytes: bgState.currentTotalBytes || 0,
    details: bgState.details || []
  });
  renderProgress(true);
  syncActionButtons();
  const stamp = Number(bgState.updatedAt || 0);
  if (bgState.phase === "running" && typeof bgState.message === "string" && /auto-switched to Direct files/i.test(bgState.message)) {
    if (lastBgNotice !== bgState.message) {
      showNotice(bgState.message, "warn", 12000);
      lastBgNotice = bgState.message;
    }
  }
  if (bgState.phase === "done" && bgState.summary && stamp !== lastResultStamp) {
    const msg = `Export complete: ${bgState.summary.challenges} challenges, ${bgState.summary.files}/${bgState.summary.attempted} files downloaded, ${bgState.summary.skipped} skipped, ${bgState.summary.failed} failed.`;
    setStatus(msg, bgState.summary.failed ? "err" : "ok");
    lastResultStamp = stamp;
  } else if (bgState.phase === "error" && stamp !== lastResultStamp) {
    setStatus(`Export failed: ${bgState.message || "Unknown error"}`, "err");
    lastResultStamp = stamp;
  }
}

async function refreshExportState() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "getExportState" });
    if (res?.ok && res.state) syncProgressFromBackground(res.state);
  } catch {}
}

function formatProgressDetails() {
  if (!Array.isArray(exportProgress.details) || !exportProgress.details.length) return "";
  const lines = [];
  for (const item of exportProgress.details) {
    const title = `${item.challenge || "Challenge"}`;
    const skip = Array.isArray(item.skipped) ? item.skipped : [];
    const fail = Array.isArray(item.failed) ? item.failed : [];
    lines.push(`[${title}]`);
    if (skip.length) lines.push(`  skipped (${skip.length}): ${skip.join(", ")}`);
    if (fail.length) {
      lines.push(`  failed (${fail.length}):`);
      for (const f of fail) lines.push(`    - ${f.file || "unknown"} (${f.reason || "unknown"})`);
    }
  }
  return lines.join("\n");
}

function renderProgress(persist = false) {
  if (!progressWrapEl || !progressFillEl || !progressCountEl || !progressMetaEl) return;
  if (!exportProgress.visible) {
    progressWrapEl.classList.add("hidden");
    if (progressTitleEl) progressTitleEl.textContent = "Download Progress";
    if (persist) void persistUiState();
    return;
  }
  progressWrapEl.classList.remove("hidden");
  const completedLike = exportProgress.doneChallenges;
  const basePct = exportProgress.totalChallenges > 0 ? Math.min(100, Math.floor((completedLike * 100) / exportProgress.totalChallenges)) : 0;
  const partial = exportProgress.totalChallenges > 0 ? Math.floor((exportProgress.currentPct || 0) / exportProgress.totalChallenges) : 0;
  const pct = Math.min(100, basePct + partial);
  progressFillEl.style.width = `${pct}%`;
  progressCountEl.textContent = `${completedLike}/${exportProgress.totalChallenges}`;
  const challenge = exportProgress.currentChallenge || "";
  const file = exportProgress.currentLabel || "";
  const pctLabel = exportProgress.currentPct ? ` ${exportProgress.currentPct}%` : "";
  const speed = Math.max(0, Number(exportProgress.currentSpeedBps || 0));
  const speedLabel = speed >= 1024 * 1024
    ? `${(speed / (1024 * 1024)).toFixed(2)} MB/s`
    : speed >= 1024
      ? `${(speed / 1024).toFixed(1)} KB/s`
      : `${Math.floor(speed)} B/s`;
  if (progressTitleEl) progressTitleEl.textContent = `Download Progress (${speedLabel})`;
  const curBytes = Math.max(0, Number(exportProgress.currentBytes || 0));
  const totalBytes = Math.max(0, Number(exportProgress.currentTotalBytes || 0));
  const bytesLabel = totalBytes > 0
    ? `${(curBytes / (1024 * 1024)).toFixed(2)}/${(totalBytes / (1024 * 1024)).toFixed(2)} MB`
    : curBytes > 0
      ? `${(curBytes / (1024 * 1024)).toFixed(2)} MB`
      : "";
  const isActiveTransfer = speed > 0 || curBytes > 0;
  const context = challenge || file ? ` | ${challenge}${challenge && file ? " > " : ""}${file}${pctLabel}` : "";
  const phase = exportProgress.phase === "running" ? "Running" : exportProgress.phase === "done" ? "Completed" : "Idle";
  const speedPart = isActiveTransfer ? `Speed: ${speedLabel}` : (phase === "Running" ? "Speed: waiting for transfer stats..." : `Speed: ${speedLabel}`);
  progressMetaEl.textContent = `${phase}: ${completedLike}/${exportProgress.totalChallenges} challenges${context} | ${speedPart}${bytesLabel ? ` | ${bytesLabel}` : ""}`;
  const detailsText = formatProgressDetails();
  if (progressDetailsEl) {
    progressDetailsEl.textContent = detailsText;
    progressDetailsEl.classList.toggle("hidden", !detailsText);
  }
  if (persist) void persistUiState();
}

function startProgress(totalChallenges) {
  exportProgress.visible = true;
  exportProgress.phase = "running";
  exportProgress.totalChallenges = Math.max(0, totalChallenges);
  exportProgress.doneChallenges = 0;
  exportProgress.currentChallenge = "";
  exportProgress.currentLabel = "";
  exportProgress.currentPct = 0;
  exportProgress.currentSpeedBps = 0;
  exportProgress.currentBytes = 0;
  exportProgress.currentTotalBytes = 0;
  exportProgress.details = [];
  renderProgress(true);
}

function finishProgress() {
  exportProgress.visible = true;
  exportProgress.phase = "done";
  exportProgress.currentChallenge = "";
  exportProgress.currentLabel = "";
  exportProgress.currentPct = 0;
  renderProgress(true);
}

function setProgressChallenge(label) {
  exportProgress.currentChallenge = label || "";
  exportProgress.currentLabel = "";
  exportProgress.currentPct = 0;
  exportProgress.currentSpeedBps = 0;
  exportProgress.currentBytes = 0;
  exportProgress.currentTotalBytes = 0;
  renderProgress();
}

function onProgressQueued(label) {
  exportProgress.currentLabel = label || "";
  exportProgress.currentPct = 0;
  exportProgress.currentSpeedBps = 0;
  exportProgress.currentBytes = 0;
  exportProgress.currentTotalBytes = 0;
  renderProgress();
}

function onProgressTick(label, pct) {
  exportProgress.currentLabel = label || exportProgress.currentLabel;
  exportProgress.currentPct = Math.max(0, Math.min(100, Number(pct || 0)));
  renderProgress();
}

function onChallengeDone(result) {
  exportProgress.doneChallenges += 1;
  exportProgress.currentPct = 0;
  exportProgress.currentLabel = "";
  exportProgress.currentSpeedBps = 0;
  exportProgress.currentBytes = 0;
  exportProgress.currentTotalBytes = 0;
  if (result && ((Array.isArray(result.skipped) && result.skipped.length) || (Array.isArray(result.failed) && result.failed.length))) {
    exportProgress.details.push(result);
  }
  renderProgress(true);
}

function decodeBrand() {
  const k1 = 23;
  const k2 = 9;
  const a = [83,114,97,114,123,120,103,114,115,55,117,110,55,90,101,72,85,118,115,118,100,100,100];
  return a.map((n, i) => String.fromCharCode((n ^ k1) - (i % 2 ? 0 : 0) + k2 - k2)).join("");
}

function lockBranding() {
  const expected = decodeBrand();
  const targets = [brandLineEl, scanBrandLineEl].filter(Boolean);
  const apply = (el, animate = true) => {
    if (!el) return;
    if (!animate) { el.textContent = expected; return; }
    let i = 0;
    el.dataset.tw = "1";
    const tick = () => {
      if (!el) return;
      el.textContent = expected.slice(0, i);
      i += 1;
      if (i <= expected.length) setTimeout(tick, 40);
      else el.dataset.tw = "0";
    };
    tick();
    new MutationObserver(() => {
      if (el.dataset.tw === "1") return;
      if (el.textContent !== expected) apply(el, false);
    }).observe(el, { characterData: true, childList: true, subtree: true });
  };
  for (const t of targets) apply(t);
}

function sanitize(name) {
  return (name || "unknown")
    .normalize("NFKC")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFE00-\uFE0F]/g, "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function safePathPart(name, fallback = "unknown", maxLen = 80) {
  const reserved = new Set(["CON","PRN","AUX","NUL","COM1","COM2","COM3","COM4","COM5","COM6","COM7","COM8","COM9","LPT1","LPT2","LPT3","LPT4","LPT5","LPT6","LPT7","LPT8","LPT9"]);
  let out = sanitize(name || fallback).replace(/[\u0000-\u001F\u007F]/g, "_").replace(/[. ]+$/g, "").replace(/^\.+/g, "").trim();
  if (!out) out = fallback;
  if (reserved.has(out.toUpperCase())) out = `_${out}`;
  if (out.length > maxLen) out = out.slice(0, maxLen).trim();
  return out || fallback;
}

function toAbsolute(origin, pathOrUrl) {
  if (!pathOrUrl) return "";
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  if (pathOrUrl.startsWith("//")) return `https:${pathOrUrl}`;
  if (pathOrUrl.startsWith("/")) return `${origin}${pathOrUrl}`;
  return `${origin}/${pathOrUrl}`;
}

function isLikelyFileUrl(rawUrl, origin = "") {
  try {
    const u = new URL(rawUrl, origin || undefined);
    if (!/^https?:$/i.test(u.protocol)) return false;
    if (origin && u.origin === origin && /^\/(files|uploads|plugins)\b/i.test(u.pathname)) return true;
    const leaf = (u.pathname.split("/").pop() || "").trim();
    return /\.[a-z0-9]{1,10}$/i.test(leaf);
  } catch {
    return false;
  }
}

function cleanExtractedUrl(raw) {
  if (!raw) return "";
  let u = String(raw).trim();
  while (/[)\],.;!?]+$/.test(u)) u = u.slice(0, -1);
  return u;
}

function displayFileName(url) {
  return (url || "").split("?")[0].split("#")[0].split("/").pop() || "file";
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

function ensureDownloadEvents() {
  if (downloadEventsAttached) return;
  downloadEventsAttached = true;
  chrome.downloads.onChanged.addListener((delta) => {
    const rec = liveDownloads.get(delta.id);
    if (!rec) return;
    if (delta.totalBytes?.current != null) rec.total = delta.totalBytes.current;
    if (delta.bytesReceived?.current != null) {
      const got = delta.bytesReceived.current;
      const now = Date.now();
      if (!rec.prevTs) rec.prevTs = now;
      if (rec.prevBytes == null) rec.prevBytes = 0;
      const dt = Math.max(200, now - rec.prevTs);
      const db = Math.max(0, got - rec.prevBytes);
      if (db > 0) {
        const raw = (db * 1000) / dt;
        rec.smoothedSpeedBps = rec.smoothedSpeedBps > 0
          ? (rec.smoothedSpeedBps * 0.65) + (raw * 0.35)
          : raw;
        rec.lastNonZeroAt = now;
        exportProgress.currentSpeedBps = rec.smoothedSpeedBps;
        rec.prevTs = now;
        rec.prevBytes = got;
      } else {
        const since = now - (rec.lastNonZeroAt || 0);
        exportProgress.currentSpeedBps = since < 1500 ? (rec.smoothedSpeedBps || 0) : 0;
      }
      if (rec.total > 0) {
        const pct = Math.floor((got * 100) / rec.total);
        onProgressTick(rec.label, pct);
        if (pct >= rec.nextPct) {
          logLine(`Downloading ${rec.label}: ${pct}%`, "INF");
          rec.nextPct = Math.min(100, rec.nextPct + 10);
        }
      } else if (got - rec.lastBytesLogged >= 1024 * 1024) {
        const mb = (got / (1024 * 1024)).toFixed(2);
        logLine(`Downloading ${rec.label}: ${mb} MB`, "INF");
        rec.lastBytesLogged = got;
      }
      renderProgress();
    }
    if (delta.state?.current === "complete") {
      logLine(`Completed ${rec.label}`, "OK");
      if (typeof rec.resolve === "function") rec.resolve({ ok: true });
      liveDownloads.delete(delta.id);
      return;
    }
    if (delta.state?.current === "interrupted") {
      const why = delta.error?.current || "interrupted";
      logLine(`Interrupted ${rec.label}: ${why}`, "ERR");
      if (typeof rec.resolve === "function") rec.resolve({ ok: false, error: why });
      liveDownloads.delete(delta.id);
      return;
    }
    if (delta.error?.current) {
      logLine(`Download error ${rec.label}: ${delta.error.current}`, "ERR");
      if (typeof rec.resolve === "function") rec.resolve({ ok: false, error: delta.error.current });
      liveDownloads.delete(delta.id);
    }
  });
}

function getOptions() {
  return {
    mode: document.querySelector("input[name='exportMode']:checked")?.value || "direct",
    downloadFiles: downloadFilesEl.checked,
    includeHintDetails: includeHintDetailsEl.checked,
    computeHash: true,
    skipKnown: skipKnownEl.checked,
    retryCount: DEFAULT_RETRY_COUNT,
    timeoutMs: DEFAULT_TIMEOUT_MS
  };
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function ensureOriginPermission(origin) {
  try {
    const p = `${origin}/*`;
    if (await chrome.permissions.contains({ origins: [p] })) return true;
    return !!(await chrome.permissions.request({ origins: [p] }));
  } catch { return false; }
}

function fileCandidates(origin, challenge) {
  const urls = [];
  const files = Array.isArray(challenge.files) ? challenge.files : [];
  for (const raw of files) {
    const u = toAbsolute(origin, cleanExtractedUrl(typeof raw === "string" ? raw : raw?.url || raw?.location || raw?.path));
    if (u) urls.push(u);
  }
  const links = Array.isArray(challenge.extracted_links) ? challenge.extracted_links : [];
  for (const u of links) {
    const abs = toAbsolute(origin, cleanExtractedUrl(u));
    if (abs && isLikelyFileUrl(abs, origin)) urls.push(abs);
  }
  return [...new Set(urls)];
}

function challengeReadme(ch, urls, checksumMap = {}, manualChecks = []) {
  const lines = [
    `# ${ch.name || "Unknown"}`,
    "",
    `- ID: ${ch.id}`,
    `- Category: ${ch.category || "unknown"}`,
    `- Value: ${ch.value ?? "n/a"}`,
    `- Type: ${ch.type || "unknown"}`,
    `- Solves: ${ch.solves ?? "n/a"}`,
    ""
  ];
  if (urls.length) {
    lines.push("## Files");
    for (const u of urls) lines.push(`- ${displayFileName(u)} | sha256: ${checksumMap[u] || "n/a"}`);
    lines.push("");
  }
  if (Array.isArray(manualChecks) && manualChecks.length) {
    lines.push("## Manual Check");
    lines.push("These links were not downloaded automatically. Check them manually:");
    for (const m of manualChecks) lines.push(`- ${m}`);
    lines.push("");
  }
  if (Array.isArray(ch.hints) && ch.hints.length) {
    lines.push("## Hints");
    for (const h of ch.hints) {
      const content = h?.content || h?.hint || "";
      const hasContent = content && content.trim() && content.trim() !== "null" && content.trim() !== "undefined";
      if (hasContent) {
        // Hint is unlocked - show the content
        lines.push(`- ${String(content).replace(/\n/g, " ").slice(0, 220)}`);
      } else {
        // Hint is locked or unavailable - show availability message
        const costText = h?.cost ? ` (cost: ${h.cost} points)` : "";
        lines.push(`- 🔒 Hint available${costText}. Check manually or unlock to view.`);
      }
    }
    lines.push("");
  }
  lines.push("## Description", (ch.description || "(empty)").toString(), "");
  if (ch.connection_info) lines.push("## Connection Info", ch.connection_info.toString(), "");
  lines.push("## Notes", "(writeup placeholder)", "");
  return lines.join("\n");
}

async function downloadBlob(content, filename, mime = "application/json") {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  try { await chrome.downloads.download({ url, filename, saveAs: false, conflictAction: "overwrite" }); }
  finally { setTimeout(() => URL.revokeObjectURL(url), 1200); }
}

async function downloadBlobSafe(content, filename, mime, fallback) {
  try { await downloadBlob(content, filename, mime); } catch { await downloadBlob(content, fallback, mime); }
}

async function getKnownRegistry() { return (await chrome.storage.local.get(["knownFiles"]))?.knownFiles || {}; }
async function setKnownRegistry(reg) { await chrome.storage.local.set({ knownFiles: reg }); }

function serializeSelectionMap() {
  const out = {};
  for (const [k, v] of state.selectedFilesByChallenge.entries()) out[k] = Array.from(v);
  return out;
}

function restoreSelectionMap(obj) {
  state.selectedFilesByChallenge.clear();
  for (const [k, arr] of Object.entries(obj || {})) state.selectedFilesByChallenge.set(k, new Set(arr || []));
}

async function persistUiState() {
  try {
    const logsText = logsEl?.textContent || "";
    const data = {
      scan: state.scan,
      selectedChallenges: Array.from(state.selectedChallenges),
      selectedFilesByChallenge: serializeSelectionMap(),
      lastEstimate: state.lastEstimate,
      logs: logsText.slice(-120000),
      controls: {
        downloadFiles: !!downloadFilesEl?.checked,
        includeHintDetails: !!includeHintDetailsEl?.checked,
        computeHash: true,
        skipKnown: !!skipKnownEl?.checked,
        retryCount: String(DEFAULT_RETRY_COUNT),
        timeoutMs: String(DEFAULT_TIMEOUT_MS),
        filterCategory: filterCategoryEl?.value || "all",
        filterSolved: filterSolvedEl?.value || "all",
        exportMode: document.querySelector("input[name='exportMode']:checked")?.value || "direct"
      },
      progress: progressSnapshot()
    };
    await chrome.storage.local.set({ popupState: data });
  } catch (e) {
    reportStorageIssue(e, "persist_ui_state");
  }
}

async function restoreUiState() {
  try {
    const data = (await chrome.storage.local.get(["popupState"]))?.popupState;
    if (!data) return;

    if (data.controls) {
      downloadFilesEl.checked = !!data.controls.downloadFiles;
      includeHintDetailsEl.checked = !!data.controls.includeHintDetails;
      skipKnownEl.checked = !!data.controls.skipKnown;
      if (filterSolvedEl) filterSolvedEl.value = data.controls.filterSolved || "all";
      const mode = data.controls.exportMode || "direct";
      const radio = document.querySelector(`input[name='exportMode'][value='${mode}']`);
      if (radio) radio.checked = true;
    }

    if (typeof data.logs === "string" && logsEl) logsEl.textContent = data.logs;

    state.scan = data.scan || null;
    state.lastEstimate = data.lastEstimate || null;
    state.selectedChallenges = new Set(data.selectedChallenges || []);
    restoreSelectionMap(data.selectedFilesByChallenge || {});
    applyProgressSnapshot(data.progress || null);
    renderProgress();

    if (state.scan) {
      populateCategoryFilter();
      if (data.controls?.filterCategory && filterCategoryEl && [...filterCategoryEl.options].some((o) => o.value === data.controls.filterCategory)) {
        filterCategoryEl.value = data.controls.filterCategory;
      }
      renderPreview();
    }
  } catch (e) {
    reportStorageIssue(e, "restore_ui_state");
  }
}

function populateCategoryFilter() {
  if (!filterCategoryEl) return;
  const old = filterCategoryEl.value || "all";
  filterCategoryEl.innerHTML = "";
  const all = document.createElement("option");
  all.value = "all";
  all.textContent = "All categories";
  filterCategoryEl.appendChild(all);
  if (!state.scan) return;
  const cats = [...new Set(state.scan.challenges.map((c) => c.category || "uncategorized"))].sort();
  for (const c of cats) {
    const op = document.createElement("option");
    op.value = c;
    op.textContent = c;
    filterCategoryEl.appendChild(op);
  }
  if ([...filterCategoryEl.options].some((o) => o.value === old)) filterCategoryEl.value = old;
}

function filteredChallenges() {
  if (!state.scan) return [];
  const cat = filterCategoryEl?.value || "all";
  const solved = filterSolvedEl?.value || "all";
  return state.scan.challenges.filter((c) => {
    if (cat !== "all" && (c.category || "uncategorized") !== cat) return false;
    if (solved !== "all") {
      const isSolved = normalizedSolved(c);
      if (solved === "solved" && !isSolved) return false;
      if (solved === "unsolved" && isSolved) return false;
    }
    return true;
  });
}

function orderedChallenges(list) {
  if (!state.scan || !Array.isArray(list)) return list || [];
  const catOrder = Array.isArray(state.scan.category_order) ? state.scan.category_order : [];
  const catRank = new Map(catOrder.map((c, i) => [String(c), i]));
  const defaultCatBase = catOrder.length + 1000;
  return [...list].sort((a, b) => {
    const ar = catRank.has(String(a.category || "")) ? catRank.get(String(a.category || "")) : defaultCatBase;
    const br = catRank.has(String(b.category || "")) ? catRank.get(String(b.category || "")) : defaultCatBase;
    if (ar !== br) return ar - br;
    const ao = Number.isFinite(a.ui_order) ? a.ui_order : Number.MAX_SAFE_INTEGER;
    const bo = Number.isFinite(b.ui_order) ? b.ui_order : Number.MAX_SAFE_INTEGER;
    if (ao !== bo) return ao - bo;
    const ai = Number.isFinite(a.scan_index) ? a.scan_index : 0;
    const bi = Number.isFinite(b.scan_index) ? b.scan_index : 0;
    return ai - bi;
  });
}

function initSelection(scan) {
  state.selectedChallenges.clear();
  state.selectedFilesByChallenge.clear();
  for (const ch of scan.challenges) {
    const key = String(ch.id);
    state.selectedChallenges.add(key);
    state.selectedFilesByChallenge.set(key, new Set(fileCandidates(scan.origin, ch)));
  }
  void persistUiState();
}

function countSelectedFiles(challenge) {
  return (state.selectedFilesByChallenge.get(String(challenge.id)) || new Set()).size;
}

function normalizedSolved(ch) {
  if (!ch) return false;
  if (typeof ch.solved === "boolean") return ch.solved;
  if (typeof ch.solved_by_me === "boolean") return ch.solved_by_me;
  if (typeof ch.is_solved === "boolean") return ch.is_solved;
  if (typeof ch.attempted === "boolean" && ch.attempted === false) return false;
  if (typeof ch.status === "string") {
    const s = ch.status.toLowerCase();
    if (s === "solved") return true;
    if (s === "unsolved") return false;
  }
  return false;
}

function updateSummary() {
  if (!state.scan) { summaryEl.textContent = "No scan yet."; return; }
  const all = state.scan.challenges;
  const filtered = filteredChallenges();
  const selectedAllChallenges = all.filter((c) => state.selectedChallenges.has(String(c.id))).length;
  const selectedFilteredChallenges = filtered.filter((c) => state.selectedChallenges.has(String(c.id))).length;
  let selectedAllFiles = 0;
  for (const c of all) if (state.selectedChallenges.has(String(c.id))) selectedAllFiles += countSelectedFiles(c);
  let selectedFilteredFiles = 0;
  for (const c of filtered) if (state.selectedChallenges.has(String(c.id))) selectedFilteredFiles += countSelectedFiles(c);
  const est = state.lastEstimate ? ` | Estimated: ${(state.lastEstimate.knownBytes / (1024 * 1024)).toFixed(2)} MB${state.lastEstimate.unknownCount ? ` + ${state.lastEstimate.unknownCount} unknown` : ""}` : "";
  summaryEl.textContent = `Selected ${selectedFilteredChallenges}/${filtered.length} challenges, ${selectedFilteredFiles} files in current filter | Total ${selectedAllChallenges}/${all.length}, ${selectedAllFiles} files.${est}`;
}
function renderPreview() {
  previewEl.innerHTML = "";
  if (!state.scan) {
    previewEl.innerHTML = '<div class="empty">Click Scan Challenges to load data.</div>';
    updateSummary();
    return;
  }
  const list = orderedChallenges(filteredChallenges());
  if (!list.length) {
    previewEl.innerHTML = '<div class="empty">No challenges match current filters.</div>';
    updateSummary();
    return;
  }
  const grouped = [];
  const gmap = new Map();
  for (const ch of list) {
    const cat = ch.category || "uncategorized";
    if (!gmap.has(cat)) {
      const g = { name: cat, items: [] };
      gmap.set(cat, g);
      grouped.push(g);
    }
    gmap.get(cat).items.push(ch);
  }

  const addCard = (ch) => {
    const key = String(ch.id);
    const urls = fileCandidates(state.scan.origin, ch);
    const box = document.createElement("div"); box.className = "challenge";
    const head = document.createElement("div"); head.className = "head";
    const challengeCheck = document.createElement("input");
    challengeCheck.type = "checkbox";
    challengeCheck.checked = state.selectedChallenges.has(key);
    challengeCheck.addEventListener("change", () => {
      if (challengeCheck.checked) state.selectedChallenges.add(key); else state.selectedChallenges.delete(key);
      updateSummary(); renderPreview();
    });
    const info = document.createElement("div");
    const nm = document.createElement("div"); nm.className = "name"; nm.textContent = ch.name || `Challenge ${ch.id}`;
    const meta = document.createElement("div"); meta.className = "meta";
    const solvedLabel = normalizedSolved(ch) ? "solved" : "unsolved";
    meta.textContent = `${ch.category || "uncategorized"} | ${ch.value ?? "?"} pts | ${solvedLabel} | ID ${ch.id}`;
    info.appendChild(nm); info.appendChild(meta);
    const chip = document.createElement("div"); chip.className = "chip"; chip.textContent = `${countSelectedFiles(ch)}/${urls.length} files`;
    head.appendChild(challengeCheck); head.appendChild(info); head.appendChild(chip); box.appendChild(head);

    if (downloadFilesEl.checked && urls.length) {
      const filesWrap = document.createElement("div"); filesWrap.className = "files";
      const title = document.createElement("div"); title.className = "title"; title.textContent = "Files";
      filesWrap.appendChild(title);
      for (const u of urls) {
        const row = document.createElement("div"); row.className = "file-row";
        const cbox = document.createElement("input"); cbox.type = "checkbox";
        cbox.disabled = !state.selectedChallenges.has(key);
        cbox.checked = state.selectedFilesByChallenge.get(key)?.has(u) || false;
        cbox.addEventListener("change", () => {
          const set = state.selectedFilesByChallenge.get(key) || new Set();
          if (cbox.checked) set.add(u); else set.delete(u);
          state.selectedFilesByChallenge.set(key, set);
          chip.textContent = `${countSelectedFiles(ch)}/${urls.length} files`;
          updateSummary();
        });
        const txt = document.createElement("div"); txt.className = "file-name"; txt.textContent = displayFileName(u);
        row.appendChild(cbox); row.appendChild(txt); filesWrap.appendChild(row);
      }
      box.appendChild(filesWrap);
    }
    previewEl.appendChild(box);
  };

  for (const g of grouped) {
    const h = document.createElement("div");
    h.className = "category-section-title";
    h.textContent = g.name;
    previewEl.appendChild(h);
    for (const ch of g.items) addCard(ch);
  }
  updateSummary();
  void persistUiState();
}

function selectedPayload() {
  if (!state.scan) return null;
  const challenges = [];
  const ordered = orderedChallenges(state.scan.challenges || []);
  for (const ch of ordered) {
    const key = String(ch.id);
    if (!state.selectedChallenges.has(key)) continue;
    challenges.push({ ...ch, selected_files: Array.from(state.selectedFilesByChallenge.get(key) || new Set()), file_checksums: {} });
  }
  return {
    export_schema_version: EXPORT_SCHEMA_VERSION,
    origin: state.scan.origin,
    ctf_name: state.scan.ctf_name,
    exported_at: new Date().toISOString(),
    challenge_count: challenges.length,
    challenges
  };
}

async function callInjected(tabId, func, args) {
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func, args: [args] });
  return result;
}

function buildCollector() {
  return async (opts) => {
    try {
      const cleanUrl = (raw) => {
        if (!raw) return "";
        let u = String(raw).trim();
        while (/[)\],.;!?]+$/.test(u)) u = u.slice(0, -1);
        return u;
      };
      const toAbs = (origin, pathOrUrl) => {
        if (!pathOrUrl) return "";
        if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
        if (pathOrUrl.startsWith("//")) return `https:${pathOrUrl}`;
        if (pathOrUrl.startsWith("/")) return `${origin}${pathOrUrl}`;
        return `${origin}/${pathOrUrl}`;
      };
      const extractLinks = (origin, text) => {
        if (!text || typeof text !== "string") return [];
        const out = [];
        const urlRegex = /(https?:\/\/[^\s"'<>]+|\/(?:files|uploads|plugins)[^\s"'<>]+)/gi;
        for (const m of text.matchAll(urlRegex)) out.push(toAbs(origin, cleanUrl(m[1])));
        const hrefRegex = /(?:href|src)=["']([^"']+)["']/gi;
        for (const m of text.matchAll(hrefRegex)) out.push(toAbs(origin, cleanUrl(m[1])));
        return out;
      };
      const fetchJsonRetry = async (url) => {
        for (let i = 0; i <= opts.retryCount; i += 1) {
          const ctl = new AbortController();
          const t = setTimeout(() => ctl.abort(), opts.timeoutMs);
          try {
            const res = await fetch(url, { credentials: "include", headers: { Accept: "application/json" }, signal: ctl.signal });
            clearTimeout(t);
            return res;
          } catch {
            clearTimeout(t);
            if (i >= opts.retryCount) throw new Error(`Request failed: ${url}`);
          }
        }
      };
      const origin = window.location.origin;
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
      const domOrderIds = [];
      const domOrderNames = [];
      const domCategoryOrder = [];
      const pushUnique = (arr, v) => { if (v && !arr.includes(v)) arr.push(v); };

      try {
        const challengeNodes = document.querySelectorAll(
          "[data-challenge-id], [data-challenge], .challenge-button, .challenge-card, .chal, .challenge-tile, .challenge"
        );
        for (const el of challengeNodes) {
          const idRaw =
            el.getAttribute("data-challenge-id") ||
            el.dataset?.challengeId ||
            el.getAttribute("data-challenge") ||
            el.dataset?.challenge;
          const idNum = Number(idRaw);
          if (Number.isFinite(idNum)) pushUnique(domOrderIds, idNum);

          const nameRaw =
            el.getAttribute("data-challenge-name") ||
            el.querySelector?.(".challenge-name, .chal-name, .card-title, .name, h2, h3, h4")?.textContent ||
            el.textContent ||
            "";
          const name = nameRaw.replace(/\s+/g, " ").trim();
          if (name) pushUnique(domOrderNames, norm(name));
        }

        const headingNodes = document.querySelectorAll("h1, h2, h3, h4, h5, .category-name, .challenge-category-title, .section-title");
        for (const h of headingNodes) {
          const t = (h.textContent || "").replace(/\s+/g, " ").trim();
          if (t) pushUnique(domCategoryOrder, t);
        }
      } catch {}

      const listRes = await fetchJsonRetry(`${origin}/api/v1/challenges`);
      if (!listRes.ok) return { ok: false, error: `Challenge list request failed (${listRes.status})` };
      const listJson = await listRes.json();
      const list = Array.isArray(listJson?.data) ? listJson.data : [];
      const output = [];
      for (let idx = 0; idx < list.length; idx += 1) {
        const c = list[idx];
        const detailRes = await fetchJsonRetry(`${origin}/api/v1/challenges/${c.id}`);
        if (!detailRes.ok) {
          output.push({
            id: c.id,
            name: c.name || "",
            category: c.category || "",
            value: c.value,
            type: c.type || "",
            solves: c.solves,
            solved: c.solved ?? c.solved_by_me ?? c.is_solved ?? null,
            solved_by_me: c.solved_by_me ?? null,
            is_solved: c.is_solved ?? null,
            attempted: c.attempted ?? null,
            detail_error: `Failed to load details (${detailRes.status})`,
            files: [],
            extracted_links: [],
            scan_index: idx
          });
          continue;
        }
        const d = (await detailRes.json())?.data || {};
        let hints = Array.isArray(d.hints) ? d.hints : [];
        if (opts.includeHintDetails && hints.length) {
          const detailed = [];
          for (const h of hints) {
            if (!h?.id) { detailed.push(h); continue; }
            try {
              const hr = await fetchJsonRetry(`${origin}/api/v1/hints/${h.id}`);
              if (hr.ok) {
                const hj = await hr.json();
                detailed.push({ ...h, content: hj?.data?.content ?? h.content, detail_available: true });
              } else detailed.push({ ...h, detail_available: false });
            } catch { detailed.push({ ...h, detail_available: false }); }
          }
          hints = detailed;
        }
        const links = [...extractLinks(origin, d.description || ""), ...extractLinks(origin, d.connection_info || "")];
        output.push({
          id: d.id ?? c.id,
          name: d.name ?? c.name ?? "",
          category: d.category ?? c.category ?? "",
          value: d.value ?? c.value,
          type: d.type ?? c.type ?? "",
          state: d.state ?? c.state,
          solved: d.solved ?? d.solved_by_me ?? d.is_solved ?? c.solved ?? c.solved_by_me ?? c.is_solved ?? null,
          solved_by_me: d.solved_by_me ?? c.solved_by_me ?? null,
          is_solved: d.is_solved ?? c.is_solved ?? null,
          attempted: d.attempted ?? c.attempted ?? null,
          solves: d.solves ?? c.solves,
          max_attempts: d.max_attempts,
          description: d.description ?? "",
          connection_info: d.connection_info ?? "",
          hints,
          tags: Array.isArray(d.tags) ? d.tags : [],
          topics: Array.isArray(d.topics) ? d.topics : [],
          files: Array.isArray(d.files) ? d.files : [],
          extracted_links: [...new Set(links)],
          scan_index: idx
        });
      }

      const catsInScan = [...new Set(output.map((o) => o.category || "uncategorized"))];
      const category_order = [];
      for (const h of domCategoryOrder) {
        const m = catsInScan.find((c) => norm(c) === norm(h));
        if (m && !category_order.includes(m)) category_order.push(m);
      }
      for (const c of catsInScan) if (!category_order.includes(c)) category_order.push(c);

      const idOrder = new Map(domOrderIds.map((id, i) => [Number(id), i]));
      const nameOrder = new Map(domOrderNames.map((n, i) => [n, i]));
      for (const o of output) {
        const idRank = idOrder.has(Number(o.id)) ? idOrder.get(Number(o.id)) : null;
        const nameRank = nameOrder.has(norm(o.name || "")) ? nameOrder.get(norm(o.name || "")) : null;
        o.ui_order = Number.isFinite(idRank) ? idRank : (Number.isFinite(nameRank) ? nameRank : o.scan_index);
      }
      let ctfName = "";
      try {
        const cfgRes = await fetchJsonRetry(`${origin}/api/v1/config`);
        if (cfgRes.ok) {
          const cfg = await cfgRes.json();
          ctfName = cfg?.data?.ctf_name || cfg?.data?.name || "";
        }
      } catch {}
      if (!ctfName) ctfName = (document.querySelector("title")?.textContent || "").trim() || window.location.hostname || "ctfd_export";
      return {
        ok: true,
        export_schema_version: "2.0.0",
        origin,
        ctf_name: ctfName,
        exported_at: new Date().toISOString(),
        challenge_count: output.length,
        category_order,
        challenges: output
      };
    } catch (e) { return { ok: false, error: e?.message || "Unknown scan error" }; }
  };
}

function buildScanBootstrap() {
  return async ({ timeoutMs, retryCount }) => {
    try {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
      const domOrderIds = [];
      const domOrderNames = [];
      const domCategoryOrder = [];
      const pushUnique = (arr, v) => { if (v && !arr.includes(v)) arr.push(v); };
      try {
        const challengeNodes = document.querySelectorAll(
          "[data-challenge-id], [data-challenge], .challenge-button, .challenge-card, .chal, .challenge-tile, .challenge"
        );
        for (const el of challengeNodes) {
          const idRaw = el.getAttribute("data-challenge-id") || el.dataset?.challengeId || el.getAttribute("data-challenge") || el.dataset?.challenge;
          const idNum = Number(idRaw);
          if (Number.isFinite(idNum)) pushUnique(domOrderIds, idNum);
          const nameRaw = el.getAttribute("data-challenge-name") || el.querySelector?.(".challenge-name, .chal-name, .card-title, .name, h2, h3, h4")?.textContent || el.textContent || "";
          const name = nameRaw.replace(/\s+/g, " ").trim();
          if (name) pushUnique(domOrderNames, norm(name));
        }
        const headingNodes = document.querySelectorAll("h1, h2, h3, h4, h5, .category-name, .challenge-category-title, .section-title");
        for (const h of headingNodes) {
          const t = (h.textContent || "").replace(/\s+/g, " ").trim();
          if (t) pushUnique(domCategoryOrder, t);
        }
      } catch {}

      const fetchJsonRetry = async (url) => {
        for (let i = 0; i <= retryCount; i += 1) {
          const ctl = new AbortController();
          const t = setTimeout(() => ctl.abort(), timeoutMs);
          try {
            const res = await fetch(url, { credentials: "include", headers: { Accept: "application/json" }, signal: ctl.signal });
            clearTimeout(t);
            return res;
          } catch {
            clearTimeout(t);
            if (i >= retryCount) throw new Error(`Request failed: ${url}`);
          }
        }
      };
      const origin = window.location.origin;
      const listRes = await fetchJsonRetry(`${origin}/api/v1/challenges`);
      if (!listRes.ok) return { ok: false, error: `Challenge list request failed (${listRes.status})` };
      const listJson = await listRes.json();
      const list = Array.isArray(listJson?.data) ? listJson.data : [];
      let ctfName = "";
      try {
        const cfgRes = await fetchJsonRetry(`${origin}/api/v1/config`);
        if (cfgRes.ok) {
          const cfg = await cfgRes.json();
          ctfName = cfg?.data?.ctf_name || cfg?.data?.name || "";
        }
      } catch {}
      if (!ctfName) ctfName = (document.querySelector("title")?.textContent || "").trim() || window.location.hostname || "ctfd_export";
      return { ok: true, origin, ctf_name: ctfName, list, domOrderIds, domOrderNames, domCategoryOrder };
    } catch (e) {
      return { ok: false, error: e?.message || "bootstrap_failed" };
    }
  };
}

function buildChallengeDetailFetcher() {
  return async ({ id, includeHintDetails, timeoutMs, retryCount }) => {
    try {
      const origin = window.location.origin;
      const cleanUrl = (raw) => {
        if (!raw) return "";
        let u = String(raw).trim();
        while (/[)\],.;!?]+$/.test(u)) u = u.slice(0, -1);
        return u;
      };
      const toAbs = (pathOrUrl) => {
        if (!pathOrUrl) return "";
        if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
        if (pathOrUrl.startsWith("//")) return `https:${pathOrUrl}`;
        if (pathOrUrl.startsWith("/")) return `${origin}${pathOrUrl}`;
        return `${origin}/${pathOrUrl}`;
      };
      const extractLinks = (text) => {
        if (!text || typeof text !== "string") return [];
        const out = [];
        const urlRegex = /(https?:\/\/[^\s"'<>]+|\/(?:files|uploads|plugins)[^\s"'<>]+)/gi;
        for (const m of text.matchAll(urlRegex)) out.push(toAbs(cleanUrl(m[1])));
        const hrefRegex = /(?:href|src)=["']([^"']+)["']/gi;
        for (const m of text.matchAll(hrefRegex)) out.push(toAbs(cleanUrl(m[1])));
        return [...new Set(out)];
      };
      const fetchJsonRetry = async (url) => {
        for (let i = 0; i <= retryCount; i += 1) {
          const ctl = new AbortController();
          const t = setTimeout(() => ctl.abort(), timeoutMs);
          try {
            const res = await fetch(url, { credentials: "include", headers: { Accept: "application/json" }, signal: ctl.signal });
            clearTimeout(t);
            return res;
          } catch {
            clearTimeout(t);
            if (i >= retryCount) throw new Error(`Request failed: ${url}`);
          }
        }
      };
      const detailRes = await fetchJsonRetry(`${origin}/api/v1/challenges/${id}`);
      if (!detailRes.ok) return { ok: false, error: `Failed to load details (${detailRes.status})`, id };
      const d = (await detailRes.json())?.data || {};
      let hints = Array.isArray(d.hints) ? d.hints : [];
      if (includeHintDetails && hints.length) {
        const detailed = [];
        for (const h of hints) {
          if (!h?.id) { detailed.push(h); continue; }
          try {
            const hr = await fetchJsonRetry(`${origin}/api/v1/hints/${h.id}`);
            if (hr.ok) {
              const hj = await hr.json();
              detailed.push({ ...h, content: hj?.data?.content ?? h.content, detail_available: true });
            } else detailed.push({ ...h, detail_available: false });
          } catch { detailed.push({ ...h, detail_available: false }); }
        }
        hints = detailed;
      }
      return {
        ok: true,
        data: {
          id: d.id ?? id,
          name: d.name ?? "",
          category: d.category ?? "",
          value: d.value,
          type: d.type ?? "",
          state: d.state,
          solved: d.solved ?? d.solved_by_me ?? d.is_solved ?? null,
          solved_by_me: d.solved_by_me ?? null,
          is_solved: d.is_solved ?? null,
          attempted: d.attempted ?? null,
          solves: d.solves,
          max_attempts: d.max_attempts,
          description: d.description ?? "",
          connection_info: d.connection_info ?? "",
          hints,
          tags: Array.isArray(d.tags) ? d.tags : [],
          topics: Array.isArray(d.topics) ? d.topics : [],
          files: Array.isArray(d.files) ? d.files : [],
          extracted_links: [...new Set([...extractLinks(d.description || ""), ...extractLinks(d.connection_info || "")])]
        }
      };
    } catch (e) {
      return { ok: false, error: e?.message || "detail_fetch_failed", id };
    }
  };
}

function buildEstimateFetcher() {
  return async ({ urls, timeoutMs, retryCount }) => {
    const out = { knownBytes: 0, unknownCount: 0, byUrl: {} };
    const tryLen = async (url) => {
      for (let i = 0; i <= retryCount; i += 1) {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), timeoutMs);
        try {
          let res = await fetch(url, { method: "HEAD", credentials: "include", signal: ctl.signal });
          clearTimeout(t);
          if (!res.ok) res = await fetch(url, { method: "GET", credentials: "include", signal: ctl.signal });
          const len = Number(res.headers.get("content-length") || "0");
          return Number.isFinite(len) && len > 0 ? len : null;
        } catch {
          clearTimeout(t);
          if (i >= retryCount) return null;
        }
      }
      return null;
    };
    for (const u of urls) {
      const len = await tryLen(u);
      out.byUrl[u] = len;
      if (len == null) out.unknownCount += 1; else out.knownBytes += len;
    }
    return out;
  };
}

function buildFileFetcher() {
  return async ({ url, timeoutMs, retryCount, includeBytes, computeHash }) => {
    const abToBase64 = (ab) => {
      const bytes = new Uint8Array(ab); let bin = ""; const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.slice(i, i + chunk));
      return btoa(bin);
    };
    const hashHex = async (ab) => {
      const d = await crypto.subtle.digest("SHA-256", ab);
      return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
    };
    for (let i = 0; i <= retryCount; i += 1) {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const res = await fetch(url, { method: "GET", credentials: "include", signal: ctl.signal });
        clearTimeout(t);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const ab = await res.arrayBuffer();
        return { ok: true, size: ab.byteLength, sha256: computeHash ? await hashHex(ab) : null, base64: includeBytes ? abToBase64(ab) : null };
      } catch (e) {
        clearTimeout(t);
        if (i >= retryCount) return { ok: false, error: e?.message || "fetch_failed" };
      }
    }
    return { ok: false, error: "fetch_failed" };
  };
}
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256Hex(bytes) {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function fetchExternalForZip(url, options) {
  for (let i = 0; i <= options.retryCount; i += 1) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), options.timeoutMs);
    try {
      const res = await fetch(url, { method: "GET", signal: ctl.signal });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ab = await res.arrayBuffer();
      const bytes = new Uint8Array(ab);
      return { ok: true, bytes, sha256: await sha256Hex(ab) };
    } catch (e) {
      clearTimeout(t);
      if (i >= options.retryCount) return { ok: false, error: e?.message || "external_fetch_failed" };
    }
  }
  return { ok: false, error: "external_fetch_failed" };
}

function crc32Table() {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let j = 0; j < 8; j += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
}
const CRC_TABLE = crc32Table();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d = new Date()) {
  const y = Math.max(1980, d.getFullYear());
  return { dosDate: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(), dosTime: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2) };
}

class ZipBuilder {
  constructor() { this.files = []; this.encoder = new TextEncoder(); }
  addFile(path, bytes) {
    const name = this.encoder.encode(path.replace(/\\/g, "/"));
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.files.push({ name, data, crc: crc32(data) });
  }
  build() {
    const chunks = [];
    const central = [];
    let offset = 0;
    const { dosDate, dosTime } = dosDateTime();
    for (const f of this.files) {
      const local = new ArrayBuffer(30 + f.name.length);
      const lv = new DataView(local);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(8, 0, true);
      lv.setUint16(10, dosTime, true);
      lv.setUint16(12, dosDate, true);
      lv.setUint32(14, f.crc, true);
      lv.setUint32(18, f.data.length, true);
      lv.setUint32(22, f.data.length, true);
      lv.setUint16(26, f.name.length, true);
      new Uint8Array(local, 30).set(f.name);
      chunks.push(new Uint8Array(local));
      chunks.push(f.data);

      const c = new ArrayBuffer(46 + f.name.length);
      const cv = new DataView(c);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(12, dosTime, true);
      cv.setUint16(14, dosDate, true);
      cv.setUint32(16, f.crc, true);
      cv.setUint32(20, f.data.length, true);
      cv.setUint32(24, f.data.length, true);
      cv.setUint16(28, f.name.length, true);
      cv.setUint32(42, offset, true);
      new Uint8Array(c, 46).set(f.name);
      central.push(new Uint8Array(c));
      offset += 30 + f.name.length + f.data.length;
    }

    const centralSize = central.reduce((s, a) => s + a.length, 0);
    const end = new ArrayBuffer(22);
    const ev = new DataView(end);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, this.files.length, true);
    ev.setUint16(10, this.files.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);

    const total = [...chunks, ...central, new Uint8Array(end)];
    const size = total.reduce((s, a) => s + a.length, 0);
    const out = new Uint8Array(size);
    let p = 0;
    for (const arr of total) { out.set(arr, p); p += arr.length; }
    return out;
  }
}

async function fetchFileMetaFromPage(tabId, url, options, includeBytes) {
  return callInjected(tabId, buildFileFetcher(), { url, timeoutMs: options.timeoutMs, retryCount: options.retryCount, includeBytes, computeHash: options.computeHash });
}

async function downloadWithRetry(url, filename, retryCount, timeoutMs) {
  ensureDownloadEvents();
  const label = displayFileName(url);
  for (let i = 0; i <= retryCount; i += 1) {
    try {
      logLine(`Queued ${label}${retryCount ? ` (try ${i + 1}/${retryCount + 1})` : ""}`, "INF");
      onProgressQueued(label);
      const id = await chrome.downloads.download({ url, filename, saveAs: false, conflictAction: "uniquify" });
      if (typeof id === "number") {
        const terminal = new Promise((resolve) => {
          const timer = setTimeout(() => {
            const r = liveDownloads.get(id);
            if (r) {
              logLine(`Timeout waiting for ${label} completion`, "ERR");
              liveDownloads.delete(id);
            }
            resolve({ ok: false, error: "timeout" });
          }, Math.max(20000, timeoutMs * 4));
          liveDownloads.set(id, {
            label,
            total: 0,
            nextPct: 10,
            lastBytesLogged: 0,
            prevTs: Date.now(),
            prevBytes: 0,
            smoothedSpeedBps: 0,
            lastNonZeroAt: 0,
            resolve: (res) => { clearTimeout(timer); resolve(res); }
          });
        });
        const res = await terminal;
        if (res.ok) {
          return { ok: true, error: null };
        }
        if (i >= retryCount) {
          logLine(`Failed ${label}: ${res.error || "download interrupted"}`, "ERR");
          return { ok: false, error: res.error || "download interrupted" };
        }
        logLine(`Retrying ${label} after error: ${res.error || "unknown"}`, "ERR");
        await delay(350);
        continue;
      }
      logLine(`Download API returned no id for ${label}`, "ERR");
      return { ok: false, error: "download_api_no_id" };
    } catch (e) {
      const reason = e?.message || "unknown error";
      if (i >= retryCount) {
        logLine(`Failed ${label}: ${reason}`, "ERR");
        return { ok: false, error: reason };
      }
      logLine(`Retrying ${label} after error: ${reason}`, "ERR");
      await delay(350);
    }
  }
  return { ok: false, error: "unknown" };
}

async function exportDirect(selected, options, tabId) {
  const root = safePathPart(selected.ctf_name || "ctfd_export", "ctfd_export", 70);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  await downloadBlobSafe(JSON.stringify(selected, null, 2), `${root}/challenges_${ts}.json`, "application/json", `${root}/challenges.json`);
  if (!options.downloadFiles) return { files: 0, skipped: 0 };

  const reg = await getKnownRegistry();
  let files = 0, skipped = 0, failed = 0, attempted = 0;
  startProgress(selected.challenges.length);

  for (const ch of selected.challenges) {
    setProgressChallenge(`${ch.id} ${safePathPart(ch.name || "unknown", "unknown", 40)}`);
    const baseDir = `${root}/${safePathPart(ch.category || "uncategorized", "uncategorized", 60)}/${safePathPart(`${ch.id}_${ch.name}`, `challenge_${ch.id || "unknown"}`, 70)}`;
    const checks = {};
    const chSkipped = [];
    const manualChecks = [];
    const chFailed = [];
    logLine(`Challenge ${ch.id}: ${safePathPart(ch.name || "unknown", "unknown", 60)}`, "INF");
    for (const rawUrl of ch.selected_files || []) {
      const url = cleanExtractedUrl(rawUrl);
      if (!url) continue;
      attempted += 1;
      if (options.skipKnown && reg[url] && reg[url].from === selected.ctf_name) {
        skipped += 1;
        chSkipped.push(`${displayFileName(url)} (already exported)`);
        continue;
      }
      const dres = await downloadWithRetry(url, `${baseDir}/${safePathPart(displayFileName(url), "file", 90)}`, options.retryCount, options.timeoutMs);
      if (dres.ok) {
        files += 1;
        reg[url] = { at: Date.now(), from: selected.ctf_name };
        logLine(`Saved ${displayFileName(url)} (${files}/${attempted})`, "OK");
      } else {
        failed += 1;
        const reason = dres.error || "download_failed";
        chFailed.push({ file: displayFileName(url), reason });
        logLine(`Download failed: ${url} (${reason})`, "ERR");
      }
      await delay(120);
    }
    ch.file_checksums = checks;
    await downloadBlobSafe(challengeReadme(ch, ch.selected_files || [], checks, manualChecks), `${baseDir}/README.md`, "text/markdown", `${root}/README.md`);
    onChallengeDone({ challenge: `${ch.id} ${ch.name || "unknown"}`, skipped: chSkipped, failed: chFailed });
  }

  await setKnownRegistry(reg);
  return { files, skipped, failed, attempted };
}

async function exportZip(selected, options, tabId) {
  const root = safePathPart(selected.ctf_name || "ctfd_export", "ctfd_export", 70);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const zip = new ZipBuilder();
  zip.addFile(`${root}/challenges_${ts}.json`, new TextEncoder().encode(JSON.stringify(selected, null, 2)));

  const reg = await getKnownRegistry();
  let files = 0, skipped = 0, failed = 0, attempted = 0;
  startProgress(selected.challenges.length);

  for (const ch of selected.challenges) {
    setProgressChallenge(`${ch.id} ${safePathPart(ch.name || "unknown", "unknown", 40)}`);
    const baseDir = `${root}/${safePathPart(ch.category || "uncategorized", "uncategorized", 60)}/${safePathPart(`${ch.id}_${ch.name}`, `challenge_${ch.id || "unknown"}`, 70)}`;
    const checks = {};
    const chSkipped = [];
    const manualChecks = [];
    const chFailed = [];
    logLine(`ZIP challenge ${ch.id}: ${safePathPart(ch.name || "unknown", "unknown", 60)}`, "INF");
    if (options.downloadFiles) {
      for (const rawUrl of ch.selected_files || []) {
        const url = cleanExtractedUrl(rawUrl);
        if (!url) continue;
        attempted += 1;
        const isSameOrigin = (() => {
          try { return new URL(url, selected.origin).origin === selected.origin; } catch { return false; }
        })();
        try {
          const u = new URL(url, selected.origin);
          if (!/^https?:$/i.test(u.protocol)) throw new Error("invalid_protocol");
        } catch {
          skipped += 1;
          chSkipped.push(`${displayFileName(url)} (invalid url)`);
          manualChecks.push(url);
          continue;
        }
        if (options.skipKnown && reg[url] && reg[url].from === selected.ctf_name) {
          skipped += 1;
          chSkipped.push(`${displayFileName(url)} (already exported)`);
          continue;
        }
        if (isSameOrigin) {
          let meta = await fetchFileMetaFromPage(tabId, url, options, true);
          if ((!meta?.ok || !meta.base64) && options.computeHash) {
            // Fallback so checksum failures do not skip file bytes.
            meta = await fetchFileMetaFromPage(tabId, url, { ...options, computeHash: false }, true);
          }
          if (!meta?.ok || !meta.base64) {
            failed += 1;
            const reason = meta?.error || "zip_fetch_failed";
            chFailed.push({ file: displayFileName(url), reason });
            logLine(`ZIP fetch failed for ${displayFileName(url)}: ${reason}`, "ERR");
            continue;
          }
          onProgressQueued(displayFileName(url));
          onProgressTick(displayFileName(url), 100);
          zip.addFile(`${baseDir}/${safePathPart(displayFileName(url), "file", 90)}`, b64ToBytes(meta.base64));
          if (meta.sha256) checks[url] = meta.sha256;
          files += 1;
          logLine(`ZIP added ${displayFileName(url)} (${files}/${attempted})`, "OK");
          reg[url] = { at: Date.now(), from: selected.ctf_name, sha256: meta.sha256 || null };
        } else {
          const ext = await fetchExternalForZip(url, options);
          if (!ext.ok || !ext.bytes) {
            skipped += 1;
            chSkipped.push(`${displayFileName(url)} (external fetch failed: ${ext.error || "unknown"})`);
            manualChecks.push(url);
            continue;
          }
          onProgressQueued(displayFileName(url));
          onProgressTick(displayFileName(url), 100);
          zip.addFile(`${baseDir}/${safePathPart(displayFileName(url), "file", 90)}`, ext.bytes);
          if (ext.sha256) checks[url] = ext.sha256;
          files += 1;
          logLine(`ZIP added external ${displayFileName(url)} (${files}/${attempted})`, "OK");
          reg[url] = { at: Date.now(), from: selected.ctf_name, sha256: ext.sha256 || null };
        }
        await delay(80);
      }
    }
    ch.file_checksums = checks;
    zip.addFile(`${baseDir}/README.md`, new TextEncoder().encode(challengeReadme(ch, ch.selected_files || [], checks, manualChecks)));
    onChallengeDone({ challenge: `${ch.id} ${ch.name || "unknown"}`, skipped: chSkipped, failed: chFailed });
  }

  await setKnownRegistry(reg);
  await downloadBlobSafe(new Blob([zip.build()], { type: "application/zip" }), `${root}_${ts}.zip`, "application/zip", `${root}.zip`);
  return { files, skipped, failed, attempted };
}

async function exportSelected() {
  if (state.busy) return;
  if (exportProgress.phase === "running") return setStatus("An export is already running.", "err");
  if (!state.scan) return setStatus("Please run scan first.", "err");
  const selected = selectedPayload();
  if (!selected.challenges.length) return setStatus("Nothing selected.", "err");
  const selectedFileCount = selected.challenges.reduce((n, c) => n + ((c.selected_files || []).length), 0);

  state.busy = true;
  scanBtn.disabled = true;
  exportBtn.disabled = true;
  dryRunBtn.disabled = true;

  try {
    const tab = state.activeTab || (await getActiveTab());
    if (!tab?.id) throw new Error("No active tab.");
    let options = getOptions();
    if (selectedFileCount === 0) {
      options = { ...options, downloadFiles: false };
      showNotice("No attached files selected. Exporting challenge JSON + README files only.", "warn", 9000);
      setStatus("Starting README-only export (no attached files found).");
    }
    if (options.mode === "zip" && options.downloadFiles) {
      const urls = selected.challenges.flatMap((c) => c.selected_files || []);
      if (urls.length) {
        const est = await callInjected(tab.id, buildEstimateFetcher(), { urls, timeoutMs: options.timeoutMs, retryCount: options.retryCount });
        state.lastEstimate = est;
        const known = Number(est?.knownBytes || 0);
        const unknown = Number(est?.unknownCount || 0);
        if (known > ZIP_WARN_LIMIT_BYTES || (unknown > 0 && known > ZIP_WARN_LIMIT_BYTES * 0.75)) {
          const knownMb = (known / (1024 * 1024)).toFixed(2);
          const directRadio = document.querySelector("input[name='exportMode'][value='direct']");
          if (directRadio) directRadio.checked = true;
          options = { ...options, mode: "direct" };
      showNotice(
            `Large export detected (${knownMb} MB known${unknown ? ` + ${unknown} unknown` : ""}). Switched to Direct Download mode automatically for reliability.`,
            "warn",
            16000
          );
          void persistUiState();
        }
      }
    }
    setStatus(`Starting background export for ${selected.challenges.length} challenges...`);
    const res = await chrome.runtime.sendMessage({ type: "startExport", payload: { selected, options, tabId: tab.id } });
    if (!res?.ok) throw new Error(res?.error || "Failed to start background export.");
    await refreshExportState();
    setStatus("Background export started. You can close popup safely.", "ok");
  } catch (e) {
    if (isNoReceiverError(e)) {
      setStatus("Export failed: background worker offline. Reload extension and retry.", "err");
    } else {
      setStatus(`Export failed: ${e.message}`, "err");
    }
  } finally {
    state.busy = false;
    scanBtn.disabled = false;
    syncActionButtons();
    dryRunBtn.disabled = false;
  }
}

async function runScan() {
  if (state.busy) return;
  state.busy = true;
  scanBtn.disabled = true;
  exportBtn.disabled = true;
  setScanOverlay(true, "Scanning challenges...");
  try {
    resetProgressState(true);
    const tab = await getActiveTab();
    if (!tab?.id) throw new Error("No active tab found.");
    state.activeTab = tab;
    const origin = new URL(tab.url).origin;
    const perm = await ensureOriginPermission(origin);
    if (!perm) throw new Error(`Site permission denied for ${origin}. Grant access and retry.`);
    const opts = getOptions();
    setStatus("Scanning CTFd challenges...");
    if (scanOverlayMetaEl) scanOverlayMetaEl.textContent = "Fetching challenge list...";
    const boot = await callInjected(tab.id, buildScanBootstrap(), { retryCount: opts.retryCount, timeoutMs: opts.timeoutMs });
    if (!boot || boot.ok === false) throw new Error(boot?.error || "Failed to bootstrap scan.");
    const list = Array.isArray(boot.list) ? boot.list : [];
    const output = [];
    for (let i = 0; i < list.length; i += 1) {
      const c = list[i];
      const label = (c?.name || `Challenge ${c?.id ?? i + 1}`).toString().slice(0, 60);
      setScanOverlay(true, `Scanning challenges... (${i + 1}/${list.length})`);
      if (scanOverlayMetaEl) scanOverlayMetaEl.textContent = `Fetching: ${label}`;
      const d = await callInjected(tab.id, buildChallengeDetailFetcher(), { id: c.id, includeHintDetails: opts.includeHintDetails, retryCount: opts.retryCount, timeoutMs: opts.timeoutMs });
      if (d?.ok && d.data) {
        output.push({ ...d.data, scan_index: i });
      } else {
        output.push({
          id: c.id,
          name: c.name || "",
          category: c.category || "",
          value: c.value,
          type: c.type || "",
          state: c.state,
          solved: c.solved ?? c.solved_by_me ?? c.is_solved ?? null,
          solved_by_me: c.solved_by_me ?? null,
          is_solved: c.is_solved ?? null,
          attempted: c.attempted ?? null,
          solves: c.solves,
          detail_error: d?.error || "Failed to load details",
          files: [],
          extracted_links: [],
          scan_index: i
        });
      }
    }
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
    const catsInScan = [...new Set(output.map((o) => o.category || "uncategorized"))];
    const category_order = [];
    for (const h of (boot.domCategoryOrder || [])) {
      const m = catsInScan.find((c) => norm(c) === norm(h));
      if (m && !category_order.includes(m)) category_order.push(m);
    }
    for (const c of catsInScan) if (!category_order.includes(c)) category_order.push(c);
    const idOrder = new Map((boot.domOrderIds || []).map((id, i) => [Number(id), i]));
    const nameOrder = new Map((boot.domOrderNames || []).map((n, i) => [norm(n), i]));
    for (const o of output) {
      const idRank = idOrder.has(Number(o.id)) ? idOrder.get(Number(o.id)) : null;
      const nameRank = nameOrder.has(norm(o.name || "")) ? nameOrder.get(norm(o.name || "")) : null;
      o.ui_order = Number.isFinite(idRank) ? idRank : (Number.isFinite(nameRank) ? nameRank : o.scan_index);
    }
    const result = {
      ok: true,
      export_schema_version: "2.0.0",
      origin: boot.origin,
      ctf_name: boot.ctf_name,
      exported_at: new Date().toISOString(),
      challenge_count: output.length,
      category_order,
      challenges: output
    };
    state.scan = result;
    state.lastEstimate = null;
    initSelection(result);
    populateCategoryFilter();
    renderPreview();
    setStatus(`Scan complete: ${result.challenges.length} challenges found.`, "ok");
  } catch (e) {
    setStatus(`Scan failed: ${e.message}`, "err");
  } finally {
    setScanOverlay(false);
    scanBtn.disabled = false;
    state.busy = false;
    syncActionButtons();
  }
}

async function dryRunSize() {
  if (state.busy || !state.scan) return setStatus("Scan first before estimate.", "err");
  state.busy = true;
  dryRunBtn.disabled = true;
  try {
    const tab = state.activeTab || (await getActiveTab());
    if (!tab?.id) throw new Error("No active tab.");
    const payload = selectedPayload();
    const urls = payload.challenges.flatMap((c) => c.selected_files || []);
    if (!urls.length) throw new Error("No selected files for size estimate.");
    const opts = getOptions();
    setStatus(`Estimating size for ${urls.length} files...`);
    const est = await callInjected(tab.id, buildEstimateFetcher(), { urls, timeoutMs: opts.timeoutMs, retryCount: opts.retryCount });
    state.lastEstimate = est;
    updateSummary();
    setStatus(`Estimate: ${(est.knownBytes / (1024 * 1024)).toFixed(2)} MB known, ${est.unknownCount} unknown.`, "ok");
  } catch (e) {
    setStatus(`Estimate failed: ${e.message}`, "err");
  } finally {
    dryRunBtn.disabled = false;
    state.busy = false;
  }
}

function applySelectAll(flag) {
  if (!state.scan) return;
  const filtered = filteredChallenges();
  for (const ch of filtered) {
    const key = String(ch.id);
    if (flag) state.selectedChallenges.add(key); else state.selectedChallenges.delete(key);
    state.selectedFilesByChallenge.set(key, new Set(flag ? fileCandidates(state.scan.origin, ch) : []));
  }
  logLine(`${flag ? "Selected" : "Cleared"} ${filtered.length} challenges from current filter.`, "INF");
  renderPreview();
  void persistUiState();
}

function bindFilterEvents() {
  for (const el of [filterCategoryEl, filterSolvedEl]) {
    if (!el) continue;
    el.addEventListener("input", renderPreview);
    el.addEventListener("change", renderPreview);
  }
}

async function init() {
  lockBranding();
  bindFilterEvents();
  const tab = await getActiveTab();
  state.activeTab = tab || null;
  if (!tab?.url) {
    siteEl.textContent = "No active tab detected.";
    scanBtn.disabled = true;
    exportBtn.disabled = true;
    dryRunBtn.disabled = true;
    return;
  }
  try {
    siteEl.textContent = `Current site: ${new URL(tab.url).origin}`;
  } catch {
    siteEl.textContent = "Current tab URL is invalid.";
    scanBtn.disabled = true;
    exportBtn.disabled = true;
    dryRunBtn.disabled = true;
  }
  await restoreUiState();
  await refreshExportState();
  if (filterCategoryEl && !filterCategoryEl.options.length) filterCategoryEl.innerHTML = '<option value="all">All categories</option>';
  if (!state.scan) renderPreview();
  syncActionButtons();
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "exportProgress" && msg.state) syncProgressFromBackground(msg.state);
  });
  setInterval(() => { void refreshExportState(); }, 1500);
}

scanBtn.addEventListener("click", runScan);
exportBtn.addEventListener("click", exportSelected);
dryRunBtn.addEventListener("click", dryRunSize);
selectAllBtn.addEventListener("click", () => applySelectAll(true));
selectNoneBtn.addEventListener("click", () => applySelectAll(false));
downloadFilesEl.addEventListener("change", renderPreview);
includeHintDetailsEl.addEventListener("change", () => void persistUiState());
skipKnownEl.addEventListener("change", () => void persistUiState());
document.querySelectorAll("input[name='exportMode']").forEach((r) => r.addEventListener("change", () => void persistUiState()));
if (resultCloseBtn) resultCloseBtn.addEventListener("click", hideResultOverlay);

init();
