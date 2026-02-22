const JOB_KEY = "exportJobState";
const ZIP_WARN_LIMIT_BYTES = 100 * 1024 * 1024;
const ZIP_TOO_MANY_FILES = 350;

let currentJob = null;
const liveDownloads = new Map();

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

function cleanExtractedUrl(raw) {
  if (!raw) return "";
  let u = String(raw).trim();
  while (/[)\],.;!?]+$/.test(u)) u = u.slice(0, -1);
  return u;
}

function isZipFetchable(url, origin) {
  try {
    const u = new URL(url, origin);
    return /^https?:$/i.test(u.protocol) && u.origin === origin;
  } catch {
    return false;
  }
}

function displayFileName(url) {
  return (url || "").split("?")[0].split("#")[0].split("/").pop() || "file";
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function estimateKnownBytes(urls, timeoutMs, retryCount) {
  const out = { knownBytes: 0, unknownCount: 0 };
  for (const url of urls) {
    let len = null;
    for (let i = 0; i <= retryCount; i += 1) {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), Math.min(timeoutMs, 20000));
      try {
        let res = await fetch(url, { method: "HEAD", credentials: "include", signal: ctl.signal });
        clearTimeout(t);
        if (!res.ok) {
          res = await fetch(url, { method: "GET", credentials: "include", signal: ctl.signal });
        }
        const parsed = Number(res.headers.get("content-length") || "0");
        len = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
        break;
      } catch {
        clearTimeout(t);
        if (i >= retryCount) len = null;
      }
    }
    if (len == null) out.unknownCount += 1; else out.knownBytes += len;
    if (out.knownBytes > ZIP_WARN_LIMIT_BYTES) break;
  }
  return out;
}

async function setJobState(patch) {
  if (!currentJob) return;
  currentJob.state = { ...currentJob.state, ...patch, updatedAt: Date.now() };
  try {
    await chrome.storage.local.set({ [JOB_KEY]: currentJob.state });
  } catch {}
  try { await chrome.runtime.sendMessage({ type: "exportProgress", state: currentJob.state }); } catch {}
}

async function failJob(message) {
  if (!currentJob) return;
  const ctx = currentJob.state?.currentChallenge ? ` at ${currentJob.state.currentChallenge}${currentJob.state.currentLabel ? ` > ${currentJob.state.currentLabel}` : ""}` : "";
  await setJobState({ running: false, phase: "error", message: `${message}${ctx}` });
  currentJob = null;
}

async function finishJob(summary) {
  if (!currentJob) return;
  await setJobState({ running: false, phase: "done", summary, message: "Export completed" });
  currentJob = null;
}

async function getKnownRegistry() { return (await chrome.storage.local.get(["knownFiles"]))?.knownFiles || {}; }
async function setKnownRegistry(reg) { await chrome.storage.local.set({ knownFiles: reg }); }

async function callInjected(tabId, func, args) {
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func, args: [args] });
  return result;
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

async function fetchExternalForZip(url, timeoutMs, retryCount) {
  for (let i = 0; i <= retryCount; i += 1) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method: "GET", signal: ctl.signal });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ab = await res.arrayBuffer();
      const bytes = new Uint8Array(ab);
      return { ok: true, bytes, sha256: await sha256Hex(ab) };
    } catch (e) {
      clearTimeout(t);
      if (i >= retryCount) return { ok: false, error: e?.message || "external_fetch_failed" };
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

function bytesToBase64(bytes) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.slice(i, i + chunk));
  }
  return btoa(bin);
}

async function toDataUrl(content, mime) {
  if (typeof content === "string") {
    return `data:${mime};charset=utf-8,${encodeURIComponent(content)}`;
  }
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const ab = await blob.arrayBuffer();
  const b64 = bytesToBase64(new Uint8Array(ab));
  return `data:${mime};base64,${b64}`;
}

async function downloadBlob(content, filename, mime = "application/json") {
  const url = await toDataUrl(content, mime);
  await chrome.downloads.download({ url, filename, saveAs: false, conflictAction: "overwrite" });
}

async function downloadBlobSafe(content, filename, mime, fallback) {
  try { await downloadBlob(content, filename, mime); } catch { await downloadBlob(content, fallback, mime); }
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
  return lines.join("\n");
}

async function waitDownloadCompletion(id, timeoutMs) {
  return new Promise((resolve) => {
    const startAt = Date.now();
    let prevAt = startAt;
    let prevBytes = 0;
    let lastEmit = 0;
    let settled = false;
    let pollTimer = null;
    const clearAll = () => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      chrome.downloads.onChanged.removeListener(listener);
      clearTimeout(timer);
    };
    const emitFromBytes = (got, total) => {
      const now = Date.now();
      const dt = Math.max(200, now - prevAt);
      const db = Math.max(0, got - prevBytes);
      const rec = liveDownloads.get(id);
      if (!rec) return;
      if (total > 0) rec.total = total;
      rec.currentBytes = got;

      let speedBps = 0;
      if (db > 0) {
        const raw = (db * 1000) / dt;
        rec.smoothedSpeedBps = rec.smoothedSpeedBps > 0
          ? (rec.smoothedSpeedBps * 0.65) + (raw * 0.35)
          : raw;
        rec.lastNonZeroAt = now;
        speedBps = rec.smoothedSpeedBps;
        prevAt = now;
        prevBytes = got;
      } else {
        const since = now - (rec.lastNonZeroAt || 0);
        speedBps = since < 1500 ? (rec.smoothedSpeedBps || 0) : 0;
      }

      const pct = total > 0 ? Math.max(1, Math.min(99, Math.floor((got * 100) / total))) : 0;
      if (now - lastEmit >= 250) {
        lastEmit = now;
        void setJobState({
          currentPct: pct,
          currentSpeedBps: Math.max(0, speedBps),
          currentBytes: got,
          currentTotalBytes: total || 0
        });
      }
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearAll();
      resolve({ ok: false, error: "timeout" });
    }, Math.max(20000, timeoutMs * 4));
    pollTimer = setInterval(() => {
      chrome.downloads.search({ id }, (items) => {
        if (settled) return;
        const item = Array.isArray(items) && items.length ? items[0] : null;
        if (!item) return;
        const got = Number(item.bytesReceived || 0);
        const total = Number(item.totalBytes || 0);
        if (got > 0 || total > 0) emitFromBytes(got, total);
      });
    }, 250);
    const listener = (delta) => {
      if (delta.id !== id) return;
      const rec = liveDownloads.get(id);
      if (rec) {
        if (delta.totalBytes?.current != null) rec.total = delta.totalBytes.current;
        if (delta.bytesReceived?.current != null) {
          const got = Number(delta.bytesReceived.current || 0);
          const total = Number(rec.total || 0);
          emitFromBytes(got, total);
        }
      }
      if (delta.state?.current === "complete") {
        if (settled) return;
        settled = true;
        clearAll();
        const end = liveDownloads.get(id);
        liveDownloads.delete(id);
        if (end) {
          void setJobState({
            currentPct: 100,
            currentSpeedBps: 0,
            currentBytes: end.total || end.currentBytes || 0,
            currentTotalBytes: end.total || 0
          });
        }
        resolve({ ok: true });
      } else if (delta.state?.current === "interrupted") {
        if (settled) return;
        settled = true;
        clearAll();
        liveDownloads.delete(id);
        resolve({ ok: false, error: delta.error?.current || "interrupted" });
      }
    };
    chrome.downloads.onChanged.addListener(listener);
  });
}

async function downloadWithRetry(url, filename, retryCount, timeoutMs) {
  const label = displayFileName(url);
  for (let i = 0; i <= retryCount; i += 1) {
    try {
      await setJobState({
        currentLabel: `${label} (try ${i + 1}/${retryCount + 1})`,
        currentPct: 0,
        currentSpeedBps: 0,
        currentBytes: 0,
        currentTotalBytes: 0
      });
      const id = await chrome.downloads.download({ url, filename, saveAs: false, conflictAction: "uniquify" });
      if (typeof id !== "number") return { ok: false, error: "download_api_no_id" };
      liveDownloads.set(id, {
        total: 0,
        currentBytes: 0,
        lastSpeedBps: 0,
        smoothedSpeedBps: 0,
        lastNonZeroAt: 0
      });
      const res = await waitDownloadCompletion(id, timeoutMs);
      if (res.ok) return { ok: true };
      if (i >= retryCount) return { ok: false, error: res.error || "download_failed" };
      await delay(350);
    } catch (e) {
      if (i >= retryCount) return { ok: false, error: e?.message || "download_failed" };
      await delay(350);
    }
  }
  return { ok: false, error: "download_failed" };
}

async function fetchFileMetaFromPage(tabId, url, options, includeBytes) {
  return callInjected(tabId, buildFileFetcher(), { url, timeoutMs: options.timeoutMs, retryCount: options.retryCount, includeBytes, computeHash: true });
}

async function runExportJob({ selected, options, tabId }) {
  const root = safePathPart(selected.ctf_name || "ctfd_export", "ctfd_export", 70);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const reg = await getKnownRegistry();
  let files = 0, skipped = 0, failed = 0, attempted = 0;
  const details = [];
  let effectiveMode = options.mode;

  await setJobState({
    running: true,
    phase: "running",
    message: "Export started",
    totalChallenges: selected.challenges.length,
    doneChallenges: 0,
    currentChallenge: "",
    currentLabel: "",
    currentPct: 0,
    currentSpeedBps: 0,
    currentBytes: 0,
    currentTotalBytes: 0,
    details
  });

  if (effectiveMode === "zip" && options.downloadFiles) {
    const selectedUrls = selected.challenges.flatMap((c) => (c.selected_files || []).map(cleanExtractedUrl).filter(Boolean));
    if (selectedUrls.length > ZIP_TOO_MANY_FILES) {
      effectiveMode = "direct";
      await setJobState({ message: `ZIP mode auto-switched to Direct files (${selectedUrls.length} files selected).` });
    } else if (selectedUrls.length) {
      const est = await estimateKnownBytes(selectedUrls, options.timeoutMs, options.retryCount);
      if (est.knownBytes > ZIP_WARN_LIMIT_BYTES || (est.unknownCount > 0 && est.knownBytes > ZIP_WARN_LIMIT_BYTES * 0.75)) {
        effectiveMode = "direct";
        const knownMb = (est.knownBytes / (1024 * 1024)).toFixed(2);
        await setJobState({
          message: `ZIP mode auto-switched to Direct files (${knownMb} MB known${est.unknownCount ? ` + ${est.unknownCount} unknown` : ""}).`
        });
      }
    }
  }

  if (effectiveMode === "zip") {
    const zip = new ZipBuilder();
    zip.addFile(`${root}/challenges_${ts}.json`, new TextEncoder().encode(JSON.stringify(selected, null, 2)));
    for (let idx = 0; idx < selected.challenges.length; idx += 1) {
      const ch = selected.challenges[idx];
      const chTitle = `${ch.id} ${ch.name || "unknown"}`;
      await setJobState({ currentChallenge: chTitle, currentLabel: "", currentPct: 0 });
      const baseDir = `${root}/${safePathPart(ch.category || "uncategorized", "uncategorized", 60)}/${safePathPart(`${ch.id}_${ch.name}`, `challenge_${ch.id || "unknown"}`, 70)}`;
      const checks = {};
      const chSkipped = [];
      const manualChecks = [];
      const chFailed = [];
      for (const rawUrl of ch.selected_files || []) {
        const url = cleanExtractedUrl(rawUrl);
        if (!url) continue;
        attempted += 1;
        const isSameOrigin = isZipFetchable(url, selected.origin);
        if (options.skipKnown && reg[url] && reg[url].from === selected.ctf_name) {
          skipped += 1;
          chSkipped.push(`${displayFileName(url)} (already exported)`);
          continue;
        }
        await setJobState({ currentLabel: displayFileName(url), currentPct: 40 });
        if (isSameOrigin) {
          let meta = await fetchFileMetaFromPage(tabId, url, options, true);
          if ((!meta?.ok || !meta.base64) && options.computeHash) {
            meta = await fetchFileMetaFromPage(tabId, url, { ...options, computeHash: false }, true);
          }
          if (!meta?.ok || !meta.base64) {
            failed += 1;
            chFailed.push({ file: displayFileName(url), reason: meta?.error || "zip_fetch_failed" });
            continue;
          }
          await setJobState({ currentPct: 90 });
          zip.addFile(`${baseDir}/${safePathPart(displayFileName(url), "file", 90)}`, b64ToBytes(meta.base64));
          if (meta.sha256) checks[url] = meta.sha256;
          files += 1;
          reg[url] = { at: Date.now(), from: selected.ctf_name, sha256: meta.sha256 || null };
        } else {
          const ext = await fetchExternalForZip(url, options.timeoutMs, options.retryCount);
          if (!ext.ok || !ext.bytes) {
            skipped += 1;
            chSkipped.push(`${displayFileName(url)} (external fetch failed: ${ext.error || "unknown"})`);
            manualChecks.push(url);
            continue;
          }
          await setJobState({ currentPct: 90 });
          zip.addFile(`${baseDir}/${safePathPart(displayFileName(url), "file", 90)}`, ext.bytes);
          if (ext.sha256) checks[url] = ext.sha256;
          files += 1;
          reg[url] = { at: Date.now(), from: selected.ctf_name, sha256: ext.sha256 || null };
        }
      }
      ch.file_checksums = checks;
      zip.addFile(`${baseDir}/README.md`, new TextEncoder().encode(challengeReadme(ch, ch.selected_files || [], checks, manualChecks)));
      if (chSkipped.length || chFailed.length) details.push({ challenge: chTitle, skipped: chSkipped, failed: chFailed });
      await setJobState({ doneChallenges: idx + 1, details });
    }
    await setKnownRegistry(reg);
    await downloadBlobSafe(new Blob([zip.build()], { type: "application/zip" }), `${root}_${ts}.zip`, "application/zip", `${root}.zip`);
  } else {
    await downloadBlobSafe(JSON.stringify(selected, null, 2), `${root}/challenges_${ts}.json`, "application/json", `${root}/challenges.json`);
    for (let idx = 0; idx < selected.challenges.length; idx += 1) {
      const ch = selected.challenges[idx];
      const chTitle = `${ch.id} ${ch.name || "unknown"}`;
      await setJobState({ currentChallenge: chTitle, currentLabel: "", currentPct: 0 });
      const baseDir = `${root}/${safePathPart(ch.category || "uncategorized", "uncategorized", 60)}/${safePathPart(`${ch.id}_${ch.name}`, `challenge_${ch.id || "unknown"}`, 70)}`;
      const checks = {};
      const chSkipped = [];
      const manualChecks = [];
      const chFailed = [];
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
        } else {
          failed += 1;
          chFailed.push({ file: displayFileName(url), reason: dres.error || "download_failed" });
        }
      }
      ch.file_checksums = checks;
      await downloadBlobSafe(challengeReadme(ch, ch.selected_files || [], checks, manualChecks), `${baseDir}/README.md`, "text/markdown", `${root}/README.md`);
      if (chSkipped.length || chFailed.length) details.push({ challenge: chTitle, skipped: chSkipped, failed: chFailed });
      await setJobState({ doneChallenges: idx + 1, details });
    }
    await setKnownRegistry(reg);
  }

  await finishJob({
    challenges: selected.challenges.length,
    files,
    attempted,
    skipped,
    failed
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "getExportState") {
    chrome.storage.local.get([JOB_KEY]).then((v) => sendResponse({ ok: true, state: v[JOB_KEY] || null })).catch((e) => sendResponse({ ok: false, error: e?.message || "state_error" }));
    return true;
  }
  if (msg?.type === "startExport") {
    if (currentJob?.state?.running) {
      sendResponse({ ok: false, error: "An export is already running." });
      return false;
    }
    currentJob = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      state: {
        running: true,
        phase: "running",
        message: "Export queued",
        totalChallenges: 0,
        doneChallenges: 0,
        currentChallenge: "",
        currentLabel: "",
        currentPct: 0,
        currentSpeedBps: 0,
        currentBytes: 0,
        currentTotalBytes: 0,
        details: [],
        updatedAt: Date.now()
      }
    };
    chrome.storage.local.set({ [JOB_KEY]: currentJob.state }).then(async () => {
      sendResponse({ ok: true, started: true });
      try {
        await runExportJob(msg.payload);
      } catch (e) {
        await failJob(e?.message || "Export crashed");
      }
    }).catch((e) => sendResponse({ ok: false, error: e?.message || "start_failed" }));
    return true;
  }
  return false;
});
