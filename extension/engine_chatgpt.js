// Injected by the worker (chrome.scripting.executeScript) into the ChatGPT tab it opened for a job.
// Never runs in other ChatGPT tabs. API used by background.js:
//   window.__brandSearchEngine.start(prompt) -> {ok} | {ok:false, error}   make sure the prompt is sent
//   window.__brandSearchEngine.poll()        -> {state: "answering"|"done"|"error"|"idle", text?, error?}
//
// ChatGPT's markup is not a public API and changes: in Nov 2026 messages lost data-message-author-role and
// almost every data-testid, and buttons only carry (localised) aria-labels. So the answer is found by its
// content instead of its markup: the last complete JSON object with "brand_name" on the page that is not
// the empty template inside our own prompt. Errors carry a snapshot of the page to fix selectors from.
(() => {
  if (window.__brandSearchEngine) return;

  const SEL = {
    input: ["#prompt-textarea", "div[contenteditable='true'][tabindex]", "div[contenteditable='true']", "textarea[placeholder]"],
    send: [
      "button[data-testid='send-button']", "#composer-submit-button", "button[aria-label='Send message']",
      "button[aria-label='Send prompt']", "button[aria-label='Send']", "button[aria-label='Gửi lời nhắc']",
      "button[aria-label='Gửi']", "form button[type='submit']",
    ],
    stop: ["button[data-testid='stop-button']", "button[aria-label='Stop generating']", "button[aria-label='Stop streaming']"],
    user: "[data-message-author-role='user']",
    turn: "[data-testid^='conversation-turn'], article[data-turn]",
    code: "pre, code, .cm-content, [class*='cm-content'], [class*='code-block'], [class*='codeblock']",
  };
  const ERRORS = [
    /something went wrong/i, /you['’]ve (hit|reached) (our|the|your)?.{0,40}limit/i, /too many requests/i,
    /network error/i, /đã xảy ra lỗi/i, /đã đạt (đến )?giới hạn/i,
  ];
  const STABLE_MS = 3000;          // complete JSON unchanged this long (and nothing generating) = finished
  const NO_ANSWER_MS = 120000;     // prompt sent but no JSON for this long = failed

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const first = (list) => {
    for (const selector of list) {
      try { const el = document.querySelector(selector); if (el) return el; } catch { /* bad selector */ }
    }
    return null;
  };
  const state = { phase: "idle", last: "", changedAt: 0, sentAt: 0 };

  // A button that stops the answer: by test id, or by an aria-label starting with "Stop"/"Dừng".
  function generating() {
    if (first(SEL.stop)) return true;
    return [...document.querySelectorAll("button[aria-label]")]
      .some((b) => /^(stop|dừng)/i.test((b.getAttribute("aria-label") || "").trim()));
  }

  // Several signs that the prompt went out, since none of them is guaranteed to survive a redesign.
  const sent = () => document.querySelectorAll(SEL.user).length > 0
    || document.querySelectorAll(SEL.turn).length > 0
    || /^\/c\/[\w-]+/.test(location.pathname)
    || generating();

  function snapshot() {
    const box = first(SEL.input);
    const composer = box?.closest("form") || box?.parentElement?.parentElement?.parentElement;
    const buttons = composer ? [...composer.querySelectorAll("button")].map((b) =>
      `${b.getAttribute("data-testid") || ""}|${b.getAttribute("aria-label") || ""}${b.disabled ? "|disabled" : ""}`) : [];
    const testids = [...new Set([...document.querySelectorAll("[data-testid]")].map((e) => e.getAttribute("data-testid")))];
    const roles = [...document.querySelectorAll("[data-message-author-role]")].map((e) => e.getAttribute("data-message-author-role"));
    const codes = [...document.querySelectorAll(SEL.code)].map((e) => `${e.tagName.toLowerCase()}.${(e.className || "").toString().split(" ")[0]}`);
    return [
      `path=${location.pathname}`,
      `input=${box ? `${box.tagName.toLowerCase()}#${box.id || "-"} ${(box.value ?? box.innerText ?? "").length} ký tự` : "không"}`,
      `roles=[${roles.join(",")}]`, `turns=${document.querySelectorAll(SEL.turn).length}`, `generating=${generating()}`,
      `code=[${[...new Set(codes)].slice(0, 8).join(",")}]`,
      `nút ô chat=[${buttons.slice(0, 12).join("; ")}]`, `testids=[${testids.slice(0, 30).join(",")}]`,
    ].join(" · ").slice(0, 1500);
  }

  // Every complete JSON object in the text that has a "brand_name" key, in order of appearance.
  function jsonObjects(text) {
    const found = [];
    for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
      let depth = 0, inString = false, escaped = false;
      for (let i = start; i < text.length; i++) {
        const c = text[i];
        if (inString) {
          if (escaped) escaped = false;
          else if (c === "\\") escaped = true;
          else if (c === '"') inString = false;
        } else if (c === '"') inString = true;
        else if (c === "{") depth++;
        else if (c === "}" && --depth === 0) {
          try {
            const value = JSON.parse(text.slice(start, i + 1));
            if (value && typeof value === "object" && "brand_name" in value) found.push(value);
          } catch { /* not JSON */ }
          break;
        }
      }
    }
    return found;
  }

  // The prompt ends with an empty template ({"brand_name": "", ..., "reasoning": "", "sources": []}).
  const isTemplate = (o) => !o.brand_name && !o.reasoning && !(o.sources || []).length && !(o.aliases || []).length;

  // The answer JSON: code blocks first (the usual place), else anywhere in the conversation.
  function findAnswer() {
    const blocks = [...document.querySelectorAll(SEL.code)].map((n) => n.innerText || n.textContent || "");
    const root = document.querySelector("main") || document.body;
    for (const texts of [blocks, [root.innerText || ""]]) {
      const answers = texts.flatMap(jsonObjects).filter((o) => !isTemplate(o));
      if (answers.length) return answers[answers.length - 1];
    }
    return null;
  }

  function enabledSendButton() {
    for (const selector of SEL.send) {
      const button = document.querySelector(selector);
      if (button && !button.disabled && button.getAttribute("aria-disabled") !== "true") return button;
    }
    return null;
  }

  async function typeInto(box, text) {
    box.focus();
    await sleep(200);
    if (box instanceof HTMLTextAreaElement) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(box, text);
      box.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    document.execCommand("selectAll", false, null);
    document.execCommand("insertText", false, text);     // ChatGPT's editor accepts this like typing
    if (!box.textContent.trim()) {
      box.textContent = text;
      box.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
    }
  }

  async function start(prompt) {
    // Wait for the chat box, or for ?q= to have sent the prompt already.
    const until = Date.now() + 20000;
    while (Date.now() < until && !sent() && !first(SEL.input)) await sleep(500);
    if (!sent()) {
      const box = first(SEL.input);
      if (!box) {
        return { ok: false, error: "Không thấy ô chat ChatGPT: đăng nhập ChatGPT trong hồ sơ Chrome của worker. [" + snapshot() + "]" };
      }
      for (let i = 0; i < 8 && !sent(); i++) await sleep(500);      // ?q= may be about to send it
      if (!sent()) {
        const current = box instanceof HTMLTextAreaElement ? box.value : box.innerText;
        if (current.trim().length < 50) await typeInto(box, prompt);  // empty, or only a placeholder
        await sleep(600);
        for (let attempt = 0; attempt < 3 && !sent(); attempt++) {
          const button = enabledSendButton();
          if (button) button.click();
          else box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
          for (let i = 0; i < 6 && !sent(); i++) await sleep(500);
        }
        if (!sent()) {
          return { ok: false, error: "Không gửi được câu hỏi vào ChatGPT (giao diện có thể đã đổi). [" + snapshot() + "]" };
        }
      }
    }
    Object.assign(state, { phase: "answering", last: "", changedAt: Date.now(), sentAt: Date.now() });
    return { ok: true };
  }

  function poll() {
    if (state.phase !== "answering") return { state: "idle" };
    const answer = findAnswer();
    const text = answer ? JSON.stringify(answer, null, 2) : "";
    if (text !== state.last) {
      state.last = text;
      state.changedAt = Date.now();
    }
    const busy = generating();
    if (answer && !busy && Date.now() - state.changedAt >= STABLE_MS) return { state: "done", text };
    if (!answer && !busy) {
      const tail = ((document.querySelector("main") || document.body).innerText || "").slice(-600);
      const hit = ERRORS.find((pattern) => pattern.test(tail));
      if (hit) return { state: "error", error: "ChatGPT báo lỗi: " + tail.trim().slice(-200) };
    }
    if (!answer && Date.now() - state.sentAt > NO_ANSWER_MS) {
      return { state: "error", error: "Không đọc được câu trả lời của ChatGPT. [" + snapshot() + "]" };
    }
    return { state: "answering", chars: text.length };
  }

  window.__brandSearchEngine = { start, poll };
})();
