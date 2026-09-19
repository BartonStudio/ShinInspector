// 「学到的知识」——协议没有反射能力，通道名与方法名只能靠观察积累。
//
// 持久化键用**对象路径**（如 root.Device.Sub），不用 addr：
// addr 是指针数值，目标应用重启即失效；路径才能跨会话复用。

import { bytesToHex } from './bytes.js';

const keyOf = (domain) => 'shin.memory.' + domain;

function load(domain) {
  try {
    return JSON.parse(localStorage.getItem(keyOf(domain)) || '{}');
  } catch {
    return {};
  }
}

class Memory {
  constructor() {
    this.domain = '';
    this.data = {};
  }

  bind(domain) {
    if (this.domain === domain) return;
    this.domain = domain;
    this.data = load(domain);
  }

  save() {
    try {
      localStorage.setItem(keyOf(this.domain), JSON.stringify(this.data));
    } catch { /* 配额或隐私模式，忽略 */ }
  }

  bucket(path) {
    if (!path) return null;
    if (!this.data[path]) this.data[path] = { channels: {}, methods: [] };
    return this.data[path];
  }

  /** 记录一次通道观测；值没变则返回 false。 */
  observeChannel(path, channel, bytes) {
    const b = this.bucket(path);
    if (!b || !channel) return false;
    const hex = bytesToHex(bytes);
    if (b.channels[channel] === hex) return false;
    b.channels[channel] = hex;
    this.save();
    return true;
  }

  /** 记录一次通道的「存在但读不到值」。 */
  noteChannel(path, channel) {
    const b = this.bucket(path);
    if (!b || !channel) return;
    if (b.channels[channel] === undefined) {
      b.channels[channel] = null;
      this.save();
    }
  }

  channelNames(path) {
    const b = path ? this.data[path] : null;
    return b ? Object.keys(b.channels) : [];
  }

  methodNames(path) {
    const b = path ? this.data[path] : null;
    return b ? [...b.methods] : [];
  }

  learnMethod(path, method) {
    const b = this.bucket(path);
    if (!b || !method) return false;
    if (b.methods.includes(method)) return false;
    b.methods.push(method);
    this.save();
    return true;
  }

  forgetMethod(path, method) {
    const b = path ? this.data[path] : null;
    if (!b) return;
    b.methods = b.methods.filter((m) => m !== method);
    this.save();
  }

  /** 用户显式关闭掉的订阅类型。按路径存，这样重解析清单后不会被悄悄恢复。 */
  subsOff(path) {
    const b = path ? this.data[path] : null;
    return b && Array.isArray(b.subsOff) ? [...b.subsOff] : [];
  }

  setSubsOff(path, type, off) {
    const b = this.bucket(path);
    if (!b || !type) return;
    if (!Array.isArray(b.subsOff)) b.subsOff = [];
    const has = b.subsOff.includes(type);
    if (off && !has) b.subsOff.push(type);
    if (!off && has) b.subsOff = b.subsOff.filter((t) => t !== type);
    this.save();
  }
}

export const memory = new Memory();
