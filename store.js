// 简易 JSON 持久化存储
const fs = require('fs');
const path = require('path');

class Store {
  constructor(file, defaults = {}) {
    this.file = file;
    this.data = Object.assign({}, defaults);
    try {
      if (fs.existsSync(file)) {
        this.data = Object.assign({}, defaults, JSON.parse(fs.readFileSync(file, 'utf8')));
      }
    } catch (e) { /* 损坏则使用默认值 */ }
    this._timer = null;
  }

  get(key, fallback) {
    const v = this.data[key];
    return v === undefined ? fallback : v;
  }

  set(key, value) {
    this.data[key] = value;
    this._scheduleSave();
  }

  _scheduleSave() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 300);
  }

  flush() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch (e) { console.error('store save failed', e); }
  }
}

module.exports = Store;
