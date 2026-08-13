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

  const host = location.hostname;
  const platform = host.includes('claude.ai') ? 'claude'
    : host.includes('gemini.google.com') ? 'gemini'
      : 'chatgpt';

  let autoDetect = true;
  chrome.storage.sync.get(['autoDetect'], (r) => {
    autoDetect = r.autoDetect !== false;
  });
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'sync' && ch.autoDetect) autoDetect = ch.autoDetect.newValue !== false;
  });

  // 來自 popup 的「收錄整場對話」
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
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

  function fullTranscript() {
    const cfg = TURNS[platform];
    const els = [...document.querySelectorAll(cfg.selector)];
    const aiName = { chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini' }[platform];
    const parts = [];
    for (const el of els) {
      // 標記區塊是給程式看的，收進逐字紀錄只會佔版面
      const body = (el.innerText || '').replace(/\[(CONTEXT|SYNC)\][\s\S]*?\[\/\1\]/g, '').trim();
      if (!body) continue;
      parts.push(`${cfg.isUser(el) ? '👤 我' : `🤖 ${aiName}`}：\n${body}`);
    }
    return parts.join('\n\n');
  }

  // ── 對話資訊 ──────────────────────────────────────

  function convUrl() {
    return location.origin + location.pathname; // 去掉 query/hash
  }

  function convTitle() {
    return (document.title || '')
      .replace(/\s*[-–—|]\s*(ChatGPT|Claude|Gemini)\s*$/i, '')
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
  const BLOCK_RE = /\[(CONTEXT|SYNC)\]([\s\S]*?)\[\/\1\]/g;

  const SELECTORS = {
    chatgpt: '[data-message-author-role="assistant"] .markdown',
    claude: '[data-testid="message-content"], .font-claude-message',
    gemini: 'model-response, .model-response-text, message-content',
  };

  // 整場對話：依畫面順序抓「每一輪」，並判斷這一輪是誰說的
  const TURNS = {
    chatgpt: {
      selector: '[data-message-author-role]',
      isUser: (el) => el.getAttribute('data-message-author-role') === 'user',
    },
    claude: {
      selector: '[data-testid="user-message"], .font-claude-message',
      isUser: (el) => el.matches('[data-testid="user-message"]'),
    },
    gemini: {
      selector: 'user-query, model-response',
      isUser: (el) => el.tagName.toLowerCase() === 'user-query',
    },
  };

  function assistantEls() {
    return [...document.querySelectorAll(SELECTORS[platform])];
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

  function scan() {
    const els = assistantEls();
    const lastIdx = els.length - 1;
    els.forEach((el, idx) => {
      const text = el.innerText || '';
      BLOCK_RE.lastIndex = 0;
      let m;
      while ((m = BLOCK_RE.exec(text)) !== null) {
        const raw = m[2].trim();
        if (!raw) continue;
        const key = hashStr(`${convUrl()}|${raw}`);
        if (seen.has(key)) continue;
        seen.add(key);
        if (isTemplate(raw)) continue;
        if (firstScan && idx !== lastIdx) continue;
        showConfirmToast(formatBlock(raw));
      }
    });
    firstScan = false;
  }

  // 標記內容是 JSON 就整理成條列，不是就原樣收
  function formatBlock(raw) {
    try {
      const j = JSON.parse(raw);
      const lines = [];
      if (j.summary) lines.push(`【總結】${j.summary}`);
      if (Array.isArray(j.key_points)) lines.push(...j.key_points.map((k) => `・${k}`));
      if (j.decision) lines.push(`【決定】${j.decision}`);
      return lines.length ? lines.join('\n') : raw;
    } catch (_) {
      return raw;
    }
  }

  // ── 寫入 ─────────────────────────────────────────

  function sendCapture(text, source) {
    showStatusToast('⏳ 寫入中…', null, 0);
    chrome.runtime.sendMessage({
      type: 'MESH_CAPTURE',
      payload: { text, source, platform, convUrl: convUrl(), title: convTitle() },
    }, (res) => {
      if (chrome.runtime.lastError) {
        showStatusToast(`❌ ${chrome.runtime.lastError.message}`, null, 8000);
        return;
      }
      if (res && res.ok) {
        showStatusToast(`✅ 已寫入「${res.docName}」`, res.docUrl, 6000);
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

  function showStatusToast(msg, docUrl, autoHideMs) {
    if (statusToast) statusToast.remove();
    const el = baseToast('mesh-status');
    statusToast = el;

    const span = document.createElement('span');
    span.className = 'mesh-status-text';
    span.textContent = msg;
    el.appendChild(span);

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
    preview.textContent = text.length > 160 ? `${text.slice(0, 160)}…` : text;
    el.appendChild(preview);

    const row = document.createElement('div');
    row.className = 'mesh-toast-actions';
    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'mesh-btn mesh-btn-primary';
    okBtn.textContent = '✅ 寫入脈絡 Doc';
    okBtn.addEventListener('click', () => {
      dismiss();
      sendCapture(text, 'marker');
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
