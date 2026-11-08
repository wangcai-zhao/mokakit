// 渲染进程逻辑
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const state = {
  peers: [],            // 在线设备
  historyPeers: {},     // 有聊天记录的设备
  currentPeer: null,    // 当前聊天对象 {id,name,host,port}
  expanded: false,
  settings: {},
  unread: 0,
  music: { files: [], idx: -1, folder: '', lyric: [], offset: 0 },
  pomo: { total: 25 * 60, left: 25 * 60, timer: null },
};

const islandUrl = (p) => 'island://local/' + encodeURIComponent(p);
const fmtSize = (n) => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n > 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B';
const fmtTime = (ts) => new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

// ---------- 时钟 ----------
function tickClock() {
  const now = new Date();
  const hm = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  const hms = now.toLocaleTimeString('zh-CN', { hour12: false });
  const dateStr = now.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  $('#pillTime').textContent = hm;
  $('#headTime').textContent = hms;
  $('#headDate').textContent = dateStr;
  $('#bigClock').textContent = hms;
  $('#bigDate').textContent = dateStr;
}
setInterval(tickClock, 1000);

async function tickMem() {
  const m = await window.island.memInfo();
  $('#pillMem').textContent = m.totalMB + 'MB';
  const parts = (m.parts || []).map(p => `${p.type} ${p.mb}MB`).join(' / ');
  $('#memInfo').textContent = `进程合计 ${m.totalMB} MB（${parts}）；GPU 合成 ${m.gpuMB} MB`;
}
setInterval(tickMem, state.settings.lowMemoryMode ? 10000 : 4000);

// ---------- 展开 / 收起 ----------
function renderExpanded() {
  $('#pill').style.display = state.expanded ? 'none' : 'flex';
  $('#panel').hidden = !state.expanded;
  if (state.expanded) { state.unread = 0; renderBadge(); }
}
function renderBadge() {
  const b = $('#pillBadge');
  b.hidden = state.unread === 0;
  b.textContent = state.unread;
}
$('#btnCollapse').addEventListener('click', () => window.island.setExpanded(false));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.expanded) window.island.setExpanded(false);
});
window.island.onExpanded((v) => { state.expanded = v; renderExpanded(); });

// ---------- 窗口拖动（无边框窗口，由主进程跟随光标移动） ----------
const drag = { active: false, moved: false, sx: 0, sy: 0 };
function bindDrag(el, onClick) {
  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('button,input,select,textarea')) return;
    drag.active = true; drag.moved = false; drag.sx = e.screenX; drag.sy = e.screenY;
    window.island.startDrag();
  });
  if (onClick) el.addEventListener('click', () => { if (!drag.moved) onClick(); });
}
bindDrag($('#pill'), () => window.island.setExpanded(true));
bindDrag($('.panel-head'), null);
window.addEventListener('mousemove', (e) => {
  if (!drag.active) return;
  if (!drag.moved && Math.hypot(e.screenX - drag.sx, e.screenY - drag.sy) > 5) drag.moved = true;
  if (drag.moved) window.island.drag();
});
function endDrag() {
  if (!drag.active) return;
  drag.active = false;
  if (drag.moved) window.island.endDrag();
}
window.addEventListener('mouseup', endDrag);
window.addEventListener('blur', endDrag);

// ---------- 贴边收缩 / 自动收起：由主进程光标轮询驱动（见 main.js startCursorWatch） ----------
// 渲染层 mouseenter/leave 对无边框透明窗口不可靠（事件丢失导致"需挪动才缩回"），不再使用
window.island.onEdgeHidden((edge) => {
  document.body.classList.toggle('edge-hidden', !!edge);
  document.body.dataset.edge = edge || '';
});
// 打字活动上报（节流 1s）：主进程据此豁免自动收起
let lastPing = 0;
document.addEventListener('keydown', () => {
  const now = Date.now();
  if (now - lastPing > 1000) { lastPing = now; window.island.activity(); }
}, true);

// ---------- 选项卡 ----------
$$('.tab').forEach(btn => btn.addEventListener('click', () => {
  $$('.tab').forEach(b => b.classList.toggle('active', b === btn));
  $$('.tab-page').forEach(p => p.classList.toggle('active', p.id === 'tab-' + btn.dataset.tab));
  if (btn.dataset.tab === 'settings') loadSettings();
  if (btn.dataset.tab === 'staging') loadStaging();
  if (btn.dataset.tab === 'clip') loadClip();
  if (btn.dataset.tab === 'notes') loadNotes();
  if (btn.dataset.tab === 'sc') loadShortcuts();
}));

// ---------- 聊天 ----------
function peerKeyList() {
  // 在线设备 + 历史设备合并
  const map = new Map();
  for (const p of state.peers) map.set(p.id, { ...p, online: true });
  for (const [id, c] of Object.entries(state.historyPeers)) {
    if (!map.has(id)) map.set(id, { id, name: c.peerName, online: false });
  }
  return [...map.values()];
}

function renderPeers() {
  const el = $('#peerList');
  const list = peerKeyList();
  if (!list.length) {
    el.innerHTML = '<div class="peer-empty">未发现内网设备<br>请确保其他设备也运行本应用</div>';
    return;
  }
  el.innerHTML = list.map(p => `
    <div class="peer-item ${state.currentPeer && state.currentPeer.id === p.id ? 'active' : ''}" data-id="${p.id}">
      ${p.online ? '🟢' : '⚪'} ${escapeHtml(p.name || '设备')}
      <div class="st">${p.online ? escapeHtml(p.host + ':' + p.port) : '离线'}</div>
    </div>`).join('');
  $$('.peer-item').forEach(it => it.addEventListener('click', () => selectPeer(it.dataset.id)));
}

async function selectPeer(id) {
  const all = peerKeyList();
  state.currentPeer = all.find(p => p.id === id);
  $('#chatTitle').textContent = (state.currentPeer.online ? '🟢 ' : '⚪ ') + (state.currentPeer.name || '设备');
  await renderChatHistory();
}

async function renderChatHistory() {
  if (!state.currentPeer) return;
  const h = await window.island.chatHistory(state.currentPeer.id);
  const box = $('#chatMsgs');
  box.innerHTML = '';
  for (const m of h.msgs) appendMsg(m, false);
  box.scrollTop = box.scrollHeight;
}

function appendMsg(m, scroll = true) {
  const box = $('#chatMsgs');
  const div = document.createElement('div');
  div.className = 'msg ' + (m.dir === 'out' ? 'out' : 'in');
  let inner = '';
  if (m.kind === 'text') {
    inner = escapeHtml(m.text);
  } else if (m.kind === 'image' && m.path) {
    inner = `<img src="${islandUrl(m.path)}" title="点击打开">
             <div class="meta">${escapeHtml(m.name)} · ${fmtSize(m.size || 0)}</div>`;
  } else {
    inner = `<div class="file-row"><span class="file-icon">📄</span>
      <span><div class="file-name">${escapeHtml(m.name)}</div>
      <div class="file-size">${fmtSize(m.size || 0)}</div></span></div>`;
  }
  div.innerHTML = inner + `<div class="meta">${fmtTime(m.ts)}${m.dir === 'out' ? ' · 已发送' : ''}</div>`;
  const img = div.querySelector('img');
  if (img) img.addEventListener('click', () => window.island.openPath(m.path));
  box.appendChild(div);
  if (scroll) box.scrollTop = box.scrollHeight;
}

async function sendText() {
  const input = $('#chatInput');
  const text = input.value.trim();
  if (!text) return;
  if (!state.currentPeer || !state.currentPeer.online) { alert('请先选择一个在线设备'); return; }
  input.value = '';
  try {
    await window.island.sendText(state.currentPeer, text);
    appendMsg({ kind: 'text', text, ts: Date.now(), dir: 'out' });
  } catch (e) { alert('发送失败：' + e.message); }
}
$('#btnSend').addEventListener('click', sendText);
$('#chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendText(); });

async function sendFiles(paths) {
  if (!paths.length) return;
  if (!state.currentPeer || !state.currentPeer.online) { alert('请先选择一个在线设备'); return; }
  const results = await window.island.sendFiles(state.currentPeer, paths);
  for (let i = 0; i < paths.length; i++) {
    const r = results[i] || {};
    if (r.ok) {
      const ext = r.name.split('.').pop().toLowerCase();
      const kind = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext) ? 'image' : 'file';
      appendMsg({ kind, name: r.name, path: paths[i], size: 0, ts: Date.now(), dir: 'out' });
    } else {
      alert(`发送 ${paths[i]} 失败：${r.error || '未知错误'}`);
    }
  }
}

$('#btnAttach').addEventListener('click', async () => {
  const paths = await window.island.pickFiles();
  if (paths.length) await sendFiles(paths);
});

// 聊天输入区直接粘贴图片 / 文件
$('#chatInput').addEventListener('paste', async (e) => {
  const cd = e.clipboardData;
  if (!cd) return;
  // 1) 网页或资源管理器复制、且被 Chromium 暴露出来的文件
  const paths = [];
  for (const f of [...(cd.files || [])]) {
    try { const p = await window.island.pathForFile(f); if (p) paths.push(p); } catch (err) {}
  }
  if (paths.length) { e.preventDefault(); await sendFiles(paths); return; }
  // 2) 截图等剪贴板图像数据：主进程读成 PNG 临时文件再发送
  if ([...(cd.items || [])].some(it => it.type && it.type.startsWith('image/'))) {
    e.preventDefault();
    const p = await window.island.pasteImage();
    if (p) await sendFiles([p]);
    return;
  }
  // 3) 资源管理器 Ctrl+C 的文件（未暴露为 DataTransfer.files）
  const fp = await window.island.pasteFiles();
  if (fp.length) { e.preventDefault(); await sendFiles(fp); }
  // 其余情况走默认文本粘贴
});

// 拖拽发送 / 暂存
const dropMask = $('#dropMask');
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; dropMask.hidden = false; });
window.addEventListener('dragleave', (e) => { e.preventDefault(); if (--dragDepth <= 0) { dropMask.hidden = true; dragDepth = 0; } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dropMask.hidden = true; dragDepth = 0;
  const files = [...(e.dataTransfer.files || [])];
  const paths = [];
  for (const f of files) {
    try { paths.push(await window.island.pathForFile(f)); } catch (err) {}
  }
  const scActive = $('#tab-sc').classList.contains('active');
  if (scActive) { renderShortcuts(await window.island.scAdd(paths)); return; }
  const chatActive = $('#tab-chat').classList.contains('active');
  if (chatActive && state.currentPeer) await sendFiles(paths);
  else {
    const list = await window.island.stagingAddPaths(paths);
    renderStaging(list);
    // 切到中转站提示
    $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === 'staging'));
    $$('.tab-page').forEach(p => p.classList.toggle('active', p.id === 'tab-staging'));
  }
});

// ---------- 中转站 ----------
async function loadStaging() {
  const { staging, recent } = await window.island.stagingList();
  renderStaging(staging);
  renderRecent(recent);
}
function renderStaging(files) {
  const el = $('#stagingList');
  if (!files.length) { el.innerHTML = '<li class="empty-tip">暂无待发送文件</li>'; return; }
  el.innerHTML = files.map((f, i) => `
    <li class="file-item"><span>📄</span><span class="fn" title="${escapeHtml(f.path)}">${escapeHtml(f.name)}</span>
      <span class="fs">${fmtSize(f.size)}</span>
      <button class="mini-btn" data-send="${i}">发送</button>
      <button class="mini-btn danger" data-del="${i}">✕</button></li>`).join('');
  el.querySelectorAll('[data-send]').forEach(b => b.addEventListener('click', async () => {
    const f = files[Number(b.dataset.send)];
    await sendFiles([f.path]);
    renderStaging(await window.island.stagingRemove(Number(b.dataset.send)));
  }));
  el.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
    renderStaging(await window.island.stagingRemove(Number(b.dataset.del)));
  }));
}
function renderRecent(files) {
  const el = $('#recentList');
  if (!files.length) { el.innerHTML = '<li class="empty-tip">暂无最近文件</li>'; return; }
  el.innerHTML = files.map(f => `
    <li class="file-item"><span>${f.kind === 'image' ? '🖼' : '📄'}</span>
      <span class="fn" title="${escapeHtml(f.path || '')}">${escapeHtml(f.name)}</span>
      <span class="fs">${fmtSize(f.size || 0)} · ${fmtTime(f.ts)}</span>
      <button class="mini-btn" data-open="${escapeHtml(f.path || '')}">打开</button></li>`).join('');
  el.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => window.island.openPath(b.dataset.open)));
}
$('#btnStagingAdd').addEventListener('click', async () => renderStaging(await window.island.stagingAdd()));
$('#btnStagingClear').addEventListener('click', async () => renderStaging(await window.island.stagingClear()));
$('#btnOpenReceived').addEventListener('click', () => window.island.stagingOpenReceived());
$('#btnStagingSendAll').addEventListener('click', async () => {
  const { staging } = await window.island.stagingList();
  if (!staging.length) return;
  await sendFiles(staging.map(f => f.path));
  renderStaging(await window.island.stagingClear());
});

// ---------- 快捷启动（列表选择 / 电脑选择 / 拖拽添加） ----------
let scItems = [];
let scPrograms = null;   // 已安装程序索引（首次读取稍慢，主进程有缓存）
let scTab = 'program';
let scQuery = '';

async function loadShortcuts() { renderShortcuts(await window.island.scList()); }

function shortcutIconHtml(it, cls) {
  if (it.icon) return `<img class="${cls}" src="${it.icon}" title="${escapeHtml(it.name)}">`;
  return `<span class="${cls} glyph" title="${escapeHtml(it.name)}">${it.type === 'folder' ? '📁' : it.type === 'app' ? '🚀' : '📄'}</span>`;
}

function renderShortcuts(items) {
  scItems = items;
  $('#scCount').textContent = `已添加 ${items.length} 项`;
  const el = $('#scGrid');
  if (!items.length) {
    el.innerHTML = '<div class="empty-tip" style="grid-column:1/-1">还没有快捷项：点"＋ 添加快捷"，或把程序 / 文件 / 文件夹拖到本页</div>';
    return;
  }
  el.innerHTML = items.map(it => `
    <div class="sc-item" data-open="${it.id}" title="${escapeHtml(it.path)}">
      <button class="sc-del" data-del="${it.id}" title="移除">✕</button>
      ${shortcutIconHtml(it, 'sc-icon')}
      <div class="sc-name">${escapeHtml(it.name)}</div>
    </div>`).join('');
  el.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', (e) => {
    if (e.target.closest('.sc-del')) return;
    window.island.scOpen(Number(b.dataset.open));
  }));
  el.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () =>
    renderShortcuts(await window.island.scRemove(Number(b.dataset.del)))));
}

// 添加快捷弹窗
async function openScModal() {
  $('#scModal').hidden = false;
  scQuery = ''; $('#scSearch').value = '';
  setScTab('program');
  if (!scPrograms) {
    $('#scList').innerHTML = '<div class="empty-tip">正在读取已安装程序…</div>';
    scPrograms = await window.island.scInstalled();
  }
  renderScStrip();
  renderScList();
}
function renderScStrip() {
  $('#scModalCount').textContent = `已添加 ${scItems.length} 项`;
  $('#scStrip').innerHTML = scItems.slice(0, 12).map(it => shortcutIconHtml(it, 'sc-strip-icon')).join('')
    || '<span class="hint">还没有添加</span>';
}
function setScTab(t) {
  scTab = t;
  $$('#scModalTabs .mt-btn').forEach(b => b.classList.toggle('active', b.dataset.mt === t));
  $('#scSearch').hidden = t !== 'program';
  $('#scPickBtn').textContent = t === 'program' ? '列表中没？从电脑中选择程序'
    : t === 'file' ? '从电脑中选择文件' : '从电脑中选择文件夹';
  $('#scPickHint').textContent = t === 'program' ? '可以选择 exe 或快捷方式' : '';
  renderScList();
}
function renderScList() {
  const box = $('#scList');
  if (scTab !== 'program') {
    box.innerHTML = `<div class="empty-tip">${scTab === 'file' ? '点下方按钮从电脑中选择文件' : '点下方按钮从电脑中选择文件夹'}</div>`;
    return;
  }
  if (!scPrograms) return;
  const q = scQuery.trim().toLowerCase();
  const added = new Set(scItems.map(x => x.path));
  // 名称包含 或 拼音首字母包含（如"微信"输入 wx）
  const list = scPrograms.filter(p => !q || p.name.toLowerCase().includes(q) || (p.py && p.py.includes(q)));
  if (!list.length) { box.innerHTML = '<div class="empty-tip">没有找到匹配的程序</div>'; return; }
  let html = '', group = '';
  for (const p of list) {
    if (p.initial !== group) { group = p.initial; html += `<div class="sc-group">${group}</div>`; }
    const on = added.has(p.path);
    html += `<div class="sc-row${on ? ' added' : ''}" data-p="${escapeHtml(p.path)}">
      ${shortcutIconHtml({ ...p, type: 'app' }, 'sc-row-icon')}
      <span class="sc-row-name">${escapeHtml(p.name)}</span>
      <span class="sc-row-act">${on ? '✓' : '＋'}</span></div>`;
  }
  box.innerHTML = html;
  box.querySelectorAll('.sc-row').forEach(row => row.addEventListener('click', async () => {
    if (row.classList.contains('added')) return;
    renderShortcuts(await window.island.scAdd([row.dataset.p])); // 主页网格 + 计数
    renderScStrip();
    row.classList.add('added');
    row.querySelector('.sc-row-act').textContent = '✓';
  }));
}
$('#btnScAdd').addEventListener('click', openScModal);
$('#scModalClose').addEventListener('click', () => { $('#scModal').hidden = true; });
$('#scModal').addEventListener('mousedown', (e) => { if (e.target.id === 'scModal') $('#scModal').hidden = true; });
$$('#scModalTabs .mt-btn').forEach(b => b.addEventListener('click', () => setScTab(b.dataset.mt)));
$('#scSearch').addEventListener('input', (e) => { scQuery = e.target.value; renderScList(); });
$('#scPickBtn').addEventListener('click', async () => {
  renderShortcuts(await window.island.scPick(scTab === 'program' ? 'app' : scTab));
  renderScStrip();
  renderScList();
});

// ---------- 便签（层叠 / 网格 / 列表 三种显示方式） ----------
const noteTitle = (t) => { const s = (t || '').trim(); return s.length > 40 ? s.slice(0, 40) + '…' : (s || '（空便签）'); };
const noteDate = (ts) => { const d = new Date(ts); return `${d.getMonth() + 1}月${d.getDate()}日`; };
let listEditId = null; // 列表模式下正在编辑的便签

async function loadNotes() { renderNotes(await window.island.notesList()); }
function noteCardHtml(n, extraCls = '') {
  return `
    <div class="note-card ${extraCls}" style="background:${n.color}">
      <div class="note-tools">
        <input type="color" class="note-color" value="${n.color}" data-color="${n.id}" title="更换颜色">
        <button class="del" data-del="${n.id}" title="删除">✕</button>
      </div>
      <textarea data-id="${n.id}" placeholder="输入便签内容">${escapeHtml(n.text)}</textarea>
      <div class="note-date">${noteDate(n.ts)}</div>
    </div>`;
}
function bindNoteEditors(wrap) {
  wrap.querySelectorAll('textarea').forEach(t => t.addEventListener('change', async () => {
    await window.island.notesUpdate(Number(t.dataset.id), t.value);
    if ((state.settings.noteLayout || 'grid') === 'list') { listEditId = null; renderNotes(await window.island.notesList()); }
  }));
  wrap.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () =>
    renderNotes(await window.island.notesDelete(Number(b.dataset.del)))));
  // 用 change 而非 input：取色器关闭后再重绘，避免选择过程中 DOM 被重建
  wrap.querySelectorAll('[data-color]').forEach(c => c.addEventListener('change', async () =>
    renderNotes(await window.island.notesSetColor(Number(c.dataset.color), c.value))));
}
function renderNotes(notes) {
  const wrap = $('#notesGrid');
  const layout = state.settings.noteLayout || 'grid';
  wrap.className = 'notes-grid mode-' + layout;
  $('#notesCount').textContent = `便签 ${notes.length}`;
  $$('#notesSwitch .sw-btn').forEach(b => b.classList.toggle('active', b.dataset.layout === layout));
  if (!notes.length) { wrap.innerHTML = '<div class="empty-tip">暂无便签</div>'; return; }

  if (layout === 'list') {
    wrap.innerHTML = notes.map(n => n.id === listEditId ? noteCardHtml(n) : `
      <div class="note-row" data-open="${n.id}">
        <span class="dot" style="background:${n.color}"></span>
        <span class="nt">${escapeHtml(noteTitle(n.text))}</span>
        <span class="nd">${noteDate(n.ts)}</span>
      </div>`).join('');
    wrap.querySelectorAll('[data-open]').forEach(r => r.addEventListener('click', () => {
      listEditId = Number(r.dataset.open); renderNotes(notes);
    }));
  } else if (layout === 'stack') {
    const rest = notes.slice(1, 8); // 最多 7 条叠层
    const stripH = 32, frontH = 300;
    wrap.innerHTML = `
      <div class="stack-box" style="height:${rest.length * stripH + frontH}px">
        ${rest.map((n, i) => `
          <div class="stack-strip" data-bring="${n.id}" style="top:${i * stripH}px; z-index:${i + 1}; background:${n.color}">
            <span class="nt">${escapeHtml(noteTitle(n.text))}</span>
            <span class="nd">${noteDate(n.ts)}</span>
          </div>`).join('')}
        <div class="stack-front-wrap" style="top:${rest.length * stripH}px; height:${frontH}px; z-index:20">
          ${noteCardHtml(notes[0], 'stack-front')}
        </div>
      </div>`;
    wrap.querySelectorAll('[data-bring]').forEach(s => s.addEventListener('click', async () =>
      renderNotes(await window.island.notesTop(Number(s.dataset.bring)))));
  } else {
    wrap.innerHTML = notes.map(n => noteCardHtml(n)).join('');
  }
  bindNoteEditors(wrap);
}
// 显示方式切换（立即生效并记住选择）
$$('#notesSwitch .sw-btn').forEach(b => b.addEventListener('click', async () => {
  listEditId = null;
  state.settings.noteLayout = b.dataset.layout;
  await window.island.settingsSet({ noteLayout: b.dataset.layout });
  renderNotes(await window.island.notesList());
}));
async function addNote() {
  const v = $('#noteInput').value.trim();
  if (!v) return;
  const color = $('#noteColor').value || '#ffd166';
  $('#noteInput').value = '';
  renderNotes(await window.island.notesAdd(v, color));
}
$('#btnNoteAdd').addEventListener('click', addNote);
$('#noteInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') addNote(); });

// ---------- 剪贴板 ----------
async function loadClip() { renderClip(await window.island.clipList()); }
function renderClip(list) {
  const el = $('#clipList');
  if (!list.length) { el.innerHTML = '<li class="empty-tip">暂无剪贴板记录</li>'; return; }
  el.innerHTML = list.map((c, i) => c.type === 'text'
    ? `<li class="clip-item" data-i="${i}">${escapeHtml(c.text.slice(0, 200))}<div class="ct">${fmtTime(c.ts)}</div></li>`
    : `<li class="clip-item" data-i="${i}"><img src="${islandUrl(c.path)}"><div class="ct">图片 · ${fmtTime(c.ts)}</div></li>`
  ).join('');
  el.querySelectorAll('.clip-item').forEach(it => it.addEventListener('click', () =>
    window.island.clipCopy(list[Number(it.dataset.i)])));
}
$('#btnClipClear').addEventListener('click', async () => renderClip(await window.island.clipClear()));
window.island.onClip((list) => { if ($('#tab-clip').classList.contains('active')) renderClip(list); });

// ---------- 音乐 ----------
const audio = $('#audioEl');
const PLATFORMS = [
  ['网易云音乐', 'https://music.163.com'],
  ['QQ音乐', 'https://y.qq.com'],
  ['酷狗音乐', 'https://www.kugou.com'],
  ['酷我音乐', 'https://www.kuwo.cn'],
  ['汽水音乐', 'https://music.douyin.com'],
  ['Apple Music', 'https://music.apple.com'],
  ['Spotify', 'https://open.spotify.com'],
  ['B站音乐', 'https://www.bilibili.com/v/music'],
];
$('#platformRow').innerHTML = PLATFORMS.map(([n, u]) =>
  `<button class="mini-btn" data-url="${u}">${n}</button>`).join('');
$('#platformRow').querySelectorAll('[data-url]').forEach(b =>
  b.addEventListener('click', () => window.island.musicOpenUrl(b.dataset.url)));

// 播放列表持久化在主进程 music.json，重启不丢
async function loadMusic() { state.music.files = await window.island.musicList(); renderMusic(); }
$('#btnPickMusic').addEventListener('click', async () => {
  state.music.files = await window.island.musicAddFolder();
  renderMusic();
});
$('#btnAddMusicFiles').addEventListener('click', async () => {
  state.music.files = await window.island.musicAddFiles();
  renderMusic();
});
$('#btnClearMusic').addEventListener('click', async () => {
  state.music.files = await window.island.musicClear();
  stopPlayback();
  renderMusic();
});
function stopPlayback() {
  state.music.idx = -1;
  state.music.lyric = [];
  state.music.offset = 0;
  audio.pause(); audio.removeAttribute('src');
  $('#playerTitle').textContent = '未播放';
  renderSync();
  updatePillLyric();
}
function renderMusic() {
  const el = $('#musicList');
  if (!state.music.files.length) { el.innerHTML = '<div class="empty-tip">播放列表为空，可添加文件或整个文件夹（重启后保留）</div>'; return; }
  el.innerHTML = state.music.files.map((f, i) => `
    <li class="file-item ${i === state.music.idx ? 'playing' : ''}">
      <span>${i === state.music.idx && !audio.paused ? '🔊' : '🎵'}</span>
      <span class="fn" data-play="${i}" title="点击播放">${escapeHtml(f.name)}</span>
      <button class="mini-btn" data-rm="${i}" title="从列表移除">✕</button></li>`).join('');
  el.querySelectorAll('[data-play]').forEach(b => b.addEventListener('click', () => playIdx(Number(b.dataset.play))));
  el.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', async () => {
    const i = Number(b.dataset.rm);
    state.music.files = await window.island.musicRemove(i);
    if (state.music.idx === i) stopPlayback();
    else if (state.music.idx > i) state.music.idx--;
    renderMusic();
  }));
}
function playIdx(i) {
  const m = state.music;
  if (!m.files[i]) return;
  m.idx = i;
  m.offset = 0;
  m.lyric = [];
  renderSync();
  audio.src = islandUrl(m.files[i].path);
  audio.play().catch(() => { $('#playerTitle').textContent = '无法播放：' + m.files[i].name; });
  $('#playerTitle').textContent = m.files[i].name;
  renderMusic();
  loadLyrics(m.files[i].path);
}

// 歌词同步微调：正数让歌词整体延后，负数提前（按歌曲记忆）
function renderSync() {
  const m = state.music;
  $('#lyricSync').hidden = !(m.idx >= 0 && m.lyric.length > 0);
  const v = Number(m.offset) || 0;
  $('#lyricOffset').textContent = (v > 0 ? '+' : '') + v.toFixed(1) + 's';
}
async function adjustLyricOffset(delta, reset = false) {
  const m = state.music;
  const f = m.files[m.idx];
  if (!f || !m.lyric.length) return;
  const v = reset ? 0 : Math.max(-30, Math.min(30, Math.round((m.offset + delta) * 10) / 10));
  m.offset = v;
  renderSync();
  updatePillLyric();
  try { await window.island.musicSetOffset({ path: f.path, offset: v }); } catch (e) {}
}

// 读取歌词：优先本地同名 .lrc，缺失时主进程在线检索；无歌词时灵动岛显示歌名
async function loadLyrics(filePath) {
  const m = state.music;
  m.lyric = [];
  try {
    const r = await window.island.musicLyrics(filePath);
    // 异步返回时可能已切歌，按路径校验
    if (m.files[m.idx] && m.files[m.idx].path === filePath) {
      m.lyric = (r && r.lines) || [];
      m.offset = Number(r && r.offset) || 0;
    }
  } catch (e) {}
  renderSync();
  updatePillLyric();
}
function lyricAt(t) {
  const m = state.music;
  const f = m.files[m.idx];
  if (!f) return '';
  const title = f.name.replace(/\.\w+$/, '');
  if (!m.lyric.length) return title;              // 无歌词 → 歌名
  const ct = t - (Number(m.offset) || 0);         // 微调后的对照时间
  let lo = 0, hi = m.lyric.length - 1, idx = -1;  // 二分找当前时间对应的歌词行
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (m.lyric[mid].t <= ct) { idx = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return idx >= 0 ? m.lyric[idx].text : title;    // 第一句之前也显示歌名
}
function updatePillLyric() {
  const m = state.music;
  const playing = m.idx >= 0 && !!m.files[m.idx] && !audio.paused;
  document.body.classList.toggle('playing', playing);
  if (!playing) {
    $('#pillLyric').textContent = '';
    $('#playerLyric').textContent = '';
    return;
  }
  const line = lyricAt(audio.currentTime);
  $('#pillLyric').textContent = line;
  $('#pillLyric').title = line;
  $('#playerLyric').textContent = m.lyric.length ? line : '暂无歌词';
}
$('#btnPlay').addEventListener('click', () => {
  if (audio.paused) { if (!audio.src && state.music.files.length) playIdx(0); else audio.play(); }
  else { audio.pause(); }
});
$('#btnLyricEarly').addEventListener('click', () => adjustLyricOffset(-0.5));
$('#btnLyricLate').addEventListener('click', () => adjustLyricOffset(0.5));
$('#lyricOffset').addEventListener('click', () => adjustLyricOffset(0, true));
$('#btnPrev').addEventListener('click', () => { const n = state.music.files.length; if (n) playIdx(((state.music.idx < 0 ? 0 : state.music.idx) - 1 + n) % n); });
$('#btnNext').addEventListener('click', () => { const n = state.music.files.length; if (n) playIdx((state.music.idx + 1) % n); });
audio.addEventListener('ended', () => $('#btnNext').click());
audio.addEventListener('timeupdate', () => {
  $('#curTime').textContent = fmtSec(audio.currentTime);
  $('#durTime').textContent = fmtSec(audio.duration || 0);
  if (audio.duration) $('#seekBar').value = (audio.currentTime / audio.duration) * 100;
  updatePillLyric();
});
audio.addEventListener('play', updatePillLyric);
audio.addEventListener('pause', updatePillLyric);
$('#seekBar').addEventListener('input', (e) => {
  if (audio.duration) audio.currentTime = (e.target.value / 100) * audio.duration;
});
audio.volume = 0.8;
$('#volBar').addEventListener('input', (e) => { audio.volume = e.target.value / 100; });
const fmtSec = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// ---------- 番茄钟 ----------
function renderPomo() {
  const t = state.pomo.left;
  $('#pomoTime').textContent = `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}
$('#btnPomoStart').addEventListener('click', () => {
  const p = state.pomo;
  if (p.timer) { clearInterval(p.timer); p.timer = null; $('#btnPomoStart').textContent = '开始'; return; }
  p.total = p.left = Math.max(1, Number($('#pomoMin').value)) * 60;
  $('#btnPomoStart').textContent = '暂停';
  p.timer = setInterval(() => {
    p.left--;
    renderPomo();
    if (p.left <= 0) {
      clearInterval(p.timer); p.timer = null;
      $('#btnPomoStart').textContent = '开始';
      window.island.notify('番茄钟', '时间到！休息一下吧');
      p.left = p.total; renderPomo();
    }
  }, 1000);
  renderPomo();
});
$('#btnPomoReset').addEventListener('click', () => {
  const p = state.pomo;
  clearInterval(p.timer); p.timer = null;
  $('#btnPomoStart').textContent = '开始';
  p.left = p.total = Math.max(1, Number($('#pomoMin').value)) * 60;
  renderPomo();
});

// ---------- 设置 ----------
async function loadSettings() {
  const s = await window.island.settingsGet();
  state.settings = s;
  $('#setName').value = s.deviceName || '';
  $('#setPort').value = s.tcpPort || 45700;
  $('#setMaxMB').value = s.maxFileMB || 2048;
  $('#setTheme').value = s.theme || 'dark';
  $('#setOpacity').value = s.opacity ?? 1;
  $('#setTop').checked = !!s.alwaysOnTop;
  $('#setAnim').checked = !!s.animations;
  $('#setEdgeHide').checked = s.edgeHide !== false;
  $('#setAutoCollapse').checked = s.autoCollapse !== false;
  $('#setNoteLayout').value = s.noteLayout || 'grid';
  $('#setShortcut').value = s.shortcut || '';
  $('#setAutoStart').checked = !!s.autoStart;
  $('#setHwAccel').checked = !!s.hardwareAccel;
  $('#setLowMem').checked = !!s.lowMemoryMode;
  $('#aboutVer').textContent = 'v' + (state.version || '?');
}

// ---------- 自动更新 ----------
function renderUpdate(s) {
  const tip = $('#updateTip'), btn = $('#btnUpdateCheck');
  const map = {
    idle: '启动后自动检查',
    checking: '正在检查更新…',
    available: `发现新版本 v${s.version}`,
    downloading: `正在下载 ${s.percent || 0}%`,
    downloaded: `v${s.version} 已就绪`,
    none: '已是最新版本',
    error: '检查失败：' + (s.message || '网络错误'),
  };
  tip.textContent = map[s.status] || '';
  if (s.status === 'available') {
    btn.textContent = '下载更新'; btn.disabled = false;
    btn.onclick = () => { btn.disabled = true; window.island.updateDownload(); };
  } else if (s.status === 'downloaded') {
    btn.textContent = '重启安装'; btn.disabled = false;
    btn.onclick = () => window.island.updateInstall();
  } else {
    btn.textContent = '检查更新';
    btn.disabled = s.status === 'checking' || s.status === 'downloading';
    btn.onclick = () => window.island.updateCheck();
  }
}
window.island.onUpdateStatus(renderUpdate);
window.island.updateState().then(renderUpdate).catch(() => {});
$('#btnSaveSettings').addEventListener('click', async () => {
  const patch = {
    deviceName: $('#setName').value.trim(),
    tcpPort: Number($('#setPort').value),
    maxFileMB: Number($('#setMaxMB').value),
    theme: $('#setTheme').value,
    opacity: Number($('#setOpacity').value),
    alwaysOnTop: $('#setTop').checked,
    animations: $('#setAnim').checked,
    edgeHide: $('#setEdgeHide').checked,
    autoCollapse: $('#setAutoCollapse').checked,
    noteLayout: $('#setNoteLayout').value,
    shortcut: $('#setShortcut').value.trim(),
    autoStart: $('#setAutoStart').checked,
    hardwareAccel: $('#setHwAccel').checked,
    lowMemoryMode: $('#setLowMem').checked,
  };
  await window.island.settingsSet(patch);
  state.settings = { ...state.settings, ...patch };
  applySettings(patch);
  if ($('#tab-notes').classList.contains('active')) loadNotes();
  $('#saveTip').textContent = '已保存（端口/硬件加速需重启生效）';
  setTimeout(() => $('#saveTip').textContent = '', 2500);
});
function applySettings(s) {
  if ('theme' in s) document.body.classList.toggle('light', s.theme === 'light');
  if ('lowMemoryMode' in s) document.body.classList.toggle('low-mem', !!s.lowMemoryMode);
  // Windows 透明分层窗口上 win.setOpacity 无效，改用 body 不透明度
  if (s.opacity != null) document.body.style.opacity = s.opacity;
}
// 不透明度滑条：拖动时实时预览（点保存后才持久化）
$('#setOpacity').addEventListener('input', (e) => { document.body.style.opacity = Number(e.target.value); });
$('#btnMemRefresh').addEventListener('click', tickMem);
$('#btnMemGc').addEventListener('click', async () => { await window.island.memGc(); setTimeout(tickMem, 500); });
$('#btnQuit').addEventListener('click', () => window.island.quit());

// ---------- 局域网事件 ----------
window.island.onPeers((list) => { state.peers = list; renderPeers(); });
window.island.onMessage(async (msg) => {
  state.unread++;
  renderBadge();
  state.historyPeers = await window.island.chatAllPeers();
  renderPeers();
  if (state.currentPeer && msg.fromId === state.currentPeer.id) {
    appendMsg(msg);
  }
});
window.island.onProgress((p) => {
  if (p.total) $('#chatTitle').textContent =
    `${p.dir === 'in' ? '接收' : '发送'} ${p.name}：${Math.round(p.received / p.total * 100)}%`;
});

// ---------- Agent 状态（TRAE / WorkBuddy） ----------
const AGENT_LABEL = { working: '正在工作', done: '工作完成', waiting: '等待批准', idle: '空闲' };
function renderAgents(s) {
  const items = [['TRAE', 'trae'], ['WorkBuddy', 'workbuddy']]
    .filter(([, k]) => s && s[k] && s[k].running !== false);
  const line = $('#agentLine');
  if (!items.length) {
    line.hidden = true;
    line.innerHTML = '';
  } else {
    line.hidden = false;
    line.innerHTML = items.map(([name, k]) => {
      const st = AGENT_LABEL[s[k].state] ? s[k].state : 'idle';
      return `<span class="agent-chip" title="${name} · ${AGENT_LABEL[st]}"><i class="agent-dot ${st}"></i>` +
        `<span class="agent-name">${name}</span>${AGENT_LABEL[st]}</span>`;
    }).join('');
  }
  // 胶囊空间小：圆点 + 名称 + 简短状态；播放歌词时 CSS 只保留圆点
  const AGENT_SHORT = { working: '工作', done: '完成', waiting: '待批', idle: '空闲' };
  const pa = $('#pillAgents');
  pa.innerHTML = items.map(([name, k]) => {
    const st = AGENT_LABEL[s[k].state] ? s[k].state : 'idle';
    return `<span class="pill-agent" title="${name} · ${AGENT_LABEL[st]}"><i class="agent-dot ${st}"></i>` +
      `<span class="pill-agent-name">${name}</span><span class="pill-agent-st">${AGENT_SHORT[st]}</span></span>`;
  }).join('');
  pa.hidden = !items.length;
}
window.island.onAgentStatus(renderAgents);

// ---------- 启动 ----------
(async function init() {
  const boot = await window.island.bootstrap();
  state.peers = boot.peers;
  state.expanded = boot.expanded;
  state.settings = boot.settings;
  state.historyPeers = await window.island.chatAllPeers();
  state.version = boot.version;
  $('#headDevice').textContent = boot.deviceName;
  applySettings(boot.settings);
  renderExpanded();
  renderPeers();
  renderPomo();
  loadMusic();
  loadShortcuts();
  tickClock();
  tickMem();
  window.island.agentStatus().then(renderAgents).catch(() => {});
})();

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
