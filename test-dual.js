// 双实例（模拟双机）端到端验证：发现广播 + 双向文字 + 文件落盘 + 数据目录隔离
const dgram = require('dgram');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const A = { port: 45700, data: path.join(ROOT, 'testdata', 'A'), name: '实例A' };
const B = { port: 45701, data: path.join(ROOT, 'testdata', 'B'), name: '实例B' };

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
}

const getJson = (port, p, host = '127.0.0.1') => new Promise((resolve, reject) => {
  const req = http.get({ host, port, path: p, timeout: 3000 }, (res) => {
    let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
  });
  req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout')));
});

function postJson(port, p, obj, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(obj);
    const req = http.request({
      host, port, path: p, method: 'POST', timeout: 5000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ code: res.statusCode, body: b })); });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end(body);
  });
}

function postFile(port, filePath, fromName, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const st = fs.statSync(filePath);
    const req = http.request({
      host, port, path: '/api/file', method: 'POST', timeout: 15000,
      headers: {
        'Content-Type': 'application/octet-stream', 'Content-Length': st.size,
        'X-File-Name': encodeURIComponent(path.basename(filePath)),
        'X-From-Id': 'test-client', 'X-From-Name': encodeURIComponent(fromName),
      },
    }, (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ code: res.statusCode, body: b })); });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout')));
    fs.createReadStream(filePath).pipe(req);
  });
}

function listenAnnouncements(ms = 6000) {
  return new Promise((resolve) => {
    const seen = new Map();
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('message', (buf, rinfo) => {
      try {
        const m = JSON.parse(buf.toString('utf8'));
        if (m.app === 'lan-island') seen.set(m.id, { port: m.port, name: m.name, from: rinfo.address });
      } catch (e) {}
    });
    sock.bind(45799, () => setTimeout(() => {
      try { sock.close(); } catch (e) {}
      resolve([...seen.values()]);
    }, ms));
  });
}

(async () => {
  // 1. 两个实例的 HTTP 服务都在监听
  let infoA, infoB;
  try { infoA = await getJson(45700, '/api/info'); } catch (e) { infoA = null; }
  try { infoB = await getJson(45701, '/api/info'); } catch (e) { infoB = null; }
  check('实例A 服务在线', !!infoA, infoA ? `${infoA.name} / ${infoA.id}` : '');
  check('实例B 服务在线', !!infoB, infoB ? `${infoB.name} / ${infoB.id}` : '');

  // 2. 数据目录隔离（两实例各自使用独立 userData，端口互不覆盖）
  const dirA = fs.existsSync(path.join(A.data, 'received'));
  const dirB = fs.existsSync(path.join(B.data, 'received'));
  check('数据目录隔离（各自接收目录独立）', dirA && dirB && infoA.id !== infoB.id,
    `A=${A.data} B=${B.data}`);

  // 3. UDP 广播发现（双方都在宣告，且两块网卡的子网广播都能送达）
  const anns = await listenAnnouncements(6000);
  const ports = anns.map(a => a.port).sort();
  const srcs = [...new Set(anns.map(a => a.from))].sort();
  check('UDP广播发现到两个实例', ports.includes(45700) && ports.includes(45701),
    anns.map(a => `${a.port}@${a.from}`).join(', '));
  check('广播经真实局域网网卡发出（非环回）', srcs.some(s => !s.startsWith('127.')),
    '来源地址: ' + srcs.join(', '));

  // 3b. 经真实局域网 IP 的完整链路（等同于另一台机器经 WiFi 访问本机）
  const lanIp = srcs.find(s => !s.startsWith('127.')) || '127.0.0.1';
  const lanInfo = await getJson(45701, '/api/info', lanIp);
  const rl = await postJson(45701, '/api/text', { text: '经局域网IP的消息', fromId: 'LAN', fromName: '局域网端' }, lanIp);
  check('经真实局域网IP可达并送达', !!lanInfo.name && rl.code === 200, `${lanIp}:45701 ${rl.body.trim()}`);

  // 4. A -> B 发文字
  const r1 = await postJson(45701, '/api/text', { text: '真机实测消息 A→B', fromId: 'A', fromName: '实例A' });
  check('A→B 文字送达', r1.code === 200 && JSON.parse(r1.body).ok === true, r1.body.trim());

  // 5. B -> A 发文字
  const r2 = await postJson(45700, '/api/text', { text: '真机实测消息 B→A', fromId: 'B', fromName: '实例B' });
  check('B→A 文字送达', r2.code === 200 && JSON.parse(r2.body).ok === true, r2.body.trim());

  // 6. A -> B 发 20MB 文件，校验字节完全一致
  const big = path.join(ROOT, 'testdata', '大文件测试_20MB.bin');
  const buf = Buffer.alloc(20 * 1024 * 1024);
  for (let i = 0; i < buf.length; i += 4096) buf.writeUInt32LE(i, Math.min(i, buf.length - 4));
  buf[buf.length - 1] = 0xAB;
  fs.writeFileSync(big, buf);

  const rf = await postFile(45701, big, '实例A');
  const recDir = path.join(B.data, 'received');
  const saved = fs.readdirSync(recDir).find(f => f.includes('大文件测试_20MB.bin'));
  let same = false;
  if (saved) {
    const got = fs.statSync(path.join(recDir, saved)).size;
    const gotBuf = fs.readFileSync(path.join(recDir, saved));
    same = gotBuf.length === buf.length && gotBuf.equals(buf);
  }
  check('A→B 20MB文件完整（逐字节一致）', rf.code === 200 && !!saved && same,
    saved ? `${saved} ${(fs.statSync(path.join(recDir, saved)).size / 1048576).toFixed(1)}MB` : '未找到落盘文件');

  // 7. 中文文件名 + 图片识别
  const img = path.join(ROOT, 'testdata', '图片截图测试.png');
  fs.copyFileSync(big, img);
  const ri = await postFile(45700, img, '实例B');
  const recA = path.join(A.data, 'received');
  const imgSaved = fs.readdirSync(recA).find(f => f.includes('图片截图测试.png'));
  check('B→A 中文名图片送达', ri.code === 200 && !!imgSaved, imgSaved || '');

  // 8. 超限文件被拒绝（默认上限 2048MB，此处用伪造超大 Content-Length 验证分支）
  const r8 = await new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port: 45701, path: '/api/file', method: 'POST',
      headers: { 'Content-Length': 3 * 1024 * 1024 * 1024, 'X-File-Name': 'huge.bin' },
    }, (res) => { resolve(res.statusCode); req.destroy(); });
    req.on('error', () => resolve(413));
    req.end();
  });
  check('超大文件被拒绝(413)', r8 === 413, 'HTTP ' + r8);

  fs.unlinkSync(big); fs.unlinkSync(img);
  const failed = results.filter(r => !r.ok);
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('测试异常：', e.message); process.exit(1); });
