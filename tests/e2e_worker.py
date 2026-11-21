"""End-to-end: web page -> backend queue -> worker extension (real code) -> FAKE ChatGPT -> result on the page.

Playwright cannot intercept tabs opened by an extension, so a copy of the worker is made where the only change
is CHATGPT_URL (https://chatgpt.com/ -> http://127.0.0.1:8766/, a local fake ChatGPT).
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
OUT = HERE / '_out'
OUT.mkdir(exist_ok=True)
SRC = ROOT / 'extension'
TEST_EXT = OUT / 'ext_test'
FAKE_BASE = 'http://127.0.0.1:8766/'
TEST_PORT = 8775                      # 8765 is the user's own running backend: leave it alone
BACKEND = f'http://127.0.0.1:{TEST_PORT}'

shutil.rmtree(TEST_EXT, ignore_errors=True)
shutil.copytree(SRC, TEST_EXT)
manifest = json.loads((TEST_EXT / 'manifest.json').read_text(encoding='utf-8'))
manifest['host_permissions'] = [h.replace(':8765', f':{TEST_PORT}') for h in manifest['host_permissions']] + [FAKE_BASE + '*']
(TEST_EXT / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
bg = (TEST_EXT / 'background.js').read_text(encoding='utf-8')
assert bg.count('const CHATGPT_URL = "https://chatgpt.com/";') == 1 and bg.count('"http://127.0.0.1:8765"') == 1
bg = bg.replace('const CHATGPT_URL = "https://chatgpt.com/";', f'const CHATGPT_URL = "{FAKE_BASE}";')
(TEST_EXT / 'background.js').write_text(bg.replace('"http://127.0.0.1:8765"', f'"{BACKEND}"'), encoding='utf-8')
pj = (TEST_EXT / 'popup.js').read_text(encoding='utf-8')
assert pj.count('"http://127.0.0.1:8765"') == 1
(TEST_EXT / 'popup.js').write_text(pj.replace('"http://127.0.0.1:8765"', f'"{BACKEND}"'), encoding='utf-8')

ANSWERS = {
    'vietcombank.com.vn': {"brand_name": "Vietcombank", "organization": "Ngân hàng TMCP Ngoại thương Việt Nam",
                           "aliases": ["VCB", "Joint Stock Commercial Bank for Foreign Trade of Vietnam"],
                           "official_domains": ["vietcombank.com.vn"], "is_official_site": True,
                           "logo_urls": ["https://upload.wikimedia.org/wikipedia/commons/thumb/9/9a/Vietcombank_logo_fixed.svg/512px-Vietcombank_logo_fixed.svg.png"],
                           "description": "Ngân hàng thương mại lớn của Việt Nam.", "confidence": "HIGH",
                           "reasoning": "Wikipedia và website chính thức đều ghi Vietcombank sở hữu vietcombank.com.vn.",
                           "sources": ["https://en.wikipedia.org/wiki/Vietcombank", "https://www.vietcombank.com.vn/"]},
    'paypal.com': {"brand_name": "PayPal", "organization": "PayPal Holdings, Inc.", "aliases": ["PP"],
                   "official_domains": ["paypal.com", "paypal.me"], "is_official_site": True, "logo_urls": [],
                   "description": "Dịch vụ thanh toán trực tuyến.", "confidence": "HIGH", "reasoning": "Trang chính thức.",
                   "sources": ["https://www.paypal.com/"]},
}
FAKE = """<!doctype html><html><head><meta charset="utf-8"></head><body><main id="thread"></main>
<div id="prompt-textarea" contenteditable="true"></div>
<button data-testid="send-button" id="send">Send</button>
<script>
const MODE = "__MODE__";
const ANSWERS = __ANSWERS__;
const box = document.getElementById('prompt-textarea');
if (MODE !== 'empty') box.textContent = new URLSearchParams(location.search).get('q') || '';
function submit() {
  const text = box.innerText;
  if (!text.trim()) return;
  box.textContent = '';
  const u = document.createElement('div'); u.setAttribute('data-message-author-role', 'user'); u.textContent = text; thread.append(u);
  const stop = document.createElement('button'); stop.setAttribute('data-testid', 'stop-button'); stop.textContent = 'Stop'; document.body.append(stop);
  const a = document.createElement('div'); a.setAttribute('data-message-author-role', 'assistant'); a.textContent = 'Searching the web…'; thread.append(a);
  const key = Object.keys(ANSWERS).find((k) => text.includes(k));
  const json = JSON.stringify(ANSWERS[key], null, 2);
  setTimeout(() => {
    a.textContent = 'Kết quả:';
    const pre = document.createElement('pre'); const code = document.createElement('code'); pre.append(code); a.append(pre);
    let i = 0;
    const t = setInterval(() => { i += 60; code.textContent = json.slice(0, i); if (i >= json.length) { clearInterval(t); stop.remove(); } }, 100);
  }, 2500);
}
document.getElementById('send').onclick = submit;
if (MODE === 'auto') setTimeout(submit, 800);
</script></body></html>"""
LOGGED_OUT = '<!doctype html><html><body><h1>Log in to ChatGPT</h1><button>Log in</button></body></html>'
# ChatGPT as seen on the user's machine in Nov 2026: no data-message-author-role, no data-testid, Vietnamese
# aria-labels, URL moves to /c/<id>, the prompt (with its empty JSON template) shown in a bubble, and the
# answer in a CodeMirror-like block streamed line by line.
FAKE_NEW = """<!doctype html><html><head><meta charset="utf-8"></head><body><main><div id="thread"></div>
<form><div class="composer" contenteditable="true" tabindex="0"></div>
<button type="button" aria-label="Thêm tệp và nội dung khác">+</button>
<button type="button" aria-label="Chọn mô hình ChatGPT">Medium</button>
<button type="button" aria-label="Chép lời">mic</button>
<button type="button" aria-label="Gửi" id="send">↑</button></form></main>
<script>
const MODE = "__MODE__";
const ANSWERS = __ANSWERS__;
const box = document.querySelector('.composer');
const send = document.getElementById('send');
const q = new URLSearchParams(location.search).get('q') || '';
if (MODE === 'newui-prefill') box.textContent = q;
function submit(textArg) {
  const text = textArg || box.innerText;
  if (!text.trim()) return;
  box.textContent = '';
  history.pushState({}, '', '/c/6b017673-28c0-83ec-987a-30268a46bdfc');
  const bubble = document.createElement('div'); bubble.className = 'bubble'; bubble.textContent = text; thread.append(bubble);
  send.setAttribute('aria-label', 'Dừng phát trực tuyến');
  const reply = document.createElement('div'); reply.className = 'reply'; reply.textContent = 'Đang tìm kiếm trên mạng…'; thread.append(reply);
  const key = Object.keys(ANSWERS).find((k) => text.includes(k));
  const lines = JSON.stringify(ANSWERS[key], null, 2).split('\\n');
  setTimeout(() => {
    reply.textContent = '';
    const head = document.createElement('div'); head.textContent = '</> JSON'; reply.append(head);
    const cm = document.createElement('div'); cm.className = 'cm-content'; reply.append(cm);
    let i = 0;
    const t = setInterval(() => {
      const line = document.createElement('div'); line.className = 'cm-line'; line.textContent = lines[i++]; cm.append(line);
      if (i >= lines.length) { clearInterval(t); send.setAttribute('aria-label', 'Gửi'); send.disabled = true; }
    }, 120);
  }, 2500);
}
send.onclick = () => { if (send.getAttribute('aria-label') === 'Gửi') submit(); };
if (MODE === 'newui-auto') setTimeout(() => submit(q), 800);
</script></body></html>"""
state = {'mode': 'auto', 'hits': 0}


class FakeChatGPT(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith('/favicon'):
            self.send_response(404); self.end_headers(); return
        state['hits'] += 1
        page = FAKE_NEW if state['mode'].startswith('newui') else FAKE
        body = LOGGED_OUT if state['mode'] == 'logout' else page.replace('__MODE__', state['mode']).replace(
            '__ANSWERS__', json.dumps(ANSWERS, ensure_ascii=False))
        data = body.encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


API_KEY = 'e2e-test-key'     # the backend runs like on a VPS: every /api/* call needs it


def get(path):
    req = urllib.request.Request(BACKEND + path, headers={'X-API-Key': API_KEY})
    return json.loads(urllib.request.urlopen(req, timeout=10).read().decode())


def post(path, body):
    req = urllib.request.Request(BACKEND + path, data=json.dumps(body).encode(),
                                 headers={'Content-Type': 'application/json', 'X-API-Key': API_KEY})
    return json.loads(urllib.request.urlopen(req, timeout=10).read().decode())


fake = ThreadingHTTPServer(('127.0.0.1', 8766), FakeChatGPT)
threading.Thread(target=fake.serve_forever, daemon=True).start()
db_dir = tempfile.mkdtemp()
server = subprocess.Popen([sys.executable, 'app.py'], cwd=str(ROOT / 'backend'),
                          env={**os.environ, 'BRAND_JOBS_DB': os.path.join(db_dir, 'e2e.sqlite3'), 'BRAND_API_PORT': str(TEST_PORT),
                               'BRAND_API_KEY': API_KEY},
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
for _ in range(60):
    try:
        get('/health')
        break
    except OSError:
        time.sleep(0.5)

try:
    with sync_playwright() as p, tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as profile:
        ctx = p.chromium.launch_persistent_context(profile, channel='chromium', headless=True, viewport={'width': 1100, 'height': 900},
                                                   args=[f'--disable-extensions-except={TEST_EXT}', f'--load-extension={TEST_EXT}'])
        worker = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event('serviceworker', timeout=15000)
        ext_id = worker.url.split('/')[2]
        time.sleep(3)
        print('worker chưa có key -> online:', [w['id'] for w in get('/api/workers') if w['online']])
        # what the popup's "Kết nối backend" saves (the URL is already this backend in the test copy)
        worker.evaluate(f"chrome.storage.local.set({{apiKey: '{API_KEY}'}})")
        time.sleep(4)
        print('worker có key -> online:', [(w['id'], w['status']) for w in get('/api/workers') if w['online']])

        page = ctx.new_page()
        page.goto(f'{BACKEND}/')
        page.wait_for_selector('#auth:not([hidden])', timeout=15000)
        print('trang web chưa có key -> hiện ô nhập key:', page.inner_text('#auth-message'), '| pill:', page.inner_text('#workers'))
        page.fill('#key', API_KEY)
        page.click('#auth button')
        page.wait_for_function("document.getElementById('workers').textContent.includes('online')", timeout=15000)
        print('nhập key xong -> pill:', page.inner_text('#workers'), '| ô key ẩn:', page.is_hidden('#auth'))
        for mode, url in [('newui-auto', 'https://www.vietcombank.com.vn/'), ('newui-prefill', 'https://www.paypal.com/'),
                          ('auto', 'https://www.vietcombank.com.vn/?v=old'), ('prefill', 'https://www.paypal.com/?v=old'),
                          ('empty', 'https://www.vietcombank.com.vn/?lang=en'), ('logout', 'https://www.paypal.com/signin')]:
            state['mode'] = mode
            started = time.time()
            page.goto(f'{BACKEND}/')
            page.fill('#url', url)
            page.click('#go')
            page.wait_for_selector('#result:not([hidden]), #error:not([hidden])', timeout=150000)
            took = time.time() - started
            open_chat = [pg for pg in ctx.pages if pg.url.startswith(FAKE_BASE)]
            if page.is_visible('#result'):
                print(f'[{mode:<7}] KẾT QUẢ {took:5.1f}s brand={page.inner_text(".brand")!r} '
                      f'badges=[{page.inner_text(".badges").replace(chr(10), " | ")}] tab ChatGPT còn mở={len(open_chat)}')
            else:
                print(f'[{mode:<7}] LỖI {took:5.1f}s {page.inner_text("#error")!r} tab ChatGPT còn mở={len(open_chat)}')

        # two jobs at once: the worker takes them one after the other
        state['mode'] = 'auto'
        a = post('/api/jobs', {'url': 'https://www.paypal.com/myaccount'})
        b = post('/api/jobs', {'url': 'https://vietcombank.com.vn/en'})
        t0 = time.time()
        while time.time() - t0 < 150:
            ja, jb = get(f"/api/jobs/{a['id']}"), get(f"/api/jobs/{b['id']}")
            if ja['status'] not in ('pending', 'running') and jb['status'] not in ('pending', 'running'):
                break
            time.sleep(1)
        print(f"[hàng đợi] việc 1 {ja['status']} ({(ja['result'] or {}).get('brand_name')}), việc 2 {jb['status']} ({(jb['result'] or {}).get('brand_name')}); "
              f"việc 2 bắt đầu sau khi việc 1 xong: {jb['claimed_at'] >= ja['finished_at']} "
              f"(nghỉ {jb['claimed_at'] - ja['finished_at']:.1f}s), tổng {time.time() - t0:.0f}s")

        # screenshots for the user: a finished lookup + history, and the worker popup
        page.goto(f"{BACKEND}/?job={get('/api/jobs?limit=20')[-1]['id']}")
        page.wait_for_selector('#result:not([hidden])', timeout=30000)
        time.sleep(1.5)
        page.screenshot(path=str(OUT / 'frontend.png'), full_page=True)
        popup = ctx.new_page()
        popup.set_viewport_size({'width': 360, 'height': 560})
        popup.goto(f'chrome-extension://{ext_id}/popup.html')
        time.sleep(1)
        popup.screenshot(path=str(OUT / 'worker_popup.png'))
        print('ảnh chụp:', OUT / 'frontend.png', OUT / 'worker_popup.png')
        ctx.close()
finally:
    server.terminate()
    fake.shutdown()
