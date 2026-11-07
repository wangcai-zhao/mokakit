// 网络层验证：按网卡绑定源地址发送子网广播，确认能从正确网卡出去
const dgram = require('dgram');
const { lanInterfaces, subnetBroadcast } = require('./lan');

const PORT = 45996;
const ifaces = lanInterfaces();
const received = [];

const listener = dgram.createSocket({ type: 'udp4', reuseAddr: true });
listener.on('message', (buf, rinfo) => received.push({ from: rinfo.address, body: buf.toString() }));
listener.bind(PORT, '0.0.0.0', () => {
  setTimeout(() => {
    // 与 lan.js 的宣告策略完全一致：每块网卡绑定自身 IP 后发自己的子网广播
    for (const { ip, prefix } of ifaces) {
      const target = subnetBroadcast(ip, prefix);
      const s = dgram.createSocket({ type: 'udp4' });
      s.bind(0, ip, () => {
        try { s.setBroadcast(true); } catch (e) {}
        s.send(`probe-${ip}`, PORT, target, () => s.close());
      });
    }
  }, 400);
});

setTimeout(() => {
  console.log('各网卡子网广播实际出口：');
  let ok = true;
  for (const { name, ip, prefix } of ifaces) {
    const hit = received.find(r => r.body === `probe-${ip}`);
    // 关键：包必须从该网卡自己的地址发出（说明确实走了这块网卡）
    const good = !!hit && hit.from === ip;
    if (!good) ok = false;
    console.log(`${good ? 'PASS' : 'FAIL'}  ${name} ${ip}/${prefix} -> ${subnetBroadcast(ip, prefix)}` +
      (hit ? `  出口源地址=${hit.from}` : '  未收到（该网卡可能不支持广播，如 VPN 隧道）'));
  }
  console.log(ok ? '\n结论：真实局域网网卡广播出口正确' : '\n结论：存在网卡未能从自身地址发出广播');
  listener.close();
  process.exit(ok ? 0 : 1);
}, 2600);
