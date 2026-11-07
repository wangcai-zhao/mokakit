// 内网发现与传输服务
// 发现：UDP 广播（所有实例绑定同一端口，周期性宣告自己）
// 传输：每实例一个 HTTP 服务，POST /api/text、POST /api/file
const dgram = require('dgram');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const DISCOVERY_PORT = 45799;
const ANNOUNCE_INTERVAL = 2500;
const PEER_TTL = 8000;

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'];

/** 由 IPv4 地址与掩码前缀算出子网定向广播地址，如 10.10.10.3/24 -> 10.10.10.255 */
function subnetBroadcast(addr, prefix) {
  const parts = addr.split('.').map(Number);
  const ipInt = (((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0);
  const hostBits = 32 - prefix;
  const hostMask = Math.pow(2, hostBits) - 1;
  const bInt = ((ipInt | hostMask) >>> 0);
  return [(bInt >>> 24) & 255, (bInt >>> 16) & 255, (bInt >>> 8) & 255, bInt & 255].join('.');
}

/**
 * 所有宣告目标地址。
 * 多网卡时 255.255.255.255 只会从默认路由那块网卡发出，
 * 因此必须追加每块网卡自己的子网广播地址，否则另一网段上的设备收不到。
 */
function broadcastTargets() {
  const list = new Set(['255.255.255.255', '127.0.0.1']);
  for (const { ip, prefix } of lanInterfaces()) list.add(subnetBroadcast(ip, prefix));
  return [...list];
}

/** 本机所有可用 IPv4 网卡（不含环回） */
function lanInterfaces() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const it of ifs[name] || []) {
      if (it.family !== 'IPv4' || it.internal) continue;
      const prefix = Number((it.cidr || '').split('/')[1]);
      if (!Number.isFinite(prefix) || prefix >= 32) continue;
      out.push({ name, ip: it.address, prefix });
    }
  }
  return out;
}

class LanService extends EventEmitter {
  /**
   * @param {object} opts { tcpPort, name, downloadDir, maxFileMB }
   */
  constructor(opts) {
    super();
    this.tcpPort = opts.tcpPort || 45700;
    this.name = opts.name || os.hostname();
    this.downloadDir = opts.downloadDir;
    this.maxFileMB = opts.maxFileMB || 2048;
    this.id = `${os.hostname()}-${this.tcpPort}-${crypto.randomBytes(3).toString('hex')}`;
    this.peers = new Map(); // id -> {id,name,host,port,lastSeen}
    this.sock = null;
    this.server = null;
    this._announceTimer = null;
    this._pruneTimer = null;
  }

  localIPs() {
    const list = [];
    const ifs = os.networkInterfaces();
    for (const name of Object.keys(ifs)) {
      for (const it of ifs[name] || []) {
        if (it.family === 'IPv4' && !it.internal) list.push(it.address);
      }
    }
    return list;
  }

  start() {
    fs.mkdirSync(this.downloadDir, { recursive: true });
    this._startDiscovery();
    this._startServer();
  }

  stop() {
    clearInterval(this._announceTimer);
    clearInterval(this._pruneTimer);
    for (const it of this._sendSocks || []) { try { it.sock.close(); } catch (e) {} }
    this._sendSocks = [];
    try { this.sock && this.sock.close(); } catch (e) {}
    try { this.server && this.server.close(); } catch (e) {}
  }

  _startDiscovery() {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.sock = sock;
    sock.on('error', (e) => this.emit('error', e));
    sock.on('message', (buf, rinfo) => {
      let msg;
      try { msg = JSON.parse(buf.toString('utf8')); } catch (e) { return; }
      if (!msg || msg.app !== 'lan-island' || msg.id === this.id) return;
      const existed = this.peers.has(msg.id);
      this.peers.set(msg.id, {
        id: msg.id, name: msg.name, host: rinfo.address,
        port: msg.port, lastSeen: Date.now(),
      });
      if (!existed) this.emit('peers', this.peerList());
    });
    sock.bind(DISCOVERY_PORT, () => {
      try { sock.setBroadcast(true); } catch (e) {}

      // 每块网卡各建一个绑定自身 IP 的发送套接字。
      // 只用一个通配套接字发广播时，Windows 会走默认路由（可能是有 VPN 的隧道网卡），
      // 导致真实局域网上的设备收不到宣告。绑定源地址可强制从指定网卡发出。
      this._sendSocks = [];
      for (const { ip, prefix } of lanInterfaces()) {
        try {
          const s = dgram.createSocket({ type: 'udp4' });
          s.on('error', (e) => this.emit('error', e));
          s.bind(0, ip, () => {
            try { s.setBroadcast(true); } catch (e) {}
            this._sendSocks.push({ sock: s, target: subnetBroadcast(ip, prefix) });
          });
        } catch (e) { /* 网卡不可用则跳过 */ }
      }

      const announce = () => {
        const payload = JSON.stringify({
          app: 'lan-island', id: this.id, name: this.name, port: this.tcpPort,
        });
        for (const { sock: s, target } of this._sendSocks) {
          s.send(payload, DISCOVERY_PORT, target, () => {});
        }
        // 兜底：通配广播 + 本机环回（便于同机多实例测试）
        sock.send(payload, DISCOVERY_PORT, '255.255.255.255', () => {});
        sock.send(payload, DISCOVERY_PORT, '127.0.0.1', () => {});
      };
      announce();
      this._announceTimer = setInterval(announce, ANNOUNCE_INTERVAL);
    });
    this._pruneTimer = setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [id, p] of this.peers) {
        if (now - p.lastSeen > PEER_TTL) { this.peers.delete(id); changed = true; }
      }
      if (changed) this.emit('peers', this.peerList());
    }, 3000);
  }

  peerList() {
    return [...this.peers.values()].map(p => ({ id: p.id, name: p.name, host: p.host, port: p.port }));
  }

  _startServer() {
    const server = http.createServer((req, res) => this._onRequest(req, res));
    server.on('error', (e) => this.emit('error', e));
    server.listen(this.tcpPort, '0.0.0.0', () => this.emit('ready', this.tcpPort));
    this.server = server;
  }

  _onRequest(req, res) {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/api/info') {
      return this._json(res, 200, { name: this.name, id: this.id, version: 1 });
    }
    if (req.method === 'POST' && url.pathname === '/api/text') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
      req.on('end', () => {
        let msg;
        try { msg = JSON.parse(body); } catch (e) { return this._json(res, 400, { ok: false }); }
        this.emit('message', {
          kind: 'text', text: String(msg.text || ''),
          fromId: msg.fromId, fromName: msg.fromName, ts: Date.now(),
        });
        this._json(res, 200, { ok: true });
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/file') {
      const rawName = req.headers['x-file-name'] || 'file';
      const name = decodeURIComponent(rawName).replace(/[\\/:*?"<>|]/g, '_');
      const fromId = req.headers['x-from-id'] || '';
      const fromName = decodeURIComponent(req.headers['x-from-name'] || '对方');
      const len = Number(req.headers['content-length'] || 0);
      if (len > this.maxFileMB * 1024 * 1024) {
        req.resume();
        return this._json(res, 413, { ok: false, error: 'too large' });
      }
      const saveName = `${Date.now()}_${name}`;
      const savePath = path.join(this.downloadDir, saveName);
      const ws = fs.createWriteStream(savePath);
      let received = 0;
      req.on('data', (chunk) => {
        received += chunk.length;
        this.emit('progress', { dir: 'in', name, received, total: len });
      });
      req.pipe(ws);
      req.on('error', () => { ws.destroy(); fs.unlink(savePath, () => {}); });
      ws.on('error', () => this._json(res, 500, { ok: false }));
      ws.on('finish', () => {
        const ext = path.extname(name).toLowerCase();
        this.emit('message', {
          kind: IMAGE_EXTS.includes(ext) ? 'image' : 'file',
          name, size: received, path: savePath,
          fromId, fromName, ts: Date.now(),
        });
        this._json(res, 200, { ok: true, name: saveName });
      });
      return;
    }
    this._json(res, 404, { ok: false });
  }

  _json(res, code, obj) {
    const s = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(s);
  }

  /** 发送文字 */
  sendText(peer, text) {
    return this._postJson(peer, '/api/text', {
      text, fromId: this.id, fromName: this.name,
    });
  }

  /** 发送文件/图片 */
  sendFile(peer, filePath, onProgress) {
    return new Promise((resolve, reject) => {
      const stat = fs.statSync(filePath);
      const name = path.basename(filePath);
      const req = http.request({
        host: peer.host, port: peer.port, path: '/api/file', method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': stat.size,
          'X-File-Name': encodeURIComponent(name),
          'X-From-Id': this.id,
          'X-From-Name': encodeURIComponent(this.name),
        },
      }, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          if (res.statusCode === 200) resolve({ ok: true, name, size: stat.size });
          else reject(new Error(`对方返回 ${res.statusCode}: ${body}`));
        });
      });
      req.on('error', reject);
      let sent = 0;
      const rs = fs.createReadStream(filePath);
      rs.on('data', (chunk) => {
        sent += chunk.length;
        if (onProgress) onProgress({ dir: 'out', name, received: sent, total: stat.size });
      });
      rs.on('error', reject);
      rs.pipe(req);
    });
  }

  _postJson(peer, pathName, obj) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(obj);
      const req = http.request({
        host: peer.host, port: peer.port, path: pathName, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        let b = '';
        res.on('data', c => b += c);
        res.on('end', () => res.statusCode === 200 ? resolve() : reject(new Error(`对方返回 ${res.statusCode}`)));
      });
      req.on('error', reject);
      req.end(body);
    });
  }
}

module.exports = { LanService, DISCOVERY_PORT, broadcastTargets, subnetBroadcast, lanInterfaces };
