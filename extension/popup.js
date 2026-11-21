// Worker popup: on/off switch, current job, log, and "look up this page" (adds a job and opens the web page).
const BACKEND_URL = "http://127.0.0.1:8765";   // keep in sync with background.js and manifest.json
const $ = (id) => document.getElementById(id);
const isHttp = (u) => typeof u === "string" && /^https?:\/\//i.test(u);

async function render() {
  const { workerId, enabled, workerState = {}, logLines = [] } =
    await chrome.storage.local.get(["workerId", "enabled", "workerState", "logLines"]);
  const on = enabled !== false;
  $("enabled").checked = on;
  $("enabled-text").textContent = on ? "Đang bật" : "Đang tắt";
  $("worker-id").textContent = workerId || "(chưa có)";
  $("state").textContent = !on ? "Tắt: không nhận việc"
    : workerState.status === "busy" ? `Đang tra ${workerState.jobUrl || ""}`
    : "Rảnh, chờ việc";
  $("backend-error").hidden = !workerState.backendError;
  $("backend-error").textContent = workerState.backendError
    ? `Không kết nối được backend ${BACKEND_URL}: ${workerState.backendError}. Chạy  py -3.13 app.py  trong thư mục backend`
    : "";
  $("log").replaceChildren(...logLines.slice(0, 12).map((line) => {
    const li = document.createElement("li");
    li.textContent = line;
    return li;
  }));
}

async function lookupCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const response = await fetch(`${BACKEND_URL}/api/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: tab.url, title: tab.title || null }),
    });
    const job = await response.json();
    if (!response.ok) throw new Error(job.detail || `HTTP ${response.status}`);
    chrome.runtime.sendMessage({ type: "pollNow" }).catch(() => {});
    await chrome.tabs.create({ url: `${BACKEND_URL}/?job=${encodeURIComponent(job.id)}` });
    window.close();
  } catch (err) {
    $("backend-error").hidden = false;
    $("backend-error").textContent = `Không tạo được việc: ${err.message}`;
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const usable = tab?.url && isHttp(tab.url) && !tab.url.startsWith(BACKEND_URL) && !tab.url.startsWith("https://chatgpt.com");
  $("lookup").disabled = !usable;
  $("lookup").title = usable ? tab.url : "Chỉ tra được trang http/https";
  $("lookup").addEventListener("click", lookupCurrentTab);
  $("open").addEventListener("click", (event) => {
    event.preventDefault();
    chrome.tabs.create({ url: `${BACKEND_URL}/` });
  });
  $("enabled").addEventListener("change", async () => {
    await chrome.storage.local.set({ enabled: $("enabled").checked });
    chrome.runtime.sendMessage({ type: "pollNow" }).catch(() => {});
  });
  chrome.storage.onChanged.addListener(render);
  render();
});
