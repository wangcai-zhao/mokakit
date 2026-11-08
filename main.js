// 内网灵动岛 - 主进程
const {
  app, BrowserWindow, ipcMain, Tray, Menu, nativeImage,
  globalShortcut, clipboard, screen, shell, Notification, dialog, protocol, net,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const Store = require('./store');
const { LanService } = require('./lan');

// 自定义协议特权：stream 使 <audio>/<video> 的 Range 请求可用（本地音乐播放必需）
protocol.registerSchemesAsPrivileged([
  { scheme: 'island', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true, corsEnabled: true } },
]);

// ---------- 参数与存储 ----------
const argvPort = Number(process.env.ISLAND_PORT) || 0;
// 同机多实例测试时用 ISLAND_DATA 指定独立数据目录，避免共享 settings.json 抢占端口
if (process.env.ISLAND_DATA) app.setPath('userData', path.resolve(process.env.ISLAND_DATA));
// 应用更名 lan-island -> mokakit：迁移旧数据 JSON（设置/便签/歌单/歌词缓存等）。
// 不能按目录存在判断——Electron 启动早期就会创建 userData 目录，故按「旧文件存在且新目录没有同名文件」逐个复制
if (!process.env.ISLAND_DATA) {
  const legacyDir = path.join(app.getPath('appData'), 'lan-island');
  const curDir = app.getPath('userData');
  try {
    if (fs.existsSync(legacyDir)) {
      fs.mkdirSync(curDir, { recursive: true });
      for (const f of fs.readdirSync(legacyDir)) {
        if (!f.endsWith('.json')) continue;
        const src = path.join(legacyDir, f), dst = path.join(curDir, f);
        if (!fs.existsSync(dst)) fs.copyFileSync(src, dst);
      }
    }
  } catch (e) { /* 迁移失败不致命 */ }
}
const userDir = app.getPath('userData');
const store = new Store(path.join(userDir, 'settings.json'), {
  deviceName: require('os').hostname(),
  tcpPort: argvPort || 45700,
  theme: 'dark',            // dark | light
  opacity: 1,               // 窗口不透明度
  alwaysOnTop: true,
  animations: true,
  edgeHide: true,           // 贴边后鼠标离开自动收缩隐藏
  autoCollapse: true,       // 展开后鼠标离开自动收起
  noteLayout: 'grid',       // 便签显示方式 grid | list
  shortcut: 'Ctrl+Shift+Space',
  maxFileMB: 2048,
  lowMemoryMode: false,
  hardwareAccel: true,
  autoStart: false,
});
const stagingStore = new Store(path.join(userDir, 'staging.json'), { files: [] });
const notesStore = new Store(path.join(userDir, 'notes.json'), { notes: [] });
const historyStore = new Store(path.join(userDir, 'history.json'), { chats: {}, clip: [] });
const musicStore = new Store(path.join(userDir, 'music.json'), { playlist: [] });
const scStore = new Store(path.join(userDir, 'shortcuts.json'), { items: [] });
const iconStore = new Store(path.join(userDir, 'scicons.json'), { map: {} }); // 程序图标缓存
const lyricStore = new Store(path.join(userDir, 'lyrics.json'), { map: {} }); // 在线歌词缓存
// 歌词匹配算法升级后清空旧缓存，避免继续使用匹配错误的歌词
if (lyricStore.get('ver') !== 2) {
  lyricStore.set('map', {});
  lyricStore.set('ver', 2);
}
const downloadDir = path.join(userDir, 'received');
const clipImgDir = path.join(userDir, 'clipboard');
const pasteTmpDir = path.join(userDir, 'paste-tmp');

if (!store.get('hardwareAccel')) app.disableHardwareAcceleration();

let win = null;
let tray = null;
let lan = null;
let expanded = false;
let dragInfo = null;        // 窗口拖动状态 {offX, offY}
let lastTypePing = 0;       // 渲染层上报的最近打字时间
let modalOpen = false;      // 系统文件对话框打开中（暂停自动收起/收缩）
let outsideSince = 0;       // 光标持续在窗外的起始时间
let clipTimer = null;
let lastClipText = '';
let lastClipImgSize = 0;

// ---------- 窗口尺寸（灵动岛胶囊 <-> 展开面板） ----------
const PILL = { w: 340, h: 56 };
const PANEL = { w: 480, h: 700 };

function centerBounds(w, h) {
  const disp = screen.getPrimaryDisplay().workAreaSize;
  return { x: Math.round((disp.width - w) / 2), y: 0, width: w, height: h };
}

/** 启动时优先恢复用户上次拖到的位置，越界则回落到顶部居中 */
function initialBounds() {
  const def = centerBounds(PILL.w, PILL.h);
  const x = store.get('islandX');
  const y = store.get('islandY');
  if (!Number.isFinite(x) || !Number.isFinite(y)) return def;
  const visible = screen.getAllDisplays().some(d => {
    const b = d.workArea;
    return x + PILL.w > b.x + 40 && x < b.x + b.width - 40 &&
      y + PILL.h > b.y + 10 && y < b.y + b.height - 20;
  });
  return visible ? { ...def, x, y } : def;
}

/** 展开/收起时保持胶囊中心点不动，避免窗口跳到屏幕中央 */
function expandTarget(isExpand) {
  const cur = win.getBounds();
  const cx = cur.x + cur.width / 2;
  const targetW = isExpand ? PANEL.w : PILL.w;
  const targetH = isExpand ? PANEL.h : PILL.h;
  let x = Math.round(cx - targetW / 2);
  let y = cur.y;
  const area = screen.getDisplayMatching(cur).workArea;
  x = Math.min(Math.max(x, area.x), area.x + area.width - targetW);
  y = Math.min(Math.max(y, area.y), area.y + area.height - 80);
  return { x, y, width: targetW, height: targetH };
}

function animateResize(target) {
  if (!win) return;
  if (!store.get('animations')) { win.setBounds(target); return; }
  const start = win.getBounds();
  const steps = 8;
  let i = 0;
  const timer = setInterval(() => {
    i++;
    const t = i / steps;
    const ease = 1 - Math.pow(1 - t, 3);
    win.setBounds({
      x: Math.round(start.x + (target.x - start.x) * ease),
      y: Math.round(start.y + (target.y - start.y) * ease),
      width: Math.round(start.width + (target.width - start.width) * ease),
      height: Math.round(start.height + (target.height - start.height) * ease),
    });
    if (i >= steps) clearInterval(timer);
  }, 16);
}

let edgeHidden = null; // {edge, bounds} | null

/** 判断窗口是否贴近某块屏幕边缘（8px 内），返回 {edge, area} 或 null */
function edgeOf(b) {
  const area = screen.getDisplayMatching(b).workArea;
  const d = {
    left: Math.abs(b.x - area.x),
    right: Math.abs(area.x + area.width - (b.x + b.width)),
    top: Math.abs(b.y - area.y),
    bottom: Math.abs(area.y + area.height - (b.y + b.height)),
  };
  const edge = Object.keys(d).reduce((a, k) => (d[k] < d[a] ? k : a), 'left');
  return d[edge] <= 8 ? { edge, area } : null;
}

/** 收缩隐藏：窗口整体移出屏幕、只留 5px 细条在边缘内（OS 有最小窗口高度，不能真缩成 5px） */
function stripBounds(b, edge, area) {
  const V = 5; // 露出的像素
  if (edge === 'left') return { x: area.x - (b.width - V), y: b.y, width: b.width, height: b.height };
  if (edge === 'right') return { x: area.x + area.width - V, y: b.y, width: b.width, height: b.height };
  if (edge === 'top') return { x: b.x, y: area.y - (b.height - V), width: b.width, height: b.height };
  return { x: b.x, y: area.y + area.height - V, width: b.width, height: b.height };
}

/** 返回窗口距离最近的屏幕边缘（用于贴边收缩），不再要求 8px 内 —— 即使岛在屏幕中间也能收缩隐藏 */
function nearestEdge(b) {
  const area = screen.getDisplayMatching(b).workArea;
  const d = {
    left: Math.abs(b.x - area.x),
    right: Math.abs(area.x + area.width - (b.x + b.width)),
    top: Math.abs(b.y - area.y),
    bottom: Math.abs(area.y + area.height - (b.y + b.height)),
  };
  const edge = Object.keys(d).reduce((a, k) => (d[k] < d[a] ? k : a), 'left');
  return { edge, area };
}

/** 鼠标离开后收缩成细条（向最近边缘移出屏幕，只露 5px）；hover 细条恢复原位 */
function hideAtEdge() {
  if (!win || expanded || dragInfo || edgeHidden || !store.get('edgeHide')) return;
  const b = win.getBounds();
  const hit = nearestEdge(b);
  // 先把贴边方向对齐到 0 距离，保证细条 ⊂ 恢复后的胶囊
  const sb = { ...b };
  if (hit.edge === 'top') sb.y = hit.area.y;
  else if (hit.edge === 'bottom') sb.y = hit.area.y + hit.area.height - b.height;
  else if (hit.edge === 'left') sb.x = hit.area.x;
  else sb.x = hit.area.x + hit.area.width - b.width;
  edgeHidden = { edge: hit.edge, bounds: sb };
  win.webContents.send('ui:edgeHidden', hit.edge);
  animateResize(stripBounds(sb, hit.edge, hit.area));
}

function unhideEdge(instant = false) {
  if (!win || !edgeHidden) return;
  const b = edgeHidden.bounds;
  edgeHidden = null;
  win.webContents.send('ui:edgeHidden', null);
  if (instant) win.setBounds(b); else animateResize(b);
}

/** 光标轮询：驱动自动收起与贴边收缩（比渲染层 mouseenter/leave 可靠，不会丢事件） */
function startCursorWatch() {
  const tick = () => {
    setTimeout(tick, store.get('lowMemoryMode') ? 1000 : 300);
    if (!win || dragInfo || modalOpen) return;
    const now = Date.now();
    const c = screen.getCursorScreenPoint();
    const b = win.getBounds();
    const inside = c.x >= b.x && c.x < b.x + b.width && c.y >= b.y && c.y < b.y + b.height;
    if (edgeHidden) {              // 收缩态：光标碰到露出的细条即复原
      if (inside) unhideEdge();
      return;
    }
    if (inside) { outsideSince = 0; return; }
    if (!outsideSince) outsideSince = now;
    const dt = now - outsideSince;
    if (expanded) {
      const typing = now - lastTypePing < 4000; // 打字中不收起
      if (store.get('autoCollapse') && !typing && dt > 700) {
        outsideSince = 0;
        setExpanded(false);
      }
    } else if (store.get('edgeHide') && dt > 1200) {
      outsideSince = 0;
      hideAtEdge();
    }
  };
  tick();
}

function setExpanded(v) {
  if (v === expanded) return;
  if (v && edgeHidden) unhideEdge(true); // 收缩态先复原胶囊再展开
  expanded = v;
  animateResize(expandTarget(v));
  win.webContents.send('ui:expanded', v);
}

// ---------- 托盘图标（运行时生成位图，无需外部资源） ----------
function makeTrayImage() {
  const S = 16;
  const buf = Buffer.alloc(S * S * 4);
  const cx = S / 2, cy = S / 2, r = 6;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const d = Math.hypot(x - cx + 0.5, y - cy + 0.5);
      if (d <= r) { buf[i] = 60; buf[i + 1] = 140; buf[i + 2] = 255; buf[i + 3] = 255; }
    }
  }
  return nativeImage.createFromBitmap(buf, { width: S, height: S });
}

// ---------- 创建窗口 ----------
function createWindow() {
  win = new BrowserWindow({
    ...initialBounds(),
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: store.get('alwaysOnTop'),
    skipTaskbar: true,
    show: false,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.setOpacity(store.get('opacity'));
  win.setMenu(null);
  win.on('closed', () => { win = null; });
  win.once('ready-to-show', () => win.show());
}

function createTray() {
  tray = new Tray(makeTrayImage());
  tray.setToolTip('内网灵动岛');
  const menu = Menu.buildFromTemplate([
    { label: '展开 / 收起', click: () => setExpanded(!expanded) },
    { label: '打开接收目录', click: () => shell.openPath(downloadDir) },
    { type: 'separator' },
    { label: '退出', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => setExpanded(!expanded));
}

// ---------- 局域网服务 ----------
function startLan() {
  lan = new LanService({
    tcpPort: argvPort || store.get('tcpPort'),
    name: store.get('deviceName'),
    downloadDir,
    maxFileMB: store.get('maxFileMB'),
  });
  lan.on('peers', (list) => win && win.webContents.send('lan:peers', list));
  lan.on('message', (msg) => {
    pushHistory(msg.fromId || 'unknown', msg.fromName || '对方', { ...msg, dir: 'in' });
    if (msg.kind !== 'text') addRecentFile(msg);
    if (win) win.webContents.send('lan:message', { ...msg, dir: 'in' });
    if (!expanded || (win && !win.isFocused())) {
      new Notification({
        title: `来自 ${msg.fromName || '设备'} 的消息`,
        body: msg.kind === 'text' ? String(msg.text).slice(0, 80) : `收到${msg.kind === 'image' ? '图片' : '文件'}：${msg.name}`,
      }).show();
    }
  });
  lan.on('progress', (p) => win && win.webContents.send('lan:progress', p));
  lan.on('error', (e) => console.error('lan error:', e.message));
  lan.start();
}

function pushHistory(peerId, peerName, msg) {
  const chats = historyStore.get('chats', {});
  const key = peerId || 'unknown';
  if (!chats[key]) chats[key] = { peerName, msgs: [] };
  chats[key].peerName = peerName;
  chats[key].msgs.push(msg);
  if (chats[key].msgs.length > 200) chats[key].msgs = chats[key].msgs.slice(-200);
  historyStore.set('chats', chats);
}

function addRecentFile(msg) {
  const recent = stagingStore.get('recent', []);
  recent.unshift({ name: msg.name, path: msg.path, size: msg.size, ts: msg.ts, kind: msg.kind });
  stagingStore.set('recent', recent.slice(0, 50));
}

// ---------- 剪贴板监听（最近复制） ----------
function startClipboardWatch() {
  const interval = store.get('lowMemoryMode') ? 2000 : 800;
  clipTimer = setInterval(() => {
    try {
      const t = clipboard.readText();
      if (t && t !== lastClipText) {
        lastClipText = t;
        addClip({ type: 'text', text: t.slice(0, 5000), ts: Date.now() });
      }
      const img = clipboard.readImage();
      if (!img.isEmpty()) {
        const sz = img.getSize();
        const sig = sz.width * 100000 + sz.height;
        if (sig !== lastClipImgSize) {
          lastClipImgSize = sig;
          fs.mkdirSync(clipImgDir, { recursive: true });
          const p = path.join(clipImgDir, `clip_${Date.now()}.png`);
          fs.writeFileSync(p, img.toPNG());
          addClip({ type: 'image', path: p, ts: Date.now() });
        }
      }
    } catch (e) {}
  }, interval);
}

function addClip(item) {
  const clip = historyStore.get('clip', []);
  // 文本去重
  if (item.type === 'text' && clip[0] && clip[0].text === item.text) return;
  clip.unshift(item);
  historyStore.set('clip', clip.slice(0, 30));
  if (win) win.webContents.send('clip:update', historyStore.get('clip', []));
}

// ---------- 歌词解析 ----------
const LRC_RE = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
// 网易云歌词开头常带创作人员信息，这些行不作为歌词显示
const LRC_CREDIT_RE = /^(作词|作曲|编曲|演唱|专辑|制作人?|监制|录音|混音|母带|出品|发行|统筹|策划|和声|吉他|贝斯|键盘|鼓|弦乐|音乐总监|版权|词|曲)\s*[:：]/;

/** 解析 LRC 文本为 [{t, text}]，支持一行多个时间标签 */
function parseLrc(text) {
  const lines = [];
  for (const raw of text.split(/\r?\n/)) {
    LRC_RE.lastIndex = 0;
    const tags = [];
    let m, last = 0;
    while ((m = LRC_RE.exec(raw))) { tags.push(m.slice(1)); last = LRC_RE.lastIndex; }
    const content = raw.slice(last).trim();
    if (!tags.length || !content || LRC_CREDIT_RE.test(content)) continue;
    if (/^[^:：]{1,8}[:：]$/.test(content)) continue; // “李健：”这类演唱者分段标记
    for (const t of tags) {
      const frac = t[2] ? Number('0.' + t[2].padEnd(3, '0')) : 0;
      lines.push({ t: Number(t[0]) * 60 + Number(t[1]) + frac, text: content });
    }
  }
  return lines.sort((a, b) => a.t - b.t);
}

/** 把文件名整理成适合搜索的歌曲名（去掉括号说明、分隔符等噪音） */
function lyricQuery(base) {
  return base
    .replace(/[（(\[【][^）)\]】]*[）)\]】]/g, ' ')
    .replace(/[+&_、/]+/g, ' ')
    .replace(/\s*-\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || base;
}

async function netJson(url, timeout = 5000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  try {
    const res = await net.fetch(url, {
      signal: ac.signal,
      headers: {
        Referer: 'https://music.163.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      },
    });
    return res.ok ? await res.json() : null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const simKey = (s) => String(s).toLowerCase().replace(/[\s\-_+&()（）\[\]【】/、,，.。:：'"]/g, '');

/** 双字组相似度（0~1），用于把搜索结果和文件名对齐 */
function simScore(a, b) {
  const A = [], B = [];
  const x = simKey(a), y = simKey(b);
  for (let i = 0; i + 1 < x.length; i++) A.push(x.slice(i, i + 2));
  for (let i = 0; i + 1 < y.length; i++) B.push(y.slice(i, i + 2));
  if (!A.length || !B.length) return 0;
  const m = new Map();
  for (const k of B) m.set(k, (m.get(k) || 0) + 1);
  let hit = 0;
  for (const k of A) {
    const n = m.get(k);
    if (n) { hit++; m.set(k, n - 1); }
  }
  return (2 * hit) / (A.length + B.length);
}

/** 多个检索词：完整、去掉尾部歌手名、标题段 —— 避免歌手名干扰选出错误的翻唱版本 */
function lyricQueries(base) {
  const out = [];
  const push = (q) => { const v = lyricQuery(q); if (v && !out.includes(v)) out.push(v); };
  push(base);
  const toks = lyricQuery(base).split(' ').filter(Boolean);
  if (toks.length >= 4) push(toks.slice(0, -2).join(' '));
  const seg = base.split(/-+|—|_/).map((s) => s.trim()).filter(Boolean);
  if (seg.length >= 2) push(seg.slice(0, 2).join(' '));
  return out.slice(0, 3);
}

/** 本地没有 .lrc 时，按歌曲名在线检索歌词（网易云公开接口），按相似度择优，失败返回空 */
async function fetchOnlineLyrics(base) {
  const found = new Map();
  for (const q of lyricQueries(base)) {
    const search = await netJson(`https://music.163.com/api/search/get/web?s=${encodeURIComponent(q)}&type=1&offset=0&limit=8`);
    for (const s of (search && search.result && search.result.songs) || []) {
      if (!found.has(s.id)) found.set(s.id, s);
    }
  }
  const wantLive = /live|现场/i.test(base);
  const cands = [...found.values()].map((s) => {
    const artists = (s.artists || []).map((a) => a.name).join(' ');
    let score = simScore(base, `${s.name} ${artists}`);
    if (wantLive && /live|现场/i.test(s.name)) score += 0.15;   // 文件名带 Live 时优先现场版
    return { id: s.id, score };
  }).sort((a, b) => b.score - a.score);
  for (const c of cands.slice(0, 3)) {
    const l = await netJson(`https://music.163.com/api/song/lyric?id=${c.id}&lv=1&kv=1&tv=-1`);
    const lines = parseLrc((l && l.lrc && l.lrc.lyric) || '');
    if (lines.length >= 3) return lines;
  }
  return [];
}

// ---------- Agent 状态（TRAE / WorkBuddy） ----------
const TRAE_EVENT_DIR = path.join(require('os').homedir(), '.trae-cn', 'hub_event_cache', 'TraeCode');
const WB_DIR = path.join(require('os').homedir(), '.workbuddy');
let agentTimer = null;
let lastAgentJson = '';

/** TRAE：读取最新会话事件流。事件流在推理过程中会长时间静默，不能只按 mtime 判空闲 */
function traeStatus() {
  try {
    if (!fs.existsSync(TRAE_EVENT_DIR)) return { state: 'idle', running: false };
    let newest = null;
    for (const d of fs.readdirSync(TRAE_EVENT_DIR, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const p = path.join(TRAE_EVENT_DIR, d.name);
      let names;
      try { names = fs.readdirSync(p); } catch (e) { continue; }
      for (const f of names) {
        if (!f.endsWith('.jsonl')) continue;
        const fp = path.join(p, f);
        try {
          const st = fs.statSync(fp);
          if (!newest || st.mtimeMs > newest.mtime) newest = { path: fp, mtime: st.mtimeMs };
        } catch (e) {}
      }
    }
    if (!newest) return { state: 'idle', running: true };
    let status = '', waiting = false, lastType = '';
    const lines = fs.readFileSync(newest.path, 'utf8').trim().split(/\r?\n/).slice(-60);
    for (const ln of lines) {
      try {
        const o = JSON.parse(ln);
        if (o.type) lastType = String(o.type);
        if (/approval|permission|confirm/i.test(String(o.type || ''))) waiting = true;
        let d = o.data;
        if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) {} }
        if (d && d.agent_status) {
          const s = String(d.agent_status.status || '');
          if (s) status = s;
          if (/waiting|approv|permission|confirm/i.test(s)) waiting = true;
        }
      } catch (e) {}
    }
    const silent = Date.now() - newest.mtime;
    if (waiting) return { state: 'waiting', running: true };
    // 回合结束标记（message_context_update / context_usage）刚写入 → 视为刚完成，保留 45 秒
    if (/message_context_update|context_usage/.test(lastType) && silent < 45000) return { state: 'done', running: true };
    // running 是长期状态，推理静默可达数分钟，30 分钟内都算正在工作
    if (/run|think|busy|exec|tool/i.test(status) && silent < 1800000) return { state: 'working', running: true };
    if (silent < 45000) return { state: 'done', running: true };
    return { state: 'idle', running: true };
  } catch (e) {
    return { state: 'idle', running: false };
  }
}

/** WorkBuddy：心跳文件判断进程是否运行；只有「最近发生的批准请求」才算等待批准；任务/审计流水近期写入 → 工作 */
function wbStatus() {
  try {
    if (!fs.existsSync(WB_DIR)) return { state: 'idle', running: false };
    let alive = false;
    const sd = path.join(WB_DIR, 'sessions');
    if (fs.existsSync(sd)) {
      for (const f of fs.readdirSync(sd)) {
        try { if (Date.now() - fs.statSync(path.join(sd, f)).mtimeMs < 60000) alive = true; } catch (e) {}
      }
    }
    if (!alive) return { state: 'idle', running: false };
    const now = Date.now();
    // mcp-approvals.json 记录的是「已发生过的批准」，只有 90 秒内的才算当前正在等待批准
    const ap = path.join(WB_DIR, 'mcp-approvals.json');
    try {
      if (fs.existsSync(ap) && now - fs.statSync(ap).mtimeMs < 90000) {
        const j = JSON.parse(fs.readFileSync(ap, 'utf8'));
        if (j && typeof j === 'object') {
          for (const v of Object.values(j)) {
            const t = typeof v === 'number' ? (v > 1e12 ? v : v * 1000) : Date.parse(v);
            if (t && now - t < 90000) return { state: 'waiting', running: true };
          }
        }
      }
    } catch (e) {}
    let last = 0;
    const touch = (p) => { try { const t = fs.statSync(p).mtimeMs; if (t > last) last = t; } catch (e) {} };
    const d = new Date();
    const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    // operation.log / daemon 日志是常驻后台写入，不代表 Agent 在工作，必须排除
    const conv = path.join(WB_DIR, 'logs', ymd, 'sdk', 'conversations');
    if (fs.existsSync(conv)) {
      for (const f of fs.readdirSync(conv)) {
        if (f.endsWith('.log') && f !== 'operation.log' && !f.includes('warning')) touch(path.join(conv, f));
      }
    }
    const tasks = path.join(WB_DIR, 'tasks');
    if (fs.existsSync(tasks)) {
      for (const s of fs.readdirSync(tasks)) {
        const p = path.join(tasks, s);
        try { if (!fs.statSync(p).isDirectory()) continue; } catch (e) { continue; }
        for (const f of fs.readdirSync(p)) if (f.endsWith('.json')) touch(path.join(p, f));
      }
    }
    const spool = path.join(WB_DIR, 'audit-log', 'spool');
    if (fs.existsSync(spool)) for (const f of fs.readdirSync(spool)) if (f.endsWith('.jsonl')) touch(path.join(spool, f));
    if (last && now - last < 12000) return { state: 'working', running: true };
    if (last && now - last < 45000) return { state: 'done', running: true };
    return { state: 'idle', running: true };
  } catch (e) {
    return { state: 'idle', running: false };
  }
}

function collectAgentStatus() {
  return { trae: traeStatus(), workbuddy: wbStatus() };
}

/** 轮询 Agent 状态并推送给渲染层（状态变化才发送，避免无谓 DOM 刷新） */
function startAgentWatch() {
  const tick = () => {
    agentTimer = setTimeout(tick, store.get('lowMemoryMode') ? 5000 : 2000);
    if (!win) return;
    const s = collectAgentStatus();
    const json = JSON.stringify(s);
    if (json === lastAgentJson) return;
    lastAgentJson = json;
    win.webContents.send('ui:agentStatus', s);
  };
  tick();
}

// ---------- IPC ----------
function setupIpc() {
  ipcMain.handle('app:bootstrap', () => ({
    settings: store.data,
    peers: lan ? lan.peerList() : [],
    expanded,
    selfId: lan ? lan.id : '',
    deviceName: store.get('deviceName'),
    version: app.getVersion(),
  }));

  ipcMain.handle('ui:setExpanded', (e, v) => setExpanded(!!v));
  // Agent 状态（测试与渲染层首次拉取）
  ipcMain.handle('agent:status', () => collectAgentStatus());
  ipcMain.handle('update:state', () => updateState);
  ipcMain.handle('update:check', () => {
    if (!updater) return updateState;
    updater.checkForUpdates().catch((e) => { updateState = { status: 'error', message: String(e && e.message || e) }; });
    return updateState;
  });
  ipcMain.handle('update:download', () => {
    if (updater) updater.downloadUpdate().catch(() => {});
    return updateState;
  });
  ipcMain.handle('update:install', () => {
    if (updater && updateState.status === 'downloaded') setImmediate(() => updater.quitAndInstall());
    return updateState;
  });
  // 渲染层打字活动上报：光标轮询据此豁免自动收起
  ipcMain.handle('ui:activity', () => { lastTypePing = Date.now(); });

  // 无边框窗口拖动：记录光标与窗口左上角的偏移，跟随光标移动
  ipcMain.handle('ui:startDrag', () => {
    if (!win) return;
    const b = win.getBounds();
    const c = screen.getCursorScreenPoint();
    dragInfo = { offX: c.x - b.x, offY: c.y - b.y };
  });
  ipcMain.handle('ui:drag', () => {
    if (!win || !dragInfo) return;
    const c = screen.getCursorScreenPoint();
    const b = win.getBounds();
    let x = Math.round(c.x - dragInfo.offX);
    let y = Math.round(c.y - dragInfo.offY);
    // 限制在屏幕可视区内，且 12px 内自动吸附边缘（可紧贴显示器边缘）
    const area = screen.getDisplayMatching({ x, y, width: b.width, height: b.height }).workArea;
    const SNAP = 12;
    x = Math.min(Math.max(x, area.x), area.x + area.width - b.width);
    y = Math.min(Math.max(y, area.y), area.y + area.height - b.height);
    if (Math.abs(x - area.x) < SNAP) x = area.x;
    if (Math.abs(x + b.width - (area.x + area.width)) < SNAP) x = area.x + area.width - b.width;
    if (Math.abs(y - area.y) < SNAP) y = area.y;
    if (Math.abs(y + b.height - (area.y + area.height)) < SNAP) y = area.y + area.height - b.height;
    win.setPosition(x, y);
  });
  ipcMain.handle('ui:endDrag', () => {
    if (!win || !dragInfo) return;
    dragInfo = null;
    const b = win.getBounds();
    // 以胶囊宽度为基准持久化位置，展开态拖动后重启位置仍一致
    store.set('islandX', Math.round(b.x + b.width / 2 - PILL.w / 2));
    store.set('islandY', b.y);
  });

  // 聊天粘贴：截图等图像数据存临时 PNG；资源管理器复制的文件读路径
  ipcMain.handle('chat:pasteImage', () => {
    const img = clipboard.readImage();
    if (img.isEmpty()) return '';
    fs.mkdirSync(pasteTmpDir, { recursive: true });
    const p = path.join(pasteTmpDir, `paste_${Date.now()}.png`);
    fs.writeFileSync(p, img.toPNG());
    return p;
  });
  ipcMain.handle('chat:pasteFiles', () => {
    try {
      const raw = clipboard.readFile(); // Windows 专有，多文件以换行分隔
      if (!raw) return [];
      return raw.split(/\r?\n/).map(s => s.trim()).filter(s => s && fs.existsSync(s));
    } catch (e) { return []; }
  });

  ipcMain.handle('lan:sendText', async (e, { peer, text }) => {
    await lan.sendText(peer, text);
    pushHistory(peer.id, peer.name, { kind: 'text', text, ts: Date.now(), dir: 'out' });
    return { ok: true };
  });

  ipcMain.handle('lan:sendFiles', async (e, { peer, files }) => {
    const results = [];
    for (const fp of files) {
      try {
        const r = await lan.sendFile(peer, fp, (p) => win && win.webContents.send('lan:progress', p));
        const ext = path.extname(r.name).toLowerCase();
        const kind = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'].includes(ext) ? 'image' : 'file';
        pushHistory(peer.id, peer.name, {
          kind, name: r.name, size: r.size, path: fp, ts: Date.now(), dir: 'out',
        });
        results.push({ ok: true, name: r.name });
      } catch (err) {
        results.push({ ok: false, name: path.basename(fp), error: err.message });
      }
    }
    return results;
  });

  ipcMain.handle('chat:history', (e, peerId) => {
    const chats = historyStore.get('chats', {});
    return chats[peerId] || { peerName: '', msgs: [] };
  });
  ipcMain.handle('chat:allPeers', () => historyStore.get('chats', {}));
  ipcMain.handle('chat:clear', (e, peerId) => {
    const chats = historyStore.get('chats', {});
    delete chats[peerId];
    historyStore.set('chats', chats);
  });

  // 中转站
  ipcMain.handle('dialog:pickFiles', async () => {
    modalOpen = true;
    try {
      const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] });
      return r.canceled ? [] : r.filePaths;
    } finally { modalOpen = false; }
  });
  ipcMain.handle('staging:list', () => ({
    staging: stagingStore.get('files', []),
    recent: stagingStore.get('recent', []),
  }));
  ipcMain.handle('staging:add', async () => {
    modalOpen = true;
    let r;
    try { r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] }); }
    finally { modalOpen = false; }
    if (r.canceled) return stagingStore.get('files', []);
    const files = stagingStore.get('files', []);
    for (const p of r.filePaths) {
      const st = fs.statSync(p);
      files.push({ name: path.basename(p), path: p, size: st.size, ts: Date.now() });
    }
    stagingStore.set('files', files);
    return files;
  });
  ipcMain.handle('staging:addPaths', (e, paths) => {
    const files = stagingStore.get('files', []);
    for (const p of paths) {
      try {
        const st = fs.statSync(p);
        files.push({ name: path.basename(p), path: p, size: st.size, ts: Date.now() });
      } catch (err) {}
    }
    stagingStore.set('files', files);
    return files;
  });
  ipcMain.handle('staging:remove', (e, idx) => {
    const files = stagingStore.get('files', []);
    files.splice(idx, 1);
    stagingStore.set('files', files);
    return files;
  });
  ipcMain.handle('staging:clear', () => { stagingStore.set('files', []); return []; });
  ipcMain.handle('staging:openReceived', () => shell.openPath(downloadDir));

  // 便签
  ipcMain.handle('notes:list', () => notesStore.get('notes', []));
  ipcMain.handle('notes:add', (e, { text, color }) => {
    const notes = notesStore.get('notes', []);
    notes.unshift({ id: Date.now(), text, ts: Date.now(), color: color || '#ffd166' });
    notesStore.set('notes', notes.slice(0, 50));
    return notesStore.get('notes', []);
  });
  ipcMain.handle('notes:setColor', (e, { id, color }) => {
    const notes = notesStore.get('notes', []);
    const n = notes.find(x => x.id === id);
    if (n) { n.color = color; notesStore.set('notes', notes); }
    return notes;
  });
  ipcMain.handle('notes:top', (e, id) => {
    const notes = notesStore.get('notes', []);
    const i = notes.findIndex(x => x.id === id);
    if (i > 0) { const [n] = notes.splice(i, 1); notes.unshift(n); notesStore.set('notes', notes); }
    return notes;
  });
  ipcMain.handle('notes:update', (e, { id, text }) => {
    const notes = notesStore.get('notes', []);
    const n = notes.find(x => x.id === id);
    if (n) { n.text = text; notesStore.set('notes', notes); }
    return notes;
  });
  ipcMain.handle('notes:delete', (e, id) => {
    notesStore.set('notes', notesStore.get('notes', []).filter(n => n.id !== id));
    return notesStore.get('notes', []);
  });

  // 剪贴板
  ipcMain.handle('clip:list', () => historyStore.get('clip', []));
  ipcMain.handle('clip:copy', (e, item) => {
    if (item.type === 'text') clipboard.writeText(item.text);
    else if (item.path && fs.existsSync(item.path)) clipboard.writeImage(nativeImage.createFromPath(item.path));
  });
  ipcMain.handle('clip:clear', () => { historyStore.set('clip', []); return []; });

  // 音乐：播放列表持久化在 music.json
  const AUDIO_EXTS = ['.mp3', '.flac', '.wav', '.ogg', '.m4a', '.aac', '.wma'];
  const pushPlaylist = (items) => {
    const list = musicStore.get('playlist', []);
    const have = new Set(list.map(x => x.path));
    for (const it of items) if (!have.has(it.path)) list.push(it);
    musicStore.set('playlist', list);
    return list;
  };
  ipcMain.handle('music:list', () => musicStore.get('playlist', []));
  ipcMain.handle('music:addFolder', async () => {
    modalOpen = true;
    let r;
    try { r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] }); }
    finally { modalOpen = false; }
    if (r.canceled || !r.filePaths[0]) return musicStore.get('playlist', []);
    const folder = r.filePaths[0];
    const items = fs.readdirSync(folder)
      .filter(f => AUDIO_EXTS.includes(path.extname(f).toLowerCase()))
      .map(f => ({ name: f, path: path.join(folder, f) }));
    return pushPlaylist(items);
  });
  ipcMain.handle('music:addFiles', async () => {
    modalOpen = true;
    let r;
    try {
      r = await dialog.showOpenDialog(win, {
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: '音频文件', extensions: AUDIO_EXTS.map(e => e.slice(1)) }],
      });
    } finally { modalOpen = false; }
    if (r.canceled) return musicStore.get('playlist', []);
    return pushPlaylist(r.filePaths.map(p => ({ name: path.basename(p), path: p })));
  });
  ipcMain.handle('music:remove', (e, idx) => {
    const list = musicStore.get('playlist', []);
    if (idx >= 0 && idx < list.length) { list.splice(idx, 1); musicStore.set('playlist', list); }
    return list;
  });
  ipcMain.handle('music:clear', () => { musicStore.set('playlist', []); return []; });
  ipcMain.handle('music:openUrl', (e, url) => shell.openExternal(url));

  // 歌词：优先读取音频同名的 .lrc（UTF-8），没有本地歌词时按歌名在线检索并缓存
  ipcMain.handle('music:lyrics', async (e, filePath) => {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath, path.extname(filePath));
    const offsets = musicStore.get('lyricOffsets', {});
    const offset = Number(offsets[base]) || 0;
    for (const cand of [base + '.lrc', base + '.LRC', path.join('lyrics', base + '.lrc')]) {
      const p = path.join(dir, cand);
      if (!fs.existsSync(p)) continue;
      try {
        const lines = parseLrc(fs.readFileSync(p, 'utf8'));
        if (lines.length) return { path: p, lines, offset, source: 'local' };
      } catch (err) {}
    }
    const cache = lyricStore.get('map', {});
    if (Array.isArray(cache[base]) && cache[base].length) return { lines: cache[base], offset, source: 'cache' };
    if (process.env.ISLAND_NO_ONLINE_LYRICS === '1') return { lines: [], offset };
    const lines = await fetchOnlineLyrics(base);
    if (lines.length) {
      cache[base] = lines;
      const keys = Object.keys(cache);
      if (keys.length > 300) keys.slice(0, keys.length - 300).forEach((k) => delete cache[k]);
      lyricStore.set('map', cache);
    }
    return { lines, offset, source: lines.length ? 'online' : 'none' };
  });
  // 歌词同步微调：正数=歌词整体延后，负数=提前；按歌曲文件名持久化
  ipcMain.handle('music:setOffset', (e, { path: p, offset }) => {
    const base = path.basename(p, path.extname(p));
    const map = musicStore.get('lyricOffsets', {});
    const v = Math.max(-30, Math.min(30, Number(offset) || 0));
    if (v) map[base] = v; else delete map[base];
    musicStore.set('lyricOffsets', map);
    return v;
  });

  // 解析 .lnk 快捷方式指向的目标程序，取真实程序图标（直接对 .lnk 取图标只会得到默认"箭头+白纸"）
  const resolveLnkTarget = (p) => {
    try {
      if (path.extname(p).toLowerCase() !== '.lnk') return null;
      const s = shell.readShortcutLink(p);
      return s && s.target && fs.existsSync(s.target) ? s.target : null;
    } catch (e) { return null; }
  };
  const getAppIcon = async (p) => {
    const src = resolveLnkTarget(p) || p;
    try { return (await app.getFileIcon(src, { size: 'normal' })).toDataURL(); }
    catch (e) { try { return (await app.getFileIcon(p, { size: 'normal' })).toDataURL(); } catch { return ''; } }
  };

  // 快捷启动（程序/文件/文件夹，图标取系统真实图标）
  const scAdd = async (paths) => {
    const items = scStore.get('items', []);
    const have = new Set(items.map(x => x.path));
    for (const p of paths) {
      if (!p || have.has(p)) continue;
      let stat;
      try { stat = fs.statSync(p); } catch (e) { continue; }
      const ext = path.extname(p).toLowerCase();
      const type = stat.isDirectory() ? 'folder' : (['.exe', '.lnk', '.bat', '.cmd', '.url'].includes(ext) ? 'app' : 'file');
      const icon = await getAppIcon(p);
      // 程序去掉扩展名，显示更干净
      const name = type === 'app' ? path.basename(p, path.extname(p)) : path.basename(p);
      items.push({ id: Date.now() + Math.floor(Math.random() * 1000), name, path: p, type, icon, ts: Date.now() });
    }
    scStore.set('items', items);
    return items;
  };
  ipcMain.handle('sc:list', () => scStore.get('items', []));
  ipcMain.handle('sc:add', (e, paths) => scAdd(paths));
  ipcMain.handle('sc:pick', async (e, type) => {
    modalOpen = true;
    try {
      const opts = type === 'folder'
        ? { properties: ['openDirectory'] }
        : type === 'app'
          ? { properties: ['openFile', 'multiSelections'], filters: [{ name: '程序', extensions: ['exe', 'lnk', 'bat', 'cmd', 'url'] }] }
          : { properties: ['openFile', 'multiSelections'] };
      const r = await dialog.showOpenDialog(win, opts);
      if (r.canceled) return scStore.get('items', []);
      return await scAdd(r.filePaths);
    } finally { modalOpen = false; }
  });
  ipcMain.handle('sc:remove', (e, id) => {
    const items = scStore.get('items', []).filter(x => x.id !== id);
    scStore.set('items', items);
    return items;
  });
  ipcMain.handle('sc:open', (e, id) => {
    const it = scStore.get('items', []).find(x => x.id === id);
    if (it) shell.openPath(it.path);
  });

  // 已安装程序索引：开始菜单 / 桌面快捷方式 + 系统图标（图标缓存到 scicons.json）
  const PROG_EXTS = ['.lnk', '.url', '.exe'];
  const PROG_SKIP = /(卸载|uninstall|readme|许可证|license|帮助|help|更新程序|update|官网|website|changelog)/i;
  // 拼音首字母：利用 ICU 中文按拼音排序的特性，与各字母界线字比较定位
  const PY_BOUND = [['a', '阿'], ['b', '八'], ['c', '擦'], ['d', '搭'], ['e', '蛾'], ['f', '发'], ['g', '噶'], ['h', '哈'],
    ['j', '击'], ['k', '喀'], ['l', '垃'], ['m', '妈'], ['n', '拿'], ['o', '哦'], ['p', '啪'], ['q', '期'], ['r', '然'],
    ['s', '撒'], ['t', '塌'], ['w', '挖'], ['x', '昔'], ['y', '压'], ['z', '匝']];
  const zhColl = new Intl.Collator('zh-Hans-CN');
  const pyChar = (ch) => {
    if (/[a-z0-9]/i.test(ch)) return ch.toUpperCase();
    if (!/[\u4e00-\u9fa5]/.test(ch)) return '#';
    let letter = '#';
    for (const [l, b] of PY_BOUND) { if (zhColl.compare(b, ch) <= 0) letter = l.toUpperCase(); else break; }
    return letter;
  };
  const iconMap = iconStore.get('map', {});
  // 图标取法升级（.lnk 解析目标 exe）：旧缓存全是默认箭头图标，强制刷新一次
  if (iconStore.get('ver') !== 2) { iconStore.set('map', {}); iconStore.set('ver', 2); Object.keys(iconMap).forEach(k => delete iconMap[k]); }
  const runPool = async (items, fn, n = 8) => {
    let i = 0;
    await Promise.all(Array.from({ length: n }, async () => {
      while (i < items.length) await fn(items[i++]);
    }));
  };
  const walkLinks = (dir, out, depth = 0) => {
    if (depth > 6) return;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of ents) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walkLinks(p, out, depth + 1);
      else if (PROG_EXTS.includes(path.extname(ent.name).toLowerCase())) out.push(p);
    }
  };
  let progCache = null;
  ipcMain.handle('sc:installed', async () => {
    if (progCache) return progCache;
    const roots = [
      path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
      path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
      app.getPath('desktop'),
      'C:\\Users\\Public\\Desktop',
    ];
    const files = [];
    for (const r of roots) walkLinks(r, files);
    const seen = new Set();
    const list = [];
    for (const p of files) {
      const name = path.basename(p, path.extname(p)).trim();
      const key = name.toLowerCase();
      if (!name || PROG_SKIP.test(name) || seen.has(key)) continue;
      seen.add(key);
      list.push({ name, path: p, icon: iconMap[p] || '', initial: pyChar(name[0]), py: [...name].map(pyChar).join('').toLowerCase() });
      if (list.length >= 400) break;
    }
    await runPool(list.filter(x => !x.icon), async (it) => {
      it.icon = await getAppIcon(it.path);
      iconMap[it.path] = it.icon;
    });
    iconStore.set('map', iconMap);
    progCache = list.sort((a, b) => zhColl.compare(a.name, b.name));
    return progCache;
  });

  // 设置
  ipcMain.handle('settings:get', () => store.data);
  ipcMain.handle('settings:set', (e, patch) => {
    for (const [k, v] of Object.entries(patch)) store.set(k, v);
    if ('alwaysOnTop' in patch && win) win.setAlwaysOnTop(!!patch.alwaysOnTop);
    if ('opacity' in patch && win) win.setOpacity(patch.opacity);
    if ('shortcut' in patch) registerShortcut(patch.shortcut);
    if ('deviceName' in patch && lan) { lan.name = String(patch.deviceName); }
    if ('autoStart' in patch) {
      app.setLoginItemSettings({ openAtLogin: !!patch.autoStart });
    }
    return store.data;
  });

  // 内存
  ipcMain.handle('mem:info', async () => {
    // GPU 进程在 Electron 里会把共享显存计入工作集，与任务管理器口径差异很大，
    // 因此单独列出、不计入合计，合计只统计真实驻留的浏览器/界面/工具进程。
    const metrics = app.getAppMetrics();
    const parts = [];
    let total = 0, gpu = 0;
    for (const m of metrics) {
      const mb = Math.round((m.memory ? m.memory.workingSetSize : 0) / 1024);
      if (m.type === 'GPU') { gpu += mb; continue; }
      total += mb;
      parts.push({ type: m.type, mb });
    }
    return { totalMB: total, gpuMB: gpu, parts, lowMemoryMode: store.get('lowMemoryMode') };
  });
  ipcMain.handle('mem:gc', () => {
    if (global.gc) global.gc();
    if (win && win.webContents) {
      try { win.webContents.executeJavaScript('window.gc && window.gc()'); } catch (e) {}
    }
    return true;
  });

  ipcMain.handle('app:openPath', (e, p) => shell.openPath(p));
  ipcMain.handle('app:notify', (e, { title, body }) => new Notification({ title, body }).show());
  ipcMain.handle('app:quit', () => { app.isQuitting = true; app.quit(); });
}

function registerShortcut(accel) {
  globalShortcut.unregisterAll();
  if (!accel) return;
  try {
    globalShortcut.register(accel, () => setExpanded(!expanded));
  } catch (e) { console.error('shortcut register failed', e); }
}

// ---------- 自定义协议：渲染进程安全访问本地接收文件/音频 ----------
function setupProtocol() {
  protocol.handle('island', (req) => {
    const u = new URL(req.url);
    const p = decodeURIComponent(u.pathname.replace(/^\//, '')).replace(/^([a-zA-Z]):/, '$1:');
    // 仅放行接收目录、剪贴板目录与用户选择的音频
    const ok = p.startsWith(downloadDir) || p.startsWith(clipImgDir) ||
      ['.mp3', '.flac', '.wav', '.ogg', '.m4a', '.aac', '.wma', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']
        .includes(path.extname(p).toLowerCase());
    if (!ok || !fs.existsSync(p)) return new Response('forbidden', { status: 403 });
    // 透传 Range 等请求头：音频可流式播放、拖动进度
    return net.fetch(pathToFileURL(p).toString(), { headers: req.headers });
  });
}

// ---------- 生命周期 ----------
// ---------- 自动更新（GitHub Releases） ----------
// 策略：启动 10s 后自动检查一次；发现更新仅提示，用户点「下载」才下载，下载完成后可一键重启安装。
// 测试模式（ISLAND_DATA）与开发环境（无 latest.yml）静默跳过，不干扰。
let updater = null, updateState = { status: 'idle' };
function setupUpdater() {
  if (process.env.ISLAND_DATA || !app.isPackaged) return; // 测试/开发不检查
  try { updater = require('electron-updater').autoUpdater; } catch (e) { return; }
  // 兜底：手工组装 package 时可能漏掉 app-update.yml，缺失会导致检查更新报 ENOENT
  try {
    const cfg = path.join(process.resourcesPath, 'app-update.yml');
    if (!fs.existsSync(cfg)) {
      fs.writeFileSync(cfg, 'provider: github\nowner: wangcai-zhao\nrepo: mokakit\nupdaterCacheDirName: mokakit-updater\n');
    }
  } catch (e) {}
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  const send = (patch) => {
    updateState = { ...updateState, ...patch };
    if (win && !win.isDestroyed()) win.webContents.send('update:status', updateState);
  };
  updater.on('checking-for-update', () => send({ status: 'checking' }));
  updater.on('update-available', (i) => send({ status: 'available', version: i.version }));
  updater.on('update-not-available', () => send({ status: 'none' }));
  updater.on('download-progress', (p) => send({ status: 'downloading', percent: Math.round(p.percent) }));
  updater.on('update-downloaded', (i) => send({ status: 'downloaded', version: i.version }));
  updater.on('error', (e) => send({ status: 'error', message: String(e && e.message || e) }));
  setTimeout(() => updater.checkForUpdates().catch(() => send({ status: 'idle' })), 10000);
}

app.whenReady().then(() => {
  setupProtocol();
  setupIpc();
  createWindow();
  createTray();
  startLan();
  startClipboardWatch();
  startCursorWatch();
  startAgentWatch();
  setupUpdater();
  registerShortcut(store.get('shortcut'));

  app.on('activate', () => { if (!win) createWindow(); });
});

app.on('window-all-closed', (e) => {
  // 常驻后台，不退出
});

app.on('before-quit', () => {
  globalShortcut.unregisterAll();
  clearInterval(clipTimer);
  if (lan) lan.stop();
  store.flush(); stagingStore.flush(); notesStore.flush(); historyStore.flush();
  musicStore.flush(); scStore.flush(); iconStore.flush(); lyricStore.flush();
});

app.on('will-quit', () => globalShortcut.unregisterAll());
