// Brand Search page: adds a lookup job, follows it until a worker extension has asked ChatGPT,
// and shows the result. Talks only to the backend (same origin).
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isHttp = (u) => typeof u === "string" && /^https?:\/\//i.test(u);
const ACTIVE = ["pending", "running"];
const STATUS = { pending: "Chờ worker", running: "Đang hỏi ChatGPT", done: "Xong", error: "Lỗi", cancelled: "Đã hủy" };
let followed = null;       // id of the job shown at the top
let onlineWorkers = 0;

// The API key (when the backend sets BRAND_API_KEY) is kept in this browser only.
const KEY_STORAGE = "brandSearchApiKey";
function apiKey() {
  try { return localStorage.getItem(KEY_STORAGE) || ""; } catch { return ""; }
}

async function api(method, path, body) {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (apiKey()) headers["X-API-Key"] = apiKey();
  const response = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = Array.isArray(data.detail) ? data.detail.map((d) => d.msg).join("; ") : data.detail;
    if (response.status === 401 || response.status === 403) showAuth(detail || `HTTP ${response.status}`);
    throw new Error(detail || `HTTP ${response.status}`);
  }
  return data;
}

function showAuth(message) {
  $("auth").hidden = false;
  $("auth-message").textContent = message;
}

$("auth").addEventListener("submit", (event) => {
  event.preventDefault();
  try { localStorage.setItem(KEY_STORAGE, $("key").value.trim()); } catch { /* private mode */ }
  $("key").value = "";
  $("auth").hidden = true;
  refreshWorkers();
  refreshHistory();
});

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "text") node.textContent = value;        // never innerHTML: values come from the web
    else if (key === "class") node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) if (child) node.append(child);
  return node;
}

const time = (t) => new Date(t * 1000).toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });

// ---------------------------------------------------------------- workers
async function refreshWorkers() {
  try {
    const workers = await api("GET", "/api/workers");
    const online = workers.filter((w) => w.online && w.status !== "off");
    onlineWorkers = online.length;
    const pill = $("workers");
    pill.className = "pill " + (online.length ? "good" : "bad");
    pill.textContent = online.length
      ? `${online.length} worker online${online.some((w) => w.status === "busy") ? " · đang chạy" : ""}`
      : "Chưa có worker online";
    pill.title = online.length ? online.map((w) => `${w.id} (${w.status})`).join("\n")
      : "Mở Chrome có cài extension Brand Search Worker, đăng nhập ChatGPT, bật worker trong popup.";
  } catch (err) {
    $("workers").className = "pill bad";
    $("workers").textContent = /API key|chính máy chủ/.test(err.message) ? "Cần API key" : "Mất kết nối backend";
  }
}

// ---------------------------------------------------------------- one job
function showJob(job) {
  $("job").hidden = false;
  $("job-url").textContent = job.url;
  $("cancel").hidden = !ACTIVE.includes(job.status);
  $("error").hidden = job.status !== "error";
  $("error").textContent = job.error || "";
  $("answer").hidden = !(job.status === "error" && job.answer);
  $("answer-text").textContent = job.answer || "";

  let progress = "";
  if (job.status === "pending") {
    const seconds = Math.round(Date.now() / 1000 - job.created_at);
    progress = `Đang chờ worker nhận việc${job.queue_position > 1 ? ` (thứ ${job.queue_position} trong hàng đợi)` : ""}… ${seconds} s`;
    if (!onlineWorkers) progress += " — chưa có worker nào online";
  } else if (job.status === "running") {
    const seconds = Math.round(Date.now() / 1000 - job.claimed_at);
    progress = `${job.worker_id} đang hỏi ChatGPT… ${seconds} s`;
  } else if (job.status === "cancelled") {
    progress = "";
    $("error").hidden = false;
    $("error").textContent = "Đã hủy.";
  }
  $("progress").hidden = !progress;
  $("progress-text").textContent = progress;

  if (job.status === "done" && job.result) render(job.result);
  else { $("result").hidden = true; $("raw").hidden = true; }
}

async function follow(jobId) {
  followed = jobId;
  history.replaceState(null, "", `?job=${encodeURIComponent(jobId)}`);
  for (;;) {
    let job;
    try {
      job = await api("GET", `/api/jobs/${encodeURIComponent(jobId)}`);
    } catch (err) {
      $("job").hidden = false;
      $("error").hidden = false;
      $("error").textContent = err.message;
      return;
    }
    if (followed !== jobId) return;                   // the user opened another job meanwhile
    showJob(job);
    if (!ACTIVE.includes(job.status)) {
      refreshHistory();
      return;
    }
    await sleep(1500);
  }
}

async function submit(rawUrl) {
  const url = rawUrl.trim();
  if (!url) return;
  $("go").disabled = true;
  try {
    const job = await api("POST", "/api/jobs", { url });
    refreshHistory();
    follow(job.id);
  } catch (err) {
    $("job").hidden = false;
    $("job-url").textContent = url;
    $("progress").hidden = true;
    $("error").hidden = false;
    $("error").textContent = err.message;
  } finally {
    $("go").disabled = false;
  }
}

// ---------------------------------------------------------------- result card
function domainBadge(r) {
  if (r.domain_in_official_list) return el("span", { class: "badge good", text: "✓ Domain chính thức" });
  if (r.is_official_site === false) return el("span", { class: "badge bad", text: "⚠ Không phải domain chính thức" });
  if (r.is_official_site === true) return el("span", { class: "badge", text: "ChatGPT cho là chính thức (chưa có trong danh sách domain)" });
  return el("span", { class: "badge", text: "Chưa rõ domain" });
}

const row = (title, content) => (content ? el("div", { class: "row" }, [el("h2", { text: title }), content]) : null);
const chips = (items) => (items?.length ? el("div", { class: "chips" }, items.map((t) => el("span", { class: "chip", text: t }))) : null);

function render(r) {
  const box = $("result");
  box.replaceChildren();
  const logos = el("div", { class: "logos" });
  for (const logo of r.logos || []) {
    const src = logo.data_uri || (isHttp(logo.final_url) ? logo.final_url : null);
    if (!src) continue;
    const img = el("img", { src, alt: "logo" });
    const origin = logo.source === "chatgpt" ? "ChatGPT" : "Lấy từ trang";
    const tile = el("a", { href: logo.url, target: "_blank", rel: "noreferrer",
                           title: `${origin}${logo.verified ? "" : " (server chưa kiểm tra được)"} · ${logo.url}` },
                    [img, el("span", { text: origin })]);
    img.addEventListener("error", () => tile.remove());   // unverified link that is not a real image
    logos.append(tile);
  }
  box.append(
    logos.childElementCount ? logos : el("p", { class: "muted", text: "Không có logo." }),
    el("p", { class: "brand", text: r.brand_name || "Không nhận ra brand" }),
    r.organization && r.organization !== r.brand_name ? el("p", { class: "org", text: r.organization }) : "",
    el("div", { class: "badges" }, [
      domainBadge(r),
      el("span", { class: "badge" + (r.confidence === "HIGH" ? " good" : ""), text: `Tin cậy: ${r.confidence}` }),
      el("span", { class: "badge", text: r.registered_domain }),
    ]),
    r.description ? el("p", { text: r.description }) : "",
  );
  const sources = (r.sources || []).filter(isHttp).slice(0, 8);
  for (const part of [
    row("Alias", chips(r.aliases)),
    row("Domain chính thức", chips(r.official_domains)),
    row("Căn cứ", r.reasoning ? el("p", { text: r.reasoning }) : null),
    row("Nguồn", sources.length ? el("ul", {}, sources.map((s) =>
      el("li", {}, [el("a", { href: s, target: "_blank", rel: "noreferrer", text: s })]))) : null),
  ]) if (part) box.append(part);
  const page = r.page?.fetched ? "đọc được trang" : `không đọc được trang${r.page?.error ? ` (${r.page.error})` : ""}`;
  box.append(el("p", { class: "footer", text: `${r.input_url} · ${page}` }));
  box.hidden = false;
  $("raw-json").textContent = JSON.stringify(r, (k, v) => (k === "data_uri" && v ? v.slice(0, 60) + "…" : v), 2);
  $("raw").hidden = false;
}

// ---------------------------------------------------------------- history
async function refreshHistory() {
  try {
    const jobs = await api("GET", "/api/jobs?limit=20");
    $("history").replaceChildren(...jobs.map((job) => {
      const tr = el("tr", { class: job.id === followed ? "selected" : "" }, [
        el("td", { text: time(job.created_at) }),
        el("td", { class: "url", text: job.url }),
        el("td", { text: job.brand_name || (job.status === "done" ? "—" : "") }),
        el("td", {}, [el("span", { class: `status ${job.status}`, text: STATUS[job.status] || job.status })]),
      ]);
      tr.addEventListener("click", () => follow(job.id));
      return tr;
    }));
    if (!jobs.length) $("history").replaceChildren(el("tr", {}, [el("td", { colspan: "4", class: "muted", text: "Chưa có lần tra nào." })]));
  } catch { /* backend down: the worker pill says so */ }
}

// ---------------------------------------------------------------- start
$("form").addEventListener("submit", (event) => {
  event.preventDefault();
  submit($("url").value);
});
$("cancel").addEventListener("click", async () => {
  if (followed) await api("POST", `/api/jobs/${encodeURIComponent(followed)}/cancel`).catch(() => {});
});

refreshWorkers();
refreshHistory();
setInterval(refreshWorkers, 10000);
setInterval(refreshHistory, 15000);
const params = new URLSearchParams(location.search);
if (params.get("job")) follow(params.get("job"));
else if (params.get("url")) { $("url").value = params.get("url"); submit(params.get("url")); }
