// UI 验证 v4：灵动岛歌词 / 快捷弹窗（列表选择+拼音搜索+图标）/ 快捷与工具合并 / 不透明度 / 自动收起
// 运行：npx electron test-ui.js
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '.tmp-ui-data');
fs.rmSync(DATA, { recursive: true, force: true }); // 清掉上次残留，保证断言确定
fs.mkdirSync(DATA, { recursive: true });

/** 生成 N 秒 440Hz 正弦波 WAV（8kHz 8bit 单声道） */
function makeWav(file, seconds = 5) {
  const sr = 8000, n = sr * seconds;
  const data = Buffer.alloc(n);
  for (let i = 0; i < n; i++) data[i] = 128 + Math.round(60 * Math.sin(2 * Math.PI * 440 * i / sr));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + n, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr, 28); h.writeUInt16LE(1, 32); h.writeUInt16LE(8, 34);
  h.write('data', 36); h.writeUInt32LE(n, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
}

const wavPath = path.join(DATA, 'tone.wav');
const wav2Path = path.join(DATA, 'no-lyric.wav');
makeWav(wavPath);
makeWav(wav2Path);
fs.writeFileSync(path.join(DATA, 'tone.lrc'), '[ti:tone]\n[00:00.00]第一句歌词\n[00:02.00]第二句歌词\n');
// 预置播放列表：index 0 有歌词，index 1 无歌词
fs.writeFileSync(path.join(DATA, 'music.json'),
  JSON.stringify({ playlist: [{ name: 'tone.wav', path: wavPath }, { name: 'no-lyric.wav', path: wav2Path }] }, null, 2));

process.env.ISLAND_DATA = DATA;
process.env.ISLAND_PORT = '45712';
process.env.ISLAND_NO_ONLINE_LYRICS = '1'; // 测试不联网，歌词只认本地 .lrc
require('./main.js');
const { app, BrowserWindow, screen, net } = require('electron');
const { execSync } = require('child_process');

const shots = path.join(__dirname, 'test-shots');
fs.mkdirSync(shots, { recursive: true });
let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${extra}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// 收起/收缩由主进程光标轮询驱动，测试需移动真实光标（Windows）
function moveCursor(x, y) {
  try {
    execSync(`powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y})"`, { stdio: 'ignore' });
  } catch (e) { console.log('  (moveCursor 失败:', e.message, ')'); }
}

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0];
  for (let i = 0; i < 50; i++) {
    try { if (await win.webContents.executeJavaScript('!!window.island && !!document.querySelector("#pill")')) break; } catch (e) {}
    await sleep(200);
  }
  const js = (code) => win.webContents.executeJavaScript(code);
  await sleep(500);

  // UI 操作期间关闭自动收起/收缩，避免光标停在窗外导致面板中途收起（[4] 再单独开）
  await js('window.island.settingsSet({autoCollapse:false, edgeHide:false})');
  await js('window.island.setExpanded(true)');
  await sleep(600);

  // ---- 1. 播放 + 灵动岛歌词 ----
  console.log('[1] 播放与歌词');
  const lyr = await js(`window.island.musicLyrics(${JSON.stringify(wavPath)})`);
  check('解析同名 lrc 两行', lyr && lyr.lines.length === 2 && lyr.lines[0].text === '第一句歌词' && lyr.lines[1].t === 2, JSON.stringify(lyr && lyr.lines));
  const none = await js(`window.island.musicLyrics(${JSON.stringify(wav2Path)})`);
  check('无 lrc 返回空歌词', none && none.lines.length === 0, JSON.stringify(none));

  const u = 'island://local/' + encodeURIComponent(wavPath);
  const plain = await net.fetch(u);
  check('协议读取音频 200', plain.status === 200, String(plain.status));
  const ranged = await net.fetch(u, { headers: { Range: 'bytes=0-99' } });
  const rbuf = await ranged.arrayBuffer();
  check('Range 请求返回部分字节(100)', rbuf.byteLength === 100 && (ranged.status === 206 || ranged.status === 200), `${ranged.status}:${rbuf.byteLength}`);

  await js(`document.querySelector('[data-tab=music]').click()`);
  await sleep(300);
  const listN = await js(`document.querySelectorAll('#musicList [data-play]').length`);
  check('播放列表读取 2 首', listN === 2, String(listN));
  await js(`document.querySelector('#musicList [data-play="0"]').click()`);
  await sleep(900);
  check('点列表开始播放', !(await js(`document.querySelector('#playerTitle').textContent`)).includes('无法播放'));
  const pillL1 = await js(`document.querySelector('#pillLyric').textContent`);
  check('灵动岛显示歌词第一句', pillL1 === '第一句歌词', pillL1);
  check('body 进入 playing 态', await js(`document.body.classList.contains('playing')`) === true);
  await js(`document.querySelector('#audioEl').currentTime = 2.5`);
  const pillL2 = await js(`new Promise(res => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const txt = document.querySelector('#pillLyric').textContent;
      if (txt === '第二句歌词' || Date.now() - t0 > 5000) { clearInterval(iv); res(txt); }
    }, 200);
  })`);
  check('歌词随进度切到第二句', pillL2 === '第二句歌词', pillL2);
  shotSave('music-playing.png');

  // 收起为胶囊：灵动岛上应显示歌词
  await js('window.island.setExpanded(false)');
  await sleep(600);
  check('胶囊内歌词可见', await js(`getComputedStyle(document.querySelector('#pillLyric')).display !== 'none'`) === true);
  shotSave('pill-lyric.png');
  await js('window.island.setExpanded(true)');
  await sleep(600);
  await js(`document.querySelector('[data-tab=music]').click()`);
  await sleep(300);

  await js(`document.querySelector('#musicList [data-play="1"]').click()`);
  await sleep(900);
  const pillN = await js(`document.querySelector('#pillLyric').textContent`);
  check('无歌词时显示歌名', pillN === 'no-lyric', pillN);
  const boxLyric = await js(`document.querySelector('#playerLyric').textContent`);
  check('播放器显示暂无歌词', boxLyric === '暂无歌词', boxLyric);
  await js(`document.querySelector('#audioEl').pause()`);
  await sleep(300);
  check('暂停后退出 playing', await js(`document.body.classList.contains('playing')`) === false);

  // ---- 1b. 歌词同步微调 & 播放器按钮 ----
  console.log('[1b] 歌词同步与播放器按钮');
  await js(`document.querySelector('[data-tab=music]').click()`);
  await sleep(300);
  await js(`document.querySelector('#musicList [data-play="0"]').click()`);
  await sleep(900);
  await js(`document.querySelector('#audioEl').currentTime = 2.5`);
  await sleep(400);
  check('歌词同步控件可见', await js(`document.querySelector('#lyricSync').hidden`) === false);
  check('播放按钮为圆形 SVG', await js(`!!document.querySelector('#btnPlay svg') && getComputedStyle(document.querySelector('#btnPlay')).borderRadius !== '0px'`) === true);
  check('播放中显示暂停图标', await js(`getComputedStyle(document.querySelector('#btnPlay .ic-pause')).display !== 'none'`) === true);
  await js(`document.querySelector('#btnLyricLate').click()`);
  await sleep(300);
  check('点“延后”后偏移 +0.5s', (await js(`document.querySelector('#lyricOffset').textContent`)).includes('0.5'));
  const lyrOff = await js(`window.island.musicLyrics(${JSON.stringify(wavPath)})`);
  check('歌词偏移已持久化', lyrOff.offset === 0.5, String(lyrOff.offset));
  await js(`document.querySelector('#lyricOffset').click()`);
  await sleep(300);
  const lyrReset = await js(`window.island.musicLyrics(${JSON.stringify(wavPath)})`);
  check('点击数值归零', lyrReset.offset === 0, String(lyrReset.offset));

  // 偏移对显示时间的影响：+5s 后按 2.5s 播放应退回到歌名（第一句之前）
  await js(`window.island.musicSetOffset({ path: ${JSON.stringify(wavPath)}, offset: 5 })`);
  await js(`document.querySelector('#musicList [data-play="0"]').click()`);
  await sleep(900);
  await js(`document.querySelector('#audioEl').currentTime = 2.5`);
  await sleep(600);
  const shifted = await js(`document.querySelector('#pillLyric').textContent`);
  check('偏移后歌词时间轴已改变', shifted === 'tone', shifted);
  await js(`window.island.musicSetOffset({ path: ${JSON.stringify(wavPath)}, offset: 0 })`);
  await js(`document.querySelector('#audioEl').pause()`);
  await sleep(300);

  // ---- 2. 快捷启动：弹窗 / 列表 / 拼音搜索 / 图标 ----
  console.log('[2] 快捷启动');
  const installed = await js('window.island.scInstalled()');
  check('读取已安装程序', Array.isArray(installed) && installed.length > 0, String(installed && installed.length));
  check('程序带系统图标', installed[0] && String(installed[0].icon).startsWith('data:image'));
  check('程序带拼音索引', installed.some(p => /^[a-z#]+$/.test(p.py) && p.py.length > 0));
  check('按字母分组索引', installed.filter(p => /[A-Z]/.test(p.initial)).length > 0);

  await js(`document.querySelector('[data-tab=sc]').click()`);
  await sleep(400);
  const merged = await js(`!document.querySelector('[data-tab=tools]') && !document.querySelector('#tab-tools')`);
  check('快捷与工具合并为单页签', merged === true);
  const tabLabel = await js(`document.querySelector('[data-tab=sc]').textContent`);
  check('页签名为 快捷工具', tabLabel.includes('快捷工具'), tabLabel);
  check('合并页含时钟与番茄钟', await js(`!!document.querySelector('#tab-sc #bigClock') && !!document.querySelector('#tab-sc #pomoTime')`) === true);
  const overflow = await js(`[...document.querySelectorAll('.tab')].every(t => t.scrollWidth <= t.clientWidth + 8)`);
  check('7 个页签不溢出', overflow === true);
  check('页签数量 7', await js(`document.querySelectorAll('.tab').length`) === 7);

  await js(`document.querySelector('#btnScAdd').click()`);
  await sleep(1200);
  const rows = await js(`document.querySelectorAll('#scList .sc-row').length`);
  check('弹窗列出程序', rows > 5, String(rows));
  check('列表按字母分组', await js(`document.querySelectorAll('#scList .sc-group').length`) > 1);

  // 拼音首字母搜索：取第一个中文程序，用它的拼音前两位搜索
  const cn = installed.find(p => /[\u4e00-\u9fa5]/.test(p.name) && p.py.length >= 2) || installed[0];
  await js(`(() => { const s = document.querySelector('#scSearch'); s.value = ${JSON.stringify(cn.py.slice(0, 2))}; s.dispatchEvent(new Event('input')); })()`);
  await sleep(300);
  const filtered = await js(`document.querySelectorAll('#scList .sc-row').length`);
  check('拼音首字母过滤生效', filtered > 0 && filtered < rows, `${filtered}/${rows}`);
  check('过滤结果命中目标', await js(`[...document.querySelectorAll('#scList .sc-row-name')].some(n => n.textContent === ${JSON.stringify(cn.name)})`) === true);
  await js(`(() => { const s = document.querySelector('#scSearch'); s.value = ''; s.dispatchEvent(new Event('input')); })()`);
  await sleep(300);

  const beforeCount = (await js('window.island.scList()')).length;
  await js(`document.querySelector('#scList .sc-row').click()`);
  await sleep(600);
  const afterList = await js('window.island.scList()');
  check('从列表添加程序', afterList.length === beforeCount + 1, `${beforeCount}->${afterList.length}`);
  check('列表添加项带图标', afterList[afterList.length - 1].icon.startsWith('data:image'));
  const rowAct = await js(`document.querySelector('#scList .sc-row.added .sc-row-act').textContent`);
  check('已添加项显示 ✓', rowAct === '✓', rowAct);
  check('弹窗顶部图标条', await js(`document.querySelectorAll('#scStrip .sc-strip-icon').length`) >= 1);
  check('弹窗计数同步', (await js(`document.querySelector('#scModalCount').textContent`)).includes(String(afterList.length)));
  shotSave('sc-modal.png');
  await js(`document.querySelector('#scModalClose').click()`);
  await sleep(200);
  check('关闭弹窗', await js(`document.querySelector('#scModal').hidden`) === true);

  const items = await js(`window.island.scAdd(${JSON.stringify([wavPath, DATA])})`);
  check('添加文件与文件夹 +2', items.length === afterList.length + 2, `${afterList.length}->${items.length}`);
  const last2 = items.slice(-2);
  check('类型识别 file/folder', last2[0].type === 'file' && last2[1].type === 'folder', JSON.stringify(last2.map(x => x.type)));
  await js(`document.querySelector('[data-tab=sc]').click()`);
  await sleep(300);
  const gridN = await js(`document.querySelectorAll('#scGrid .sc-item').length`);
  check('主页图标网格同步', gridN === items.length, `${gridN}/${items.length}`);
  shotSave('shortcuts.png');
  const afterRm = await js(`window.island.scRemove(${items[items.length - 1].id})`);
  check('移除快捷项', afterRm.length === items.length - 1, String(afterRm.length));

  // ---- 3. 不透明度 ----
  console.log('[3] 不透明度');
  await js(`document.querySelector('[data-tab=settings]').click()`);
  await sleep(400);
  check('设置页显示版本号', /^v\d+\.\d+\.\d+$/.test(await js(`document.querySelector('#aboutVer').textContent`)));
  const us = await js('window.island.updateState()');
  check('更新状态机可用', us && typeof us.status === 'string', JSON.stringify(us));
  check('设置页有检查更新按钮', await js(`!!document.querySelector('#btnUpdateCheck') && document.querySelector('#btnUpdateCheck').textContent.includes('检查更新')`) === true);
  await js(`(() => { const s = document.querySelector('#setOpacity'); s.value = 0.6; s.dispatchEvent(new Event('input')); })()`);
  const op1 = await js('document.body.style.opacity');
  check('滑条实时预览 body opacity=0.6', op1 === '0.6', op1);
  await js(`document.querySelector('#btnSaveSettings').click()`);
  await sleep(300);
  const opSaved = await js('window.island.settingsGet().then(s => s.opacity)');
  check('保存后持久化 0.6', Math.abs(opSaved - 0.6) < 1e-6, String(opSaved));
  shotSave('settings-opacity.png');
  await js(`(() => { const s = document.querySelector('#setOpacity'); s.value = 1; s.dispatchEvent(new Event('input')); })()`);
  await js(`document.querySelector('#btnSaveSettings').click()`);
  await sleep(300);
  check('恢复不透明', await js('document.body.style.opacity') === '1');

  // ---- 4. 光标轮询：自动收起 + 贴边收缩 + 碰条复原 ----
  console.log('[4] 自动收起/贴边收缩');
  const area = screen.getPrimaryDisplay().workArea;
  const waitBounds = async (pred, timeout = 5000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const b = win.getBounds();
      if (pred(b)) return b;
      await sleep(200);
    }
    return win.getBounds();
  };
  moveCursor(area.x + area.width - 8, area.y + area.height - 8); // 光标停到右下角（窗外）
  await sleep(400);
  await js('window.island.settingsSet({autoCollapse:false, edgeHide:false})');
  await js('window.island.setExpanded(false)');
  await sleep(600);
  await js('window.island.setExpanded(true)');
  const be = await waitBounds(b => b.height === 700, 3000);
  check('展开态高度 700', be.height === 700, JSON.stringify(be));
  await js('window.island.settingsSet({autoCollapse:true})');
  const bc = await waitBounds(b => b.height === 56 && b.width === 340 && b.y === area.y, 5000);
  check('光标在窗外自动收起为胶囊', bc.height === 56 && bc.width === 340 && bc.y === area.y, JSON.stringify(bc));
  await js('window.island.settingsSet({edgeHide:true})');
  const bs = await waitBounds(b => b.height === 56 && area.y - b.y === 51, 5000);
  check('随后贴边收缩只露 5px', bs.height === 56 && area.y - bs.y === 51, JSON.stringify(bs));
  check('渲染层进入 edge-hidden', await js(`document.body.classList.contains('edge-hidden')`) === true);
  // 真实鼠标可能抢占光标，重试几次再判定
  let br = bs;
  for (let i = 0; i < 3 && !(br.height === 56 && br.width === 340 && br.y === area.y); i++) {
    moveCursor(bs.x + Math.floor(bs.width / 2), area.y + 2);
    await sleep(300);
    br = await waitBounds(b => b.height === 56 && b.width === 340 && b.y === area.y, 3000);
  }
  check('光标碰细条复原胶囊', br.height === 56 && br.width === 340 && br.y === area.y, JSON.stringify(br));
  moveCursor(area.x + area.width - 8, area.y + area.height - 8);
  await js('window.island.settingsSet({autoCollapse:false, edgeHide:false})');

  // ---- 5. 便签显示方式回归 ----
  console.log('[5] 便签显示方式回归');
  await js('window.island.setExpanded(true)');
  await sleep(600);
  await js('window.island.notesAdd("第一条便签：windows 灵动岛开发", "#a78bfa")');
  await js('window.island.notesAdd("第二条：工作要尽快提交。", "#fde047")');
  const notes = await js('window.island.notesAdd("第三条：办公室电脑正在扫描D盘", "#86efac")');
  check('添加 3 条便签', notes.length === 3, String(notes.length));
  await js(`document.querySelector('[data-tab=notes]').click()`);
  await sleep(300);
  for (const layout of ['stack', 'list', 'grid']) {
    await js(`document.querySelector('#notesSwitch [data-layout=${layout}]').click()`);
    await sleep(300);
    const cls = await js(`document.querySelector('#notesGrid').className`);
    check(`切换到 ${layout}`, cls.includes('mode-' + layout), cls);
    shotSave(`notes-${layout}.png`);
  }

  // ---- 6. Agent 状态（TRAE / WorkBuddy） ----
  console.log('[6] Agent 状态');
  await sleep(2500);
  const ag = await js('window.island.agentStatus()');
  const valid = ['working', 'done', 'waiting', 'idle'];
  check('返回 TRAE 与 WorkBuddy 状态', !!(ag && ag.trae && ag.workbuddy), JSON.stringify(ag));
  check('状态取值合法', valid.includes(ag.trae.state) && valid.includes(ag.workbuddy.state), JSON.stringify(ag));
  console.log('  Agent:', JSON.stringify(ag));
  const chips = await js(`document.querySelectorAll('#agentLine .agent-chip').length`);
  check('面板标题区显示 Agent 状态', chips >= 1, String(chips));
  check('状态圆点已渲染', await js(`!!document.querySelector('#agentLine .agent-dot')`) === true);
  shotSave('agent-status.png');
  // 胶囊态：圆点 + 名称 + 简短状态文字，且不溢出
  await js('window.island.setExpanded(false)');
  await sleep(600);
  const pillChips = await js(`document.querySelectorAll('#pillAgents .pill-agent').length`);
  check('胶囊显示 Agent 状态条目', pillChips >= 1, String(pillChips));
  const pillTxt = await js(`document.querySelector('#pillAgents').textContent`);
  check('胶囊含 Agent 名称与状态', /TRAE|WorkBuddy/.test(pillTxt) && /工作|完成|待批|空闲/.test(pillTxt), pillTxt);
  const pillFit = await js(`(() => { const p = document.querySelector('#pill'); return p.scrollWidth <= p.clientWidth + 1; })()`);
  check('胶囊内容不溢出', pillFit === true);
  shotSave('pill-agent.png');
  await js('window.island.setExpanded(true)');
  await sleep(600);

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  app.isQuitting = true;
  app.exit(failed ? 1 : 0);

  async function shotSave(name) {
    for (let i = 0; i < 6; i++) {
      const img = await win.webContents.capturePage();
      const buf = img.toPNG();
      if (buf.length) { fs.writeFileSync(path.join(shots, name), buf); return; }
      await sleep(400);
    }
    console.log(`  (截图 ${name} 为空，窗口可能处于隐藏态)`);
  }
});
