// Worker popup: on/off switch, backend connection (URL + API key), current job, log,
// and "look up this page" (adds a job and opens the web page).
const DEFAULT_BACKEND_URL = "http://127.0.0.1:8765";   // same default as background.js
const $ = (id) => document.getElementById(id);
const isHttp = (u) => typeof u === "string" && /^https?:\/\//i.test(u);

async function connection() {
  const { backendUrl, apiKey } = await chrome.storage.local.get(["backendUrl", "apiKey"]);
  return { backendUrl: (backendUrl || DEFAULT_BACKEND_URL).replace(/\/+$/, ""), apiKey: apiKey || "" };
}

async function callBackend(method, path, body) {
  const { backendUrl, apiKey } = await connection();
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (apiKey) headers["X-API-Key"] = apiKey;
  let response;
  try {
    response = await fetch(backendUrl + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error(`Không kết nối được ${backendUrl}`);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail ? String(data.detail) : `HTTP ${response.status}`);
  return data;
}

async function render() {
  const { workerId, enabled, workerState = {}, logLines = [] } =
    await chrome.storage.local.get(["workerId", "enabled", "workerState", "logLines"]);
  const { backendUrl, apiKey } = await connection();
  const on = enabled !== false;
  $("enabled").checked = on;
  $("enabled-text").textContent = on ? "Đang bật" : "Đang tắt";
  $("worker-id").textContent = workerId || "(chưa có)";
  $("backend").textContent = `${backendUrl}${apiKey ? " · có key" : ""}`;
  $("state").textContent = !on ? "Tắt: không nhận việc"
    : workerState.status === "busy" ? `Đang tra ${workerState.jobUrl || ""}`
    : "Rảnh, chờ việc";
  $("backend-error").hidden = !workerState.backendError;
  $("backend-error").textContent = workerState.backendError
    ? `Lỗi backend: ${workerState.backendError}. Kiểm tra backend đang chạy, URL và API key ở mục "Kết nối backend".`
    : "";
  $("log").replaceChildren(...logLines.slice(0, 12).map((line) => {
    const li = document.createElement("li");
    li.textContent = line;
    return li;
  }));
}

async function saveConnection(event) {
  event.preventDefault();
  const url = $("backend-url").value.trim().replace(/\/+$/, "") || DEFAULT_BACKEND_URL;
  if (!isHttp(url)) {
    $("connection-result").textContent = "URL phải bắt đầu bằng http:// hoặc https://";
    return;
  }
  await chrome.storage.local.set({ backendUrl: url, apiKey: $("api-key").value.trim() });
  $("api-key").value = "";
  try {
    const workers = await callBackend("GET", "/api/workers");
    $("connection-result").textContent = `Kết nối được. Backend có ${workers.filter((w) => w.online).length} worker online.`;
    chrome.runtime.sendMessage({ type: "pollNow" }).catch(() => {});
  } catch (err) {
    $("connection-result").textContent = `Chưa kết nối được: ${err.message}`;
  }
  render();
}

async function lookupCurrentTab(tab) {
  try {
    const job = await callBackend("POST", "/api/jobs", { url: tab.url, title: tab.title || null });
    chrome.runtime.sendMessage({ type: "pollNow" }).catch(() => {});
    const { backendUrl } = await connection();
    await chrome.tabs.create({ url: `${backendUrl}/?job=${encodeURIComponent(job.id)}` });
    window.close();
  } catch (err) {
    $("backend-error").hidden = false;
    $("backend-error").textContent = `Không tạo được việc: ${err.message}`;
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const { backendUrl } = await connection();
  $("backend-url").value = backendUrl;
  const usable = tab?.url && isHttp(tab.url) && !tab.url.startsWith(backendUrl) && !tab.url.startsWith("https://chatgpt.com");
  $("lookup").disabled = !usable;
  $("lookup").title = usable ? tab.url : "Chỉ tra được trang http/https";
  $("lookup").addEventListener("click", () => lookupCurrentTab(tab));
  $("open").addEventListener("click", async (event) => {
    event.preventDefault();
    chrome.tabs.create({ url: `${(await connection()).backendUrl}/` });
  });
  $("enabled").addEventListener("change", async () => {
    await chrome.storage.local.set({ enabled: $("enabled").checked });
    chrome.runtime.sendMessage({ type: "pollNow" }).catch(() => {});
  });
  $("connection-form").addEventListener("submit", saveConnection);
  chrome.storage.onChanged.addListener(render);
  render();
});
