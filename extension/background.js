// Brand Search worker (same pattern as GreenE's vps_ai_worker):
//   poll the backend queue every few seconds -> claim one job -> open a ChatGPT tab with the prompt
//   (web search on) -> inject engine_chatgpt.js -> wait for the answer -> send it back -> close the tab.
// One job at a time, with a pause between jobs. The popup turns the worker on and off.
const DEFAULT_BACKEND_URL = "http://127.0.0.1:8765";   // the popup's "Kết nối backend" overrides it
const CHATGPT_URL = "https://chatgpt.com/";
const POLL_MS = 3000;
const HEARTBEAT_MS = 20000;                         // also keeps the service worker alive
const JOB_TIMEOUT_MS = 4 * 60 * 1000;               // under the backend's 5-minute limit
const PAUSE_BETWEEN_JOBS_MS = 5000;
const OPEN_IN_BACKGROUND = false;                   // true: ChatGPT tab opens without switching to it
const VERSION = chrome.runtime.getManifest().version;

let busy = false;
let polling = false;
let current = null;                                 // { id, url, tabId, cancelled }
let lastJobEndedAt = 0;
let lastBackendError = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function settings() {
  const stored = await chrome.storage.local.get(["workerId", "enabled"]);
  if (!stored.workerId) {
    stored.workerId = "worker-" + crypto.randomUUID().slice(0, 8);
    await chrome.storage.local.set({ workerId: stored.workerId });
  }
  return { workerId: stored.workerId, enabled: stored.enabled !== false };
}

async function log(text) {
  const line = `${new Date().toLocaleTimeString("vi-VN")} ${text}`;
  console.log("[Brand worker]", line);
  const { logLines = [] } = await chrome.storage.local.get("logLines");
  await chrome.storage.local.set({ logLines: [line, ...logLines].slice(0, 30) });
}

async function setState(patch) {
  const { workerState = {} } = await chrome.storage.local.get("workerState");
  await chrome.storage.local.set({ workerState: { ...workerState, ...patch, updatedAt: Date.now() } });
}

// Backend address and API key, set in the popup (a VPS: http://<ip>:8765 + the key from backend\.env).
async function connection() {
  const { backendUrl, apiKey } = await chrome.storage.local.get(["backendUrl", "apiKey"]);
  return { backendUrl: (backendUrl || DEFAULT_BACKEND_URL).replace(/\/+$/, ""), apiKey: apiKey || "" };
}

// fetch with a timeout: a hung request must never block the worker.
async function api(method, path, body, timeoutMs = 60000) {
  const { backendUrl, apiKey } = await connection();
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (apiKey) headers["X-API-Key"] = apiKey;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(backendUrl + path, {
      method, headers, body: body ? JSON.stringify(body) : undefined, signal: controller.signal,
    });
    const data = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.detail ? String(data.detail) : `HTTP ${response.status}`);
    return data;
  } catch (err) {
    if (err.name === "AbortError") throw new Error(`${backendUrl} không trả lời`);
    if (err instanceof TypeError) throw new Error(`Không kết nối được ${backendUrl}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function heartbeat() {
  const { workerId, enabled } = await settings();
  try {
    const reply = await api("POST", "/api/worker/heartbeat", {
      worker_id: workerId, status: !enabled ? "off" : busy ? "busy" : "idle",
      job_id: current?.id ?? null, version: VERSION,
    }, 15000);
    lastBackendError = null;
    if (reply?.cancel_job && current && !current.cancelled) {
      current.cancelled = true;
      await log(`Việc ${current.id} đã bị hủy trên backend`);
    }
  } catch (err) {
    lastBackendError = err.message;
  }
  await setState({ backendError: lastBackendError });
}

async function poll() {
  if (polling || busy) return;
  polling = true;
  try {
    const { workerId, enabled } = await settings();
    if (!enabled || Date.now() - lastJobEndedAt < PAUSE_BETWEEN_JOBS_MS) return;
    const job = await api("GET", `/api/worker/next?worker_id=${encodeURIComponent(workerId)}`, null, 15000);
    lastBackendError = null;
    if (!job) return;
    busy = true;
    processJob(job, workerId).finally(async () => {
      busy = false;
      current = null;
      lastJobEndedAt = Date.now();
      await chrome.storage.local.remove("jobTab");
      await setState({ status: "idle", jobId: null, jobUrl: null });
      heartbeat();
    });
  } catch (err) {
    if (lastBackendError !== err.message) await log(`Không lấy được việc: ${err.message}`);
    lastBackendError = err.message;
    await setState({ backendError: lastBackendError });
  } finally {
    polling = false;
  }
}

async function waitTabLoaded(tabId, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return;
    await sleep(500);
  }
  throw new Error("Trang ChatGPT tải quá lâu");
}

async function runInTab(tabId, func, args = []) {
  const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return injection?.result;
}

async function processJob(job, workerId) {
  current = { id: job.id, url: job.url, tabId: null, cancelled: false };
  await log(`Nhận việc ${job.id}: ${job.url}`);
  await setState({ status: "busy", jobId: job.id, jobUrl: job.url, jobStartedAt: Date.now() });
  heartbeat();
  const deadline = Date.now() + JOB_TIMEOUT_MS;
  try {
    const url = `${CHATGPT_URL}?hints=search&q=${encodeURIComponent(job.prompt)}`;
    const tab = await chrome.tabs.create({ url, active: !OPEN_IN_BACKGROUND });
    current.tabId = tab.id;
    await chrome.storage.local.set({ jobTab: { tabId: tab.id, jobId: job.id } });
    await waitTabLoaded(tab.id, 45000);

    let injections = 0;
    let started = false;
    for (;;) {
      if (current.cancelled) throw new Error("CANCELLED");
      if (Date.now() > deadline) throw new Error("ChatGPT trả lời quá lâu (4 phút)");
      // (Re)inject the engine: a full page reload would have removed it.
      const ready = await runInTab(tab.id, () => !!window.__brandSearchEngine);
      if (!ready) {
        if (++injections > 3) throw new Error("Không chạy được engine trong tab ChatGPT");
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["engine_chatgpt.js"] });
        started = false;
      }
      if (!started) {
        const result = await runInTab(tab.id, (prompt) => window.__brandSearchEngine.start(prompt), [job.prompt]);
        if (!result?.ok) throw new Error(result?.error || "Không gửi được câu hỏi");
        started = true;
        await log(`Đã gửi câu hỏi cho ChatGPT (${job.id})`);
      }
      await sleep(1500);
      const status = await runInTab(tab.id, () => window.__brandSearchEngine ? window.__brandSearchEngine.poll() : { state: "lost" });
      if (status?.state === "done") {
        const reply = await api("POST", `/api/worker/jobs/${job.id}/answer`, { worker_id: workerId, answer: status.text });
        await log(reply.status === "done" ? `Xong ${job.id}: ${reply.brand_name || "không nhận ra brand"}`
                                          : `Câu trả lời của ${job.id} không dùng được: ${reply.error}`);
        return;
      }
      if (status?.state === "error") throw new Error(status.error);
      if (status?.state === "lost") started = false;       // re-inject on the next round
    }
  } catch (err) {
    if (err.message === "CANCELLED") {
      await log(`Bỏ việc ${job.id} (đã hủy)`);
      return;
    }
    const message = /No tab with id|tab was closed/i.test(err.message) ? "Tab ChatGPT đã bị đóng" : err.message;
    await log(`Lỗi ${job.id}: ${message}`);
    await api("POST", `/api/worker/jobs/${job.id}/fail`, { worker_id: workerId, error: message }).catch(() => {});
  } finally {
    if (current?.tabId != null) await chrome.tabs.remove(current.tabId).catch(() => {});
  }
}

// A worker restart in the middle of a job leaves its ChatGPT tab open: close it and report the job.
async function cleanUpAfterRestart() {
  const { jobTab } = await chrome.storage.local.get("jobTab");
  if (!jobTab) return;
  await chrome.tabs.remove(jobTab.tabId).catch(() => {});
  const { workerId } = await settings();
  await api("POST", `/api/worker/jobs/${jobTab.jobId}/fail`,
            { worker_id: workerId, error: "Worker khởi động lại giữa chừng" }).catch(() => {});
  await chrome.storage.local.remove("jobTab");
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || sender.tab) return false;   // popup only
  if (msg?.type === "pollNow") {
    heartbeat().then(poll).then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

// New backend URL or API key saved in the popup: report in right away.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.backendUrl || changes.apiKey)) {
    lastBackendError = null;
    heartbeat().then(poll);
  }
});

chrome.alarms.create("brand-worker", { periodInMinutes: 1 });      // wakes the worker if Chrome stopped it
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === "brand-worker") { heartbeat(); poll(); } });
setInterval(poll, POLL_MS);
setInterval(heartbeat, HEARTBEAT_MS);
cleanUpAfterRestart().finally(() => { setState({ status: "idle" }); heartbeat(); setTimeout(poll, 1500); });
