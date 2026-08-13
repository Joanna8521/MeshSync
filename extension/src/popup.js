// Mesh Sync — Popup v3.0（多客戶）
// 教訓：每個寫入動作都要檢查結果再回報成功，失敗把原因秀出來

const $ = (id) => document.getElementById(id);

const PROMPT_SNIPPET = `當我說「記錄脈絡」或這段討論產生重要結論時，
請在回覆的最後面輸出這個區塊（原樣輸出，不要解釋）。
請寫得具體：key_points 五到八條，寫出「為什麼」與推導過程，不要只寫結論標題；
quotes 摘錄我原話裡最關鍵的句子。
不要使用破折號，該斷句的地方用逗號或句號。
[CONTEXT]
{"summary":"一句話總結",
 "background":"這段討論的來龍去脈、從哪裡開始的",
 "key_points":["具體重點，含理由或推導","..."],
 "quotes":["使用者的關鍵原話"],
 "decision":"做了什麼決定",
 "open_questions":["還沒解決的問題"],
 "next_steps":["下一步要做什麼"]}
[/CONTEXT]`;

const F4_DEFAULT_BASE = 'https://app.focus4ai.com';
const F4_DEFAULT_FOLDER = '00_inbox/mesh-sync';

let profiles = [];
let activeId = null;
let delArmed = false;

document.addEventListener('DOMContentLoaded', init);

async function init() {
  $('promptText').value = PROMPT_SNIPPET;

  const s = await chrome.storage.sync.get(['profiles', 'activeProfileId', 'autoDetect', 'contextTurns',
    'f4Enabled', 'f4Base', 'f4Folder', 'f4Private']);
  profiles = Array.isArray(s.profiles) && s.profiles.length
    ? s.profiles
    : [{ id: 'default', name: '自用', folderName: 'Mesh Sync 脈絡紀錄' }];
  activeId = profiles.some((p) => p.id === s.activeProfileId) ? s.activeProfileId : profiles[0].id;
  $('autoDetect').checked = s.autoDetect !== false;
  $('contextTurns').value = String(typeof s.contextTurns === 'number' ? s.contextTurns : 6);
  $('f4Enabled').checked = !!s.f4Enabled;
  // 預留文字是灰的、按下去還是空的。線上站台就是這個位址，直接填好，
  // 自架的人再改掉即可。
  $('f4Base').value = s.f4Base || F4_DEFAULT_BASE;
  $('f4Folder').value = s.f4Folder || F4_DEFAULT_FOLDER;
  $('f4Private').checked = s.f4Private !== false;

  renderProfiles();
  renderProfileFields();
  renderLog();
  refreshStatus();

  $('connectBtn').addEventListener('click', connect);
  $('profileSelect').addEventListener('change', onSwitchProfile);
  $('addBtn').addEventListener('click', () => {
    $('addRow').style.display = $('addRow').style.display === 'none' ? 'flex' : 'none';
    $('addName').focus();
  });
  $('addOk').addEventListener('click', addProfile);
  $('delBtn').addEventListener('click', delProfile);
  $('saveBtn').addEventListener('click', saveProfile);
  $('autoDetect').addEventListener('change', saveAutoDetect);
  $('contextTurns').addEventListener('change', saveContextTurns);
  $('copyPrompt').addEventListener('click', copyPrompt);
  $('captureAll').addEventListener('click', captureAll);
  $('diagBtn').addEventListener('click', runDiag);
  $('f4Enabled').addEventListener('change', saveFocus4ai);
  $('f4Base').addEventListener('change', saveFocus4ai);
  $('f4Folder').addEventListener('change', saveFocus4ai);
  $('f4Private').addEventListener('change', saveFocus4ai);
  $('f4Test').addEventListener('click', testFocus4ai);
}

// ── Focus4ai 知識庫 ───────────────────────────────

function f4Origin() {
  const raw = $('f4Base').value.trim().replace(/\/+$/, '');
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch (_) {
    return null;
  }
}

// 使用者填的網址是任意主機，所以權限要當下才要，不預先索取整個網際網路
function ensureHostPermission(cb) {
  const origin = f4Origin();
  if (!origin) {
    setMsg('f4Msg', 'err', '網址格式不對，要像 https://app.focus4ai.com');
    return;
  }
  chrome.permissions.request({ origins: [`${origin}/*`] }, (granted) => {
    if (!granted) {
      setMsg('f4Msg', 'err', '沒有取得存取這個網址的權限，同步無法運作');
      return;
    }
    cb(origin);
  });
}

function saveFocus4ai() {
  const enabled = $('f4Enabled').checked;
  const base = $('f4Base').value.trim().replace(/\/+$/, '');
  const folder = $('f4Folder').value.trim() || '00_inbox/mesh-sync';
  const store = () => chrome.storage.sync.set(
    { f4Enabled: enabled, f4Base: base, f4Folder: folder, f4Private: $('f4Private').checked },
    () => {
      if (chrome.runtime.lastError) {
        setMsg('f4Msg', 'err', chrome.runtime.lastError.message);
        return;
      }
      setMsg('f4Msg', 'ok', enabled ? '✅ 已啟用同步' : '已關閉同步');
    },
  );
  if (enabled && base) ensureHostPermission(store);
  else store();
}

function testFocus4ai() {
  setMsg('f4Msg', '', '測試中…');
  ensureHostPermission(async (origin) => {
    try {
      const res = await fetch(`${origin}/api/version`, { credentials: 'include' });
      if (res.status === 401 || res.status === 403) {
        setMsg('f4Msg', 'err', '尚未登入（或登入已過期），同步會失敗。');
        addMsgLink('f4Msg', `${origin}/login`, '去登入 ↗');
        return;
      }
      if (!res.ok) {
        setMsg('f4Msg', 'err', `連得上但回 ${res.status}，確認網址是 Focus4ai 的根位址`);
        return;
      }
      // 被導到登入頁會拿到 200 + HTML，不能當成連線成功
      if (!(res.headers.get('content-type') || '').includes('application/json')) {
        setMsg('f4Msg', 'err', '尚未登入（或登入已過期），同步會失敗。');
        addMsgLink('f4Msg', `${origin}/login`, '去登入 ↗');
        return;
      }
      const j = await res.json();
      setMsg('f4Msg', 'ok', `✅ 連上 Focus4ai${j.version ? ` v${j.version}` : ''}`);
    } catch (e) {
      setMsg('f4Msg', 'err', `連不上：${e.message || '請確認服務有在跑、網址含 https://'}`);
    }
  });
}

// ── 分頁診斷 ──────────────────────────────────────

function runDiag() {
  setMsg('diagMsg', '', '檢查中…');
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (!tab || !SUPPORTED.test(tab.url || '')) {
      setMsg('diagMsg', 'err', '目前分頁不是 ChatGPT / Claude / Gemini');
      return;
    }
    chrome.tabs.sendMessage(tab.id, { type: 'MESH_DIAG' }, (r) => {
      if (chrome.runtime.lastError || !r) {
        setMsg('diagMsg', 'err', '未注入：請重整這個分頁；若仍失敗，到 chrome://extensions 確認此網站的存取權已開啟');
        return;
      }
      const cls = r.assistant > 0 || r.hasMarker ? 'ok' : 'err';
      setMsg('diagMsg', cls,
        `${r.platform}｜訊息 ${r.assistant} 則・對話輪 ${r.turns}｜`
        + `頁面${r.hasMarker ? '有' : '沒有'}標記｜已處理 ${r.seen}｜`
        + `自動偵測${r.autoDetect ? '開' : '關'}`);
    });
  });
}

// ── 收錄整場對話 ──────────────────────────────────

const SUPPORTED = /^https:\/\/(chatgpt\.com|chat\.openai\.com|claude\.ai|gemini\.google\.com)\//;

function captureAll() {
  setMsg('allMsg', '', '');
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (!tab || !SUPPORTED.test(tab.url || '')) {
      setMsg('allMsg', 'err', '請先切到 ChatGPT / Claude / Gemini 的對話分頁');
      return;
    }
    chrome.tabs.sendMessage(tab.id, { type: 'MESH_CAPTURE_ALL' }, (res) => {
      if (chrome.runtime.lastError) {
        setMsg('allMsg', 'err', `請重新整理該分頁後再試（${chrome.runtime.lastError.message}）`);
        return;
      }
      if (res && res.ok) {
        setMsg('allMsg', 'ok', `⏳ 已送出 ${res.chars.toLocaleString()} 字，結果會顯示在頁面上`);
      } else {
        setMsg('allMsg', 'err', (res && res.error) || '收錄失敗');
      }
    });
  });
}

// ── 連線狀態 ──────────────────────────────────────

function refreshStatus() {
  chrome.runtime.sendMessage({ type: 'MESH_STATUS' }, (res) => {
    const ok = !chrome.runtime.lastError && res && res.connected;
    $('connDot').className = ok ? 'dot on' : 'dot';
    $('connText').textContent = ok ? '已連接 Google' : '尚未連接';
    $('connectBtn').style.display = ok ? 'none' : '';
  });
}

function connect() {
  setMsg('connMsg', '', '');
  chrome.runtime.sendMessage({ type: 'MESH_CONNECT' }, (res) => {
    if (chrome.runtime.lastError) {
      setMsg('connMsg', 'err', chrome.runtime.lastError.message);
      return;
    }
    if (res && res.ok) {
      setMsg('connMsg', 'ok', '✅ 已連接');
      refreshStatus();
    } else {
      setMsg('connMsg', 'err', `連接失敗：${(res && res.error) || '未知錯誤'}`);
    }
  });
}

// ── 客戶 profile ──────────────────────────────────

function renderProfiles() {
  const sel = $('profileSelect');
  sel.textContent = '';
  for (const p of profiles) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    if (p.id === activeId) opt.selected = true;
    sel.appendChild(opt);
  }
}

function activeProfile() {
  return profiles.find((p) => p.id === activeId) || profiles[0];
}

// 使用者會直接貼整條網址，要洗成純 ID
function parseFolderId(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  const m = s.match(/\/folders\/([a-zA-Z0-9_-]+)/) || s.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  return s.replace(/^https?:\/\/\S*\//, '').replace(/[?#].*$/, '').trim();
}

async function renderProfileFields() {
  const p = activeProfile();
  $('folderName').value = p.folderName || '';
  $('folderId').value = p.folderId || '';
  const { meshFolders = {} } = await chrome.storage.local.get(['meshFolders']);
  const fid = meshFolders[p.id];
  const hint = $('folderHint');
  hint.textContent = '';
  if (fid) {
    const a = document.createElement('a');
    a.href = `https://drive.google.com/drive/folders/${fid}`;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = '開啟此客戶的 Drive 資料夾 ↗';
    hint.appendChild(a);
    hint.appendChild(document.createTextNode('（要改名請直接在 Drive 改）'));
  } else {
    hint.textContent = '第一次寫入時會自動在你的雲端硬碟建立這個資料夾。';
  }
}

function onSwitchProfile() {
  activeId = $('profileSelect').value;
  chrome.storage.sync.set({ activeProfileId: activeId }, () => {
    if (chrome.runtime.lastError) setMsg('saveMsg', 'err', chrome.runtime.lastError.message);
  });
  disarmDelete();
  renderProfileFields();
}

function addProfile() {
  const name = $('addName').value.trim();
  if (!name) {
    setMsg('saveMsg', 'err', '請輸入客戶名稱');
    return;
  }
  const p = { id: `p_${Date.now()}`, name, folderName: `Mesh Sync — ${name}` };
  profiles.push(p);
  activeId = p.id;
  chrome.storage.sync.set({ profiles, activeProfileId: activeId }, () => {
    if (chrome.runtime.lastError) {
      setMsg('saveMsg', 'err', chrome.runtime.lastError.message);
      return;
    }
    $('addName').value = '';
    $('addRow').style.display = 'none';
    renderProfiles();
    renderProfileFields();
    setMsg('saveMsg', 'ok', `✅ 已建立客戶「${name}」`);
  });
}

// 刪除採兩段式確認（popup 裡不能用 confirm()）
function delProfile() {
  if (profiles.length <= 1) {
    setMsg('saveMsg', 'err', '至少要保留一個客戶');
    return;
  }
  if (!delArmed) {
    delArmed = true;
    $('delBtn').classList.add('danger-armed');
    setMsg('saveMsg', 'err', `再按一次 ✕ 確認刪除「${activeProfile().name}」（Drive 裡的檔案不會被刪）`);
    return;
  }
  const removed = activeProfile();
  profiles = profiles.filter((p) => p.id !== removed.id);
  activeId = profiles[0].id;
  chrome.storage.sync.set({ profiles, activeProfileId: activeId }, () => {
    if (chrome.runtime.lastError) {
      setMsg('saveMsg', 'err', chrome.runtime.lastError.message);
      return;
    }
    disarmDelete();
    renderProfiles();
    renderProfileFields();
    setMsg('saveMsg', 'ok', `已刪除「${removed.name}」（雲端檔案保留）`);
  });
}

function disarmDelete() {
  delArmed = false;
  $('delBtn').classList.remove('danger-armed');
}

function saveProfile() {
  const p = activeProfile();
  p.folderName = $('folderName').value.trim() || p.folderName;
  p.folderId = parseFolderId($('folderId').value);
  chrome.storage.sync.set({ profiles }, async () => {
    if (chrome.runtime.lastError) {
      setMsg('saveMsg', 'err', `儲存失敗：${chrome.runtime.lastError.message}`);
      return;
    }
    $('folderId').value = p.folderId;
    const { meshFolders = {} } = await chrome.storage.local.get(['meshFolders']);
    if (p.folderId) {
      setMsg('saveMsg', 'ok', '✅ 已儲存，將寫入你指定的資料夾（下次寫入時驗證是否有權限）');
    } else {
      setMsg('saveMsg', 'ok', meshFolders[p.id]
        ? '✅ 已儲存（資料夾已存在，改名請直接在 Drive 改）'
        : '✅ 已儲存，第一次寫入時建立資料夾');
    }
  });
}

function saveAutoDetect() {
  chrome.storage.sync.set({ autoDetect: $('autoDetect').checked }, () => {
    if (chrome.runtime.lastError) setMsg('saveMsg', 'err', chrome.runtime.lastError.message);
  });
}

function saveContextTurns() {
  chrome.storage.sync.set({ contextTurns: Number($('contextTurns').value) }, () => {
    if (chrome.runtime.lastError) setMsg('saveMsg', 'err', chrome.runtime.lastError.message);
  });
}

// ── Prompt 複製 ───────────────────────────────────

async function copyPrompt() {
  try {
    await navigator.clipboard.writeText(PROMPT_SNIPPET);
    $('copyPrompt').textContent = '✅ 已複製';
  } catch (e) {
    $('promptText').select();
    document.execCommand('copy');
    $('copyPrompt').textContent = '✅ 已複製';
  }
  setTimeout(() => { $('copyPrompt').textContent = '複製'; }, 2000);
}

// ── 最近寫入 ──────────────────────────────────────

async function renderLog() {
  const { meshLog = [] } = await chrome.storage.local.get(['meshLog']);
  const ul = $('logList');
  ul.textContent = '';
  if (!meshLog.length) {
    const li = document.createElement('li');
    li.textContent = '還沒有寫入紀錄';
    ul.appendChild(li);
    return;
  }
  for (const e of meshLog.slice(0, 10)) {
    const li = document.createElement('li');
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = fmtTime(e.time);
    li.appendChild(t);
    li.appendChild(document.createTextNode(`${e.ok ? '✅' : '❌'} ${e.msg} `));
    if (e.docUrl) {
      const a = document.createElement('a');
      a.href = e.docUrl;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = '開啟 ↗';
      li.appendChild(a);
    }
    ul.appendChild(li);
  }
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 錯誤訊息要能直接動手解決，不是只告訴使用者哪裡不對
function addMsgLink(id, href, label) {
  const el = $(id);
  el.appendChild(document.createTextNode(' '));
  const a = document.createElement('a');
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = label;
  el.appendChild(a);
}

function setMsg(id, cls, text) {
  const el = $(id);
  el.className = `msg ${cls}`;
  el.textContent = text;
}
