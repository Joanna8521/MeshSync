// =====================================================
// Mesh Sync — Background Service Worker v3.0（開源版）
// 擷取內容 → 使用者自己的 Google Drive（drive.file 最小權限）
// 一場對話一份 Google Doc，底部附原始討論連結
// 多客戶：每個客戶各自的資料夾，寫入目標跟著 activeProfile 切換
// =====================================================

const FOOTER_MARK = '━━━━ 原始討論連結 ━━━━';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const DOCS = 'https://docs.googleapis.com/v1';

// 第一次安裝：打開設定導覽（提醒把 [CONTEXT] prompt 貼進各平台的個人化設定）
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'MESH_CAPTURE') {
    handleCapture(msg.payload).then(sendResponse);
    return true;
  }
  if (msg.type === 'MESH_CONNECT') {
    getToken(true)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: errMsg(e) }));
    return true;
  }
  if (msg.type === 'MESH_STATUS') {
    getToken(false)
      .then(() => sendResponse({ connected: true }))
      .catch(() => sendResponse({ connected: false }));
    return true;
  }
  return false;
});

// ── OAuth ────────────────────────────────────────────

function getToken(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(new Error(
          (chrome.runtime.lastError && chrome.runtime.lastError.message) || '尚未連接 Google'
        ));
      } else {
        resolve(token);
      }
    });
  });
}

async function withAuthRetry(fn) {
  let token = await getToken(true);
  try {
    return await fn(token);
  } catch (e) {
    if (!e.auth) throw e;
    // token 過期：清掉快取重拿一次
    await new Promise((r) => chrome.identity.removeCachedAuthToken({ token }, r));
    token = await getToken(true);
    return fn(token);
  }
}

// ── Google API 共用層 ─────────────────────────────────
// 教訓：非 2xx 一律丟錯並帶上後端原因，錯誤訊息不能是空的

async function api(token, method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    const e = new Error('AUTH_EXPIRED');
    e.auth = true;
    throw e;
  }
  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = (j.error && j.error.message) || '';
    } catch (_) { /* 非 JSON 錯誤內文 */ }
    throw new Error(`Google API ${res.status}：${detail || res.statusText || '未知錯誤'}`);
  }
  return res.status === 204 ? null : res.json();
}

function errMsg(e) {
  return (e && e.message) || (e && e.constructor && e.constructor.name) || '未知錯誤';
}

// ── 主流程 ───────────────────────────────────────────

async function handleCapture(p) {
  try {
    const result = await withAuthRetry((token) => doCapture(token, p));

    // 知識庫是附加目的地：失敗只回報，不能讓主功能跟著失敗
    let f4 = null;
    let f4Error = '';
    try {
      f4 = await syncToFocus4ai(p, result.docName);
    } catch (e) {
      f4Error = errMsg(e);
    }

    const extra = f4 ? `・知識庫 ${f4.chunks} 片` : (f4Error ? `・知識庫失敗：${f4Error}` : '');
    await logEntry({
      ok: true,
      msg: `已寫入「${result.docName}」${extra}`,
      docUrl: result.docUrl,
      time: Date.now(),
    });
    badge(true);
    return { ok: true, docUrl: result.docUrl, docName: result.docName, f4, f4Error };
  } catch (e) {
    const m = errMsg(e);
    await logEntry({ ok: false, msg: m, time: Date.now() });
    badge(false);
    return { ok: false, error: m };
  }
}

async function doCapture(token, p) {
  const profile = await activeProfile();
  const folderId = await ensureFolder(token, profile);
  const doc = await ensureDoc(token, folderId, profile, p);
  await appendFragment(token, doc.docId, p);
  return { docName: doc.name, docUrl: `https://docs.google.com/document/d/${doc.docId}/edit` };
}

// ── Focus4ai 知識庫（選用的第二個目的地）──────────────
// Drive 是給人看的，知識庫是給檢索用的。這條路失敗不能影響主功能，
// 但要把原因回報出來，不能安靜地什麼都沒發生。

function mdEscape(s) {
  return String(s || '').replace(/"/g, "'").replace(/\n/g, ' ').trim();
}

async function syncToFocus4ai(p, docName) {
  const s = await chrome.storage.sync.get(['f4Enabled', 'f4Base', 'f4Folder']);
  if (!s.f4Enabled || !s.f4Base) return null;

  const base = String(s.f4Base).replace(/\/+$/, '');
  const folder = String(s.f4Folder || '00_inbox/mesh-sync').replace(/^\/+|\/+$/g, '');
  const path = `${folder}/${docName}.md`;
  const url = `${base}/api/doc?path=${encodeURIComponent(path)}`;

  // 先讀回既有內容，才能累加而不是覆蓋（同一場對話會寫很多次）
  let existing = '';
  try {
    const res = await fetch(`${base}/api/doc?path=${encodeURIComponent(path)}`);
    if (res.ok) existing = (await res.json()).content || '';
  } catch (_) { /* 404 或第一次寫入，正常 */ }

  const stamp = dateTimeStr();
  const srcLabel = { selection: '手動圈選', full: '整場對話', marker: 'AI 標記' }[p.source] || 'AI 標記';
  const body = cleanText(p.text);

  let out;
  if (existing) {
    out = `${existing.replace(/\s*$/, '')}\n\n## ${stamp}・${srcLabel}\n\n${body}\n`;
  } else {
    // frontmatter 讓切片器拿得到中繼資料，標題階層讓它有語意邊界可切
    out = [
      '---',
      `title: "${mdEscape(p.title || docName)}"`,
      `source: "${p.convUrl}"`,
      `platform: ${p.platform}`,
      `captured: ${stamp}`,
      'tags: [mesh-sync, ai-對話脈絡]',
      '---',
      '',
      `# ${p.title || docName}`,
      '',
      `原始討論：${p.convUrl}`,
      '',
      `## ${stamp}・${srcLabel}`,
      '',
      body,
      '',
    ].join('\n');
  }

  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: out }),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).detail || ''; } catch (_) { /* 非 JSON */ }
    throw new Error(`Focus4ai ${res.status}：${detail || res.statusText || '寫入失敗'}`);
  }
  const j = await res.json();
  return { path, chunks: j.chunks };
}

// ── 客戶 profile ─────────────────────────────────────

async function activeProfile() {
  const s = await chrome.storage.sync.get(['profiles', 'activeProfileId']);
  const profiles = Array.isArray(s.profiles) ? s.profiles : [];
  let p = profiles.find((x) => x.id === s.activeProfileId) || profiles[0];
  if (!p) {
    p = { id: 'default', name: '自用', folderName: 'Mesh Sync 脈絡紀錄' };
    await chrome.storage.sync.set({ profiles: [p], activeProfileId: p.id });
  }
  return p;
}

// ── Drive 資料夾（每個客戶一個，第一次寫入時自動建立） ──

async function ensureFolder(token, profile) {
  const { meshFolders = {} } = await chrome.storage.local.get(['meshFolders']);

  // 使用者指定的資料夾優先。drive.file 權限只看得到本擴充建立（或使用者授權過）
  // 的檔案，所以外部資料夾可能拿不到——這時要給看得懂的說明，不能只丟 404。
  if (profile.folderId) {
    try {
      const f = await api(token, 'GET', `${DRIVE}/files/${profile.folderId}?fields=id,trashed,mimeType`);
      if (f && !f.trashed && f.mimeType === 'application/vnd.google-apps.folder') return profile.folderId;
      throw new Error('指定的 ID 不是有效的資料夾（可能已刪除）');
    } catch (e) {
      if (e.auth) throw e;
      throw new Error(
        '無法存取你指定的資料夾。本擴充只有「自己建立的檔案」的權限，'
        + '請清空這個欄位讓它自動建立資料夾，再到 Google Drive 把該資料夾拖到你想要的位置'
        + '（搬移後仍然有效）。'
      );
    }
  }

  const cached = meshFolders[profile.id];
  if (cached) {
    try {
      const f = await api(token, 'GET', `${DRIVE}/files/${cached}?fields=id,trashed`);
      if (f && !f.trashed) return cached;
    } catch (e) {
      if (e.auth) throw e; // 404 等其他錯誤 → 資料夾不見了，往下重建
    }
  }
  const name = String(profile.folderName || `Mesh Sync — ${profile.name}`).trim() || 'Mesh Sync 脈絡紀錄';
  const f = await api(token, 'POST', `${DRIVE}/files?fields=id`, {
    name,
    mimeType: 'application/vnd.google-apps.folder',
  });
  meshFolders[profile.id] = f.id;
  await chrome.storage.local.set({ meshFolders });
  return f.id;
}

// ── 一場對話一份 Doc ─────────────────────────────────

async function ensureDoc(token, folderId, profile, p) {
  const convKey = `${profile.id}|${p.convUrl}`;
  const { meshDocs = {} } = await chrome.storage.local.get(['meshDocs']);
  const cached = meshDocs[convKey];
  if (cached) {
    try {
      const f = await api(token, 'GET', `${DRIVE}/files/${cached.docId}?fields=id,trashed`);
      if (f && !f.trashed) return cached;
    } catch (e) {
      if (e.auth) throw e; // Doc 被刪 → 重建
    }
  }

  const topic = sanitizeName(p.title) || sanitizeName(p.text).slice(0, 24) || '未命名討論';
  const docName = `${ymd()}_${topic}_${platformLabel(p.platform)}`;

  const created = await api(token, 'POST', `${DRIVE}/files?fields=id`, {
    name: docName,
    mimeType: 'application/vnd.google-apps.document',
    parents: [folderId],
  });

  // 初始內容：標題＋中繼資料＋底部連結區
  const title = topic;
  const header = `${title}\n${platformLabel(p.platform)}・建立於 ${dateTimeStr()}\n\n`;
  const footer = `${FOOTER_MARK}\n${p.convUrl}\n`;
  const urlStart = 1 + header.length + FOOTER_MARK.length + 1;
  await api(token, 'POST', `${DOCS}/documents/${created.id}:batchUpdate`, {
    requests: [
      { insertText: { location: { index: 1 }, text: header + footer } },
      {
        updateParagraphStyle: {
          range: { startIndex: 1, endIndex: 1 + title.length },
          paragraphStyle: { namedStyleType: 'TITLE' },
          fields: 'namedStyleType',
        },
      },
      {
        updateTextStyle: {
          range: { startIndex: urlStart, endIndex: urlStart + p.convUrl.length },
          textStyle: { link: { url: p.convUrl } },
          fields: 'link',
        },
      },
    ],
  });

  const entry = { docId: created.id, name: docName };
  meshDocs[convKey] = entry;
  await chrome.storage.local.set({ meshDocs });
  return entry;
}

// ── 片段累加：插在底部連結區之前 ──────────────────────

async function appendFragment(token, docId, p) {
  const doc = await api(
    token, 'GET',
    `${DOCS}/documents/${docId}?fields=body.content(startIndex,endIndex,paragraph.elements.textRun.content)`
  );
  const content = (doc.body && doc.body.content) || [];
  let insertAt = null;
  for (const el of content) {
    if (!el.paragraph) continue;
    const txt = (el.paragraph.elements || []).map((e) => (e.textRun && e.textRun.content) || '').join('');
    if (txt.includes('原始討論連結')) {
      insertAt = el.startIndex;
      break;
    }
  }
  if (insertAt === null) {
    // 找不到底部標記（使用者手動刪了）→ 附加到文件末尾
    const last = content[content.length - 1];
    insertAt = last ? last.endIndex - 1 : 1;
  }

  const srcLabel = { selection: '手動圈選', full: '整場對話', marker: 'AI 標記' }[p.source] || 'AI 標記';
  const head = `🕐 ${dateTimeStr()}・${srcLabel}\n`;
  const bodyText = `${cleanText(p.text)}\n\n`;
  await api(token, 'POST', `${DOCS}/documents/${docId}:batchUpdate`, {
    requests: [
      { insertText: { location: { index: insertAt }, text: head + bodyText } },
      {
        updateParagraphStyle: {
          range: { startIndex: insertAt, endIndex: insertAt + head.length },
          paragraphStyle: { namedStyleType: 'HEADING_3' },
          fields: 'namedStyleType',
        },
      },
      {
        updateParagraphStyle: {
          range: { startIndex: insertAt + head.length, endIndex: insertAt + head.length + bodyText.length },
          paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
          fields: 'namedStyleType',
        },
      },
      // 插入的文字會繼承插入點的格式（底色、粗體…），一律清乾淨
      {
        updateTextStyle: {
          range: { startIndex: insertAt, endIndex: insertAt + head.length + bodyText.length },
          textStyle: {},
          fields: 'backgroundColor,foregroundColor,bold,italic,underline,strikethrough',
        },
      },
    ],
  });
}

// ── 工具 ─────────────────────────────────────────────

function sanitizeName(s) {
  return String(s || '')
    .replace(/[\/\\:*?"<>|\r\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}

function cleanText(s) {
  return String(s || '')
    .replace(/\r/g, '')
    // 破折號一律改成逗號（分隔線用的 ─ ━ 是不同字元，不受影響）
    .replace(/\s*—+\s*/g, '，')
    .replace(/，{2,}/g, '，')
    .replace(/，(?=[。！？；、，\n])/g, '')
    .replace(/，$/gm, '')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function platformLabel(p) {
  return { chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini' }[p] || p || '?';
}

function ymd(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function dateTimeStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function badge(ok) {
  chrome.action.setBadgeText({ text: ok ? '✓' : '!' });
  chrome.action.setBadgeBackgroundColor({ color: ok ? '#10704a' : '#dc2626' });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 3000);
}

async function logEntry(entry) {
  const { meshLog = [] } = await chrome.storage.local.get(['meshLog']);
  meshLog.unshift(entry);
  if (meshLog.length > 50) meshLog.splice(50);
  await chrome.storage.local.set({ meshLog });
}
