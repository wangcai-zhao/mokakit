// 传输层自测：两个 LanService 实例在 localhost 互发文字与文件
const { LanService } = require('./lan');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmp = path.join(os.tmpdir(), 'island-test');
fs.mkdirSync(tmp, { recursive: true });

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`);
}

async function main() {
  const a = new LanService({ tcpPort: 46101, name: '设备A', downloadDir: path.join(tmp, 'a') });
  const b = new LanService({ tcpPort: 46102, name: '设备B', downloadDir: path.join(tmp, 'b') });
  a.start(); b.start();
  await new Promise(r => setTimeout(r, 400));

  // 1. 互相发现（等一轮广播）
  await new Promise(r => setTimeout(r, 3200));
  check('A 发现 B', a.peerList().some(p => p.port === 46102));
  check('B 发现 A', b.peerList().some(p => p.port === 46101));

  // 2. A -> B 发文字
  const textP = new Promise(r => b.once('message', r));
  await a.sendText(a.peerList().find(p => p.port === 46102), '你好，这是测试消息 123');
  const msg = await textP;
  check('A->B 文字', msg.kind === 'text' && msg.text === '你好，这是测试消息 123' && msg.fromName === '设备A');

  // 3. B -> A 发文件（含中文名）
  const testFile = path.join(tmp, '测试文件 hello.txt');
  fs.writeFileSync(testFile, '文件内容 abc123 中文');
  const fileP = new Promise(r => a.once('message', r));
  await b.sendFile(b.peerList().find(p => p.port === 46101), testFile);
  const fmsg = await fileP;
  const okContent = fs.existsSync(fmsg.path) && fs.readFileSync(fmsg.path, 'utf8') === '文件内容 abc123 中文';
  check('B->A 文件', fmsg.kind === 'file' && okContent, `-> ${fmsg.path}`);

  // 4. A -> B 发图片（伪造 png 头即可，按扩展名识别）
  const imgFile = path.join(tmp, 'pic.png');
  fs.writeFileSync(imgFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));
  const imgP = new Promise(r => b.once('message', r));
  await a.sendFile(a.peerList().find(p => p.port === 46102), imgFile);
  const imsg = await imgP;
  check('A->B 图片识别', imsg.kind === 'image');

  // 5. 对方离线时发送应报错
  b.stop();
  await new Promise(r => setTimeout(r, 200));
  let errOk = false;
  try { await a.sendText({ host: '127.0.0.1', port: 46102 }, 'x'); } catch (e) { errOk = true; }
  check('离线发送报错', errOk);

  a.stop();
  const failed = results.filter(r => !r.ok);
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
