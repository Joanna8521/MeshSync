// =====================================================
// Mesh Sync — Content Script v3.0（開源版）
// 兩種擷取方式：
// 1) 圈選文字 → 浮動「存入脈絡」按鈕
// 2) AI 回覆中的 [CONTEXT]/[SYNC] 標記 → 確認卡
// 支援 ChatGPT / Claude / Gemini
// 安全原則：所有頁面資料一律用 textContent 塞進 DOM，不走 innerHTML
// =====================================================

(function () {
  'use strict';

  // 診斷用：頁面上看得到這個屬性，就代表 content script 真的有被注入
  document.documentElement.dataset.meshSync = '3.0.0';

  const host = location.hostname;
  const platform = host.includes('claude.ai') ? 'claude'
    : host.includes('gemini.google.com') ? 'gemini'
      : 'chatgpt';

  let autoDetect = true;
  let contextTurns = 6; // 標記寫入時一併收錄的對話則數（0 = 只收摘要，-1 = 整場全文）
  chrome.storage.sync.get(['autoDetect', 'contextTurns'], (r) => {
    autoDetect = r.autoDetect !== false;
    if (typeof r.contextTurns === 'number') contextTurns = r.contextTurns;
  });
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'sync') return;
    if (ch.autoDetect) autoDetect = ch.autoDetect.newValue !== false;
    if (ch.contextTurns) contextTurns = ch.contextTurns.newValue;
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'MESH_PROGRESS') {
      updateStatusText(`⏳ ${msg.text}`);
      return false;
    }

    // 診斷：讓程式自己交出證據，不用開主控台猜
    if (msg.type === 'MESH_DIAG') {
      const els = assistantEls();
      const blocks = turnBlocks();
      sendResponse({
        platform,
        assistant: els.length,
        turns: blocks.length,
        ai: blocks.filter((b) => !b.isUser).length,
        hasMarker: /\[(CONTEXT|SYNC)\]/.test(readableText(document.body)),
        seen: seen.size,
        autoDetect,
      });
      return false;
    }

    if (msg.type !== 'MESH_CAPTURE_ALL') return false;
    const text = fullTranscript();
    if (!text) {
      sendResponse({ ok: false, error: '這個頁面上找不到對話內容' });
      return false;
    }
    sendCapture(text, 'full');
    sendResponse({ ok: true, chars: text.length });
    return false;
  });

  const USER_MARK = '[data-testid="user-message"], [data-message-author-role="user"], user-query';

  // 回傳每一輪 {el, isUser}。平台改版只認得使用者訊息時（Claude 就發生過，
  // 結果逐字稿整份只有使用者發言），改用「共同容器的子區塊」還原 AI 的回覆。
  function turnBlocks() {
    const cfg = TURNS[platform];
    const els = [...document.querySelectorAll(cfg.selector)];
    const hasAssistant = els.some((el) => !cfg.isUser(el));
    if (els.length && hasAssistant) {
      return els.map((el) => ({ el, isUser: cfg.isUser(el) }));
    }

    const anchors = [...document.querySelectorAll(USER_MARK)];
    if (!anchors.length) return [];
    let container = anchors[0].parentElement;
    while (container && container.parentElement
      && !anchors.every((a) => container.contains(a))) {
      container = container.parentElement;
    }
    if (!container) return [];
    return [...container.children].map((el) => ({
      el,
      isUser: anchors.some((a) => el === a || el.contains(a)),
    }));
  }

  function fullTranscript(lastN) {
    const aiName = { chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini' }[platform];
    let turns = turnBlocks();
    if (lastN > 0) turns = turns.slice(-lastN);

    // 一輪都認不出來時，至少把整頁可讀文字收下來，不要空手而回
    if (!turns.length) {
      if (lastN > 0) return '';
      const main = document.querySelector('main') || document.body;
      return readableText(main).replace(/\n{3,}/g, '\n\n').trim();
    }

    const parts = [];
    for (const { el, isUser } of turns) {
      // 標記區塊是給程式看的，收進逐字紀錄只會佔版面
      const body = readableText(el)
        .replace(BLOCK_STRIP_RE, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      if (!body) continue;
      parts.push(`${isUser ? '👤 我' : `🤖 ${aiName}`}：\n${body}`);
    }
    return parts.join('\n\n');
  }

  // ── 對話資訊 ──────────────────────────────────────

  function convUrl() {
    return location.origin + location.pathname; // 去掉 query/hash
  }

  function convTitle() {
    // 各平台的後綴寫法不同：「- ChatGPT」「– Google Gemini」「\ Claude」…
    return (document.title || '')
      .replace(/\s*[-–—|\\]\s*(Google\s+)?(ChatGPT|Claude|Gemini)\s*$/i, '')
      .replace(/\s*[-–—|\\]\s*(Google\s+)?(ChatGPT|Claude|Gemini)\s*$/i, '')
      .trim();
  }

  // ── 模式一：圈選文字 → 浮動按鈕 ────────────────────

  let selBtn = null;

  function removeSelBtn() {
    if (selBtn) {
      selBtn.remove();
      selBtn = null;
    }
  }

  document.addEventListener('mouseup', (ev) => {
    if (selBtn && selBtn.contains(ev.target)) return;
    setTimeout(() => {
      removeSelBtn();
      const sel = window.getSelection();
      const text = sel ? sel.toString().trim() : '';
      if (text.length < 10 || sel.rangeCount === 0) return;
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      selBtn = document.createElement('button');
      selBtn.type = 'button';
      selBtn.className = 'mesh-capture-btn';
      selBtn.textContent = '⚡ 存入脈絡';
      selBtn.style.top = `${window.scrollY + rect.bottom + 8}px`;
      selBtn.style.left = `${window.scrollX + Math.max(rect.left, 8)}px`;
      selBtn.addEventListener('click', () => {
        const captured = text;
        removeSelBtn();
        sendCapture(captured, 'selection');

      });
      document.body.appendChild(selBtn);
    }, 10);
  });

  document.addEventListener('mousedown', (ev) => {
    if (selBtn && !selBtn.contains(ev.target)) removeSelBtn();
  });

  // ── 模式二：[CONTEXT]/[SYNC] 標記自動偵測 ──────────

  const seen = new Set();
  // 內容中不得再出現開頭標記，否則 AI 在說明文字裡提到「[CONTEXT]」時，
  // 比對會從那個裸標記一路吃到結束標記，把中間的白話文一起收進來。
  const BLOCK_RE = /\[(CONTEXT|SYNC)\]((?:(?!\[(?:CONTEXT|SYNC)\])[\s\S])*?)\[\/\1\]/g;
  // 逐字稿要移除標記區塊，同樣不能貪心地從裸標記一路吃過去
  const BLOCK_STRIP_RE = /\[(CONTEXT|SYNC)\](?:(?!\[(?:CONTEXT|SYNC)\])[\s\S])*?\[\/\1\]/g;

  const SELECTORS = {
    chatgpt: '[data-message-author-role="assistant"] .markdown',
    claude: '[data-testid="assistant-message"], .font-claude-message, [data-testid="message-content"], [data-is-streaming] .prose',
    gemini: 'model-response, .model-response-text, message-content',
  };

  // 整場對話：依畫面順序抓「每一輪」，並判斷這一輪是誰說的
  const TURNS = {
    chatgpt: {
      selector: '[data-message-author-role]',
      isUser: (el) => el.getAttribute('data-message-author-role') === 'user',
    },
    claude: {
      selector: '[data-testid="user-message"], [data-testid="assistant-message"], .font-claude-message',
      isUser: (el) => el.matches('[data-testid="user-message"]'),
    },
    gemini: {
      selector: 'user-query, model-response',
      isUser: (el) => el.tagName.toLowerCase() === 'user-query',
    },
  };

  function assistantEls() {
    const all = [...document.querySelectorAll(SELECTORS[platform])];
    // Gemini 的 model-response 裡面還有 .model-response-text，巢狀命中會讓
    // 同一段標記被掃兩次。只留最外層那一個。
    return all.filter((el) => !all.some((other) => other !== el && other.contains(el)));
  }

  // 後備：平台改版導致 selector 全部落空時，直接掃整頁文字。
  // 必須排除輸入框（contenteditable）與自己的 UI，否則使用者「正在打字」
  // 的 prompt 會被當成 AI 的輸出。
  function readableText(root) {
    const EXCLUDE = '[contenteditable="true"], textarea, input, script, style, .mesh-toast, .mesh-capture-btn';
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p || p.closest(EXCLUDE)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const out = [];
    let n;
    while ((n = walker.nextNode())) out.push(n.nodeValue);
    return out.join('\n');
  }

  // prompt 裡的示範格式會被 AI 複述，別把它當成真的脈絡
  function isTemplate(raw) {
    return raw.includes('一句話總結') || (raw.includes('重點1') && raw.includes('重點2'));
  }

  function hashStr(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
    return h.toString(36);
  }

  let scanTimer = null;
  const observer = new MutationObserver(() => {
    if (!autoDetect) return;
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 1200);
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });

  // 頁面載入時整場對話的歷史標記都會被掃到。只提示「最後一則回覆」裡的，
  // 其餘標記為已看過但不跳卡片，否則重整一次就跳出一整排舊卡。
  let firstScan = true;

  function collectBlocks(text, allowToast) {
    BLOCK_RE.lastIndex = 0;
    let m;
    while ((m = BLOCK_RE.exec(text)) !== null) {
      const raw = m[2].trim();
      if (!raw) continue;
      // 去重的鍵要忽略空白：串流中與完成後的同一段內容，換行與空格常有出入，
      // 照原樣算雜湊會被當成兩筆，於是同一個標記跳兩張卡。
      const key = hashStr(`${convUrl()}|${raw.replace(/\s+/g, '')}`);
      if (seen.has(key)) continue;
      seen.add(key);
      if (isTemplate(raw)) continue;
      if (allowToast) showConfirmToast(formatBlock(raw));
    }
  }

  function scan() {
    const els = assistantEls();
    if (!els.length) {
      // 平台改版：整頁掃描。第一輪只建立基準，不跳卡片。
      collectBlocks(readableText(document.body), !firstScan);
      firstScan = false;
      return;
    }
    const lastIdx = els.length - 1;
    els.forEach((el, idx) => {
      collectBlocks(el.innerText || '', !firstScan || idx === lastIdx);
    });
    firstScan = false;
  }

  // 標記內容是 JSON 就整理成條列，不是就原樣收。
  // 已知欄位照順序排版，沒列到的欄位也要收下來（prompt 可能被使用者改寫）。
  const FIELDS = [
    ['summary', '總結'],
    ['background', '背景'],
    ['key_points', '重點'],
    ['quotes', '原話'],
    ['decision', '決定'],
    ['open_questions', '待解'],
    ['next_steps', '下一步'],
  ];

  function renderField(label, val) {
    if (Array.isArray(val)) {
      if (!val.length) return '';
      return `【${label}】\n${val.map((v) => `・${v}`).join('\n')}`;
    }
    return val ? `【${label}】${val}` : '';
  }

  function formatBlock(raw) {
    try {
      const j = JSON.parse(raw);
      const done = new Set();
      const lines = [];
      for (const [key, label] of FIELDS) {
        done.add(key);
        const s = renderField(label, j[key]);
        if (s) lines.push(s);
      }
      for (const [key, val] of Object.entries(j)) {
        if (done.has(key)) continue;
        const s = renderField(key, val);
        if (s) lines.push(s);
      }
      // 區塊之間空一行，不要全部擠成一坨
      return lines.length ? lines.join('\n\n') : raw;
    } catch (_) {
      return raw;
    }
  }

  // ── 寫入 ─────────────────────────────────────────

  let watchdog = null;

  function sendCapture(text, source) {
    showStatusToast(`⏳ 準備寫入…（${text.length.toLocaleString()} 字）`, null, 0, true);
    // 背景服務可能被瀏覽器休眠而讓回呼永遠不來，不設看門狗就是無盡轉圈
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      showStatusToast('❌ 超過三分鐘沒有回應，請重試一次；若持續發生請看擴充的「最近寫入」紀錄', null, 20000);
    }, 180000);
    chrome.runtime.sendMessage({
      type: 'MESH_CAPTURE',
      payload: { text, source, platform, convUrl: convUrl(), title: convTitle() },
    }, (res) => {
      clearTimeout(watchdog);
      if (chrome.runtime.lastError) {
        showStatusToast(`❌ ${chrome.runtime.lastError.message}`, null, 8000);
        return;
      }
      if (res && res.ok) {
        const f4 = res.f4 ? `・知識庫 ${res.f4.chunks} 片` : (res.f4Error ? `・知識庫失敗：${res.f4Error}` : '');
        showStatusToast(
          `✅ 已寫入「${res.docName}」・${text.length.toLocaleString()} 字${f4}`,
          res.docUrl, 30000,
        );
      } else {
        showStatusToast(`❌ 寫入失敗：${(res && res.error) || '未知錯誤'}`, null, 8000);
      }
    });
  }

  // ── Toast ────────────────────────────────────────

  let statusToast = null;
  let confirmToasts = [];

  function baseToast(cls) {
    const el = document.createElement('div');
    el.className = `mesh-toast ${cls}`;
    document.body.appendChild(el);
    return el;
  }

  function updateStatusText(text) {
    if (!statusToast) return;
    const span = statusToast.querySelector('.mesh-status-text');
    if (span) span.textContent = text;
  }

  function showStatusToast(msg, docUrl, autoHideMs, busy) {
    if (statusToast) statusToast.remove();
    const el = baseToast('mesh-status');
    statusToast = el;

    const span = document.createElement('span');
    span.className = 'mesh-status-text';
    span.textContent = msg;
    el.appendChild(span);

    // 進行中就掛一條不定量進度條：不知道還要多久，但看得出它還活著
    if (busy) {
      el.classList.add('mesh-busy');
      const bar = document.createElement('div');
      bar.className = 'mesh-progress';
      bar.appendChild(document.createElement('i'));
      el.appendChild(bar);
    }

    if (docUrl) {
      const a = document.createElement('a');
      a.className = 'mesh-doc-link';
      a.textContent = '開啟 Doc ↗';
      a.href = docUrl;
      a.target = '_blank';
      a.rel = 'noopener';
      el.appendChild(a);
    }

    function close() {
      clearTimeout(timer);
      el.remove();
      if (statusToast === el) statusToast = null;
    }

    if (autoHideMs > 0) {
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'mesh-close';
      closeBtn.textContent = '✕';
      closeBtn.title = '關閉';
      closeBtn.addEventListener('click', close);
      el.appendChild(closeBtn);
    }

    // 滑鼠停在卡片上就不倒數，離開才重新計時——來得及點「開啟 Doc」
    let timer = null;
    const arm = () => {
      if (autoHideMs > 0) timer = setTimeout(close, autoHideMs);
    };
    el.addEventListener('mouseenter', () => clearTimeout(timer));
    el.addEventListener('mouseleave', arm);
    arm();
  }

  // 多張卡片由程式算位置往上疊，不靠 CSS 選擇器猜順序
  function restack() {
    let bottom = 20;
    for (const t of confirmToasts) {
      t.style.bottom = `${bottom}px`;
      bottom += t.offsetHeight + 12;
    }
  }

  function showConfirmToast(text) {
    // 最多同時三張，舊的先收
    while (confirmToasts.length >= 3) confirmToasts.shift().remove();
    const el = baseToast('mesh-sync');
    confirmToasts.push(el);

    const title = document.createElement('div');
    title.className = 'mesh-toast-title';
    title.textContent = '⚡ Mesh Sync 偵測到脈絡標記';
    el.appendChild(title);

    const preview = document.createElement('div');
    preview.className = 'mesh-toast-preview';
    preview.textContent = text.length > 800 ? `${text.slice(0, 800)}…` : text;
    el.appendChild(preview);

    // 讓使用者按下去之前就知道會一起寫入什麼
    const plan = document.createElement('div');
    plan.className = 'mesh-toast-plan';
    plan.textContent = contextTurns === 0
      ? '只寫入上面的摘要（可在 popup 改成一併收錄原文）'
      : `＋ 一併收錄對話原文（${contextTurns < 0 ? '整場全文' : `最近 ${contextTurns} 則`}）`;
    el.appendChild(plan);

    const row = document.createElement('div');
    row.className = 'mesh-toast-actions';
    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'mesh-btn mesh-btn-primary';
    okBtn.textContent = '✅ 寫入脈絡 Doc';
    okBtn.addEventListener('click', () => {
      dismiss();
      // 摘要是索引，原文才是脈絡：一併附上對話原文（-1 = 整場全文）
      const all = contextTurns < 0;
      const ctx = contextTurns === 0 ? '' : fullTranscript(all ? 0 : contextTurns);
      const label = all ? '整場' : `最近 ${contextTurns} 則`;
      const body = ctx ? `${text}\n\n──── 對話原文（${label}）────\n${ctx}` : text;
      sendCapture(body, 'marker');
    });
    const noBtn = document.createElement('button');
    noBtn.type = 'button';
    noBtn.className = 'mesh-btn';
    noBtn.textContent = '略過';
    noBtn.addEventListener('click', dismiss);
    row.appendChild(okBtn);
    row.appendChild(noBtn);
    el.appendChild(row);

    function dismiss() {
      el.remove();
      confirmToasts = confirmToasts.filter((t) => t !== el);
      restack();
    }
    restack();
    setTimeout(dismiss, 60000);
  }
})();
