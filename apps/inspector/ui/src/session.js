// 连接生命周期：握手、关闭、断线重连。
//
// 关键前提：远端 addr 是**指针数值**，目标应用一重启或一重连，所有 addr 都会变。
// 因此重连成功后必须重新解析观察清单，不能复用旧 addr。

import { IObjectClient, RemoteObject } from 'iobject-js';
import { state, emit, logLine } from './store.js';
import { errText } from './bytes.js';
import { diagnoseConnectFailure } from './diagnose.js';

/** 一次连接尝试在完成前被 close() 或另一次 connect() 顶替时抛出。 */
class SupersededError extends Error {
  constructor() {
    super('连接尝试已被取消');
    this.name = 'SupersededError';
    this.superseded = true;
  }
}

const isSuperseded = (e) => e?.superseded === true;

class Session {
  constructor() {
    this.client = null;
    this.url = '';
    this.domain = '';
    this.retry = 0;
    this.timer = null;
    /** 上一次算出的诊断结论：重试失败时沿用它，避免每轮重复探测。 */
    this.lastDiagnosis = null;
    /** 主动关闭时置位，用来抑制「断线重连」逻辑。 */
    this.intentional = true;
    /**
     * 连接尝试的世代号。每次 connect() / close() 都自增。
     *
     * 作用：握手动辄要几秒，期间用户完全可能点「断开」或改地址再连一次。
     * 没有这个令牌的话，在途的那次 connect 会在 resolve 之后照样把状态写成
     * 「已连接」、照样把 socket 存进 this.client —— 于是「点了断开却连上了」，
     * 而旧 socket 还被泄漏在后面（它的 onClose 反过来会把新连接的状态清掉）。
     */
    this.epoch = 0;
  }

  get isOpen() {
    return !!this.client && this.client.isOpen;
  }

  /** 用 addr 临时包一个远端对象（调试器全程按 addr 操作）。 */
  ro(addr) {
    if (!this.client) throw new Error('尚未连接');
    return new RemoteObject(this.client, addr);
  }

  async connect(url, domain, { diagnose = true } = {}) {
    const epoch = ++this.epoch;
    this.intentional = true;
    clearTimeout(this.timer);
    this.timer = null;

    if (this.client) {
      const prev = this.client;
      this.client = null;
      try { await prev.close(); } catch { /* 已断开时关闭失败可忽略 */ }
    }

    this.intentional = false;
    this.url = url;
    this.domain = domain;
    this.setStatus('connecting');
    logLine('正在连接 ' + url + ' (domain=' + domain + ')');

    try {
      const client = await IObjectClient.connect(url, { domain });
      if (epoch !== this.epoch) {
        // 握手期间被顶替：把这个连接丢掉，绝不碰状态。
        try { await client.close(); } catch { /* 忽略 */ }
        throw new SupersededError();
      }
      this.client = client;
      this.retry = 0;
      this.lastDiagnosis = null;
      state.connection.rootAddr = client.root.addr;
      client.onClose(() => this.handleClose());
      this.setStatus('open');
      logLine('已连接，root 锚点 = 0x' + client.root.addr.toString(16).toUpperCase());
      return client;
    } catch (e) {
      if (epoch !== this.epoch) throw e;  // 已被顶替：不写状态、不记日志
      // 传输层错误本身没有信息量（见 diagnose.js 顶部说明），必须补一次探测
      // 才能告诉用户问题出在哪一层。后续重试沿用上一次的结论，不重复探测。
      const diagnosis = diagnose
        ? await diagnoseConnectFailure({ url, domain, error: e })
        : this.lastDiagnosis;
      if (epoch !== this.epoch) throw e;  // 探测期间又被顶替了
      this.lastDiagnosis = diagnosis;
      this.setStatus('error', diagnosis ? diagnosis.reason : errText(e), diagnosis);
      if (diagnose) {
        logLine('连接失败：' + (diagnosis ? diagnosis.reason : errText(e)), 'conn');
        if (diagnosis) {
          logLine('  ' + diagnosis.detail, 'conn');
          for (const action of diagnosis.actions) logLine('  · ' + action, 'conn');
        }
      }
      throw e;
    }
  }

  async close() {
    this.epoch += 1;  // 让在途的 connect 作废
    this.intentional = true;
    clearTimeout(this.timer);
    this.timer = null;
    this.retry = 0;
    this.lastDiagnosis = null;
    const prev = this.client;
    this.client = null;
    if (prev) {
      try { await prev.close(); } catch { /* 忽略 */ }
    }
    state.connection.rootAddr = null;
    this.setStatus('idle');
    logLine('已断开连接');
  }

  handleClose() {
    if (this.intentional) return;
    this.client = null;
    state.connection.rootAddr = null;
    this.setStatus('closed');
    logLine('连接已断开，等待重连…', 'conn');
    this.scheduleRetry();
  }

  scheduleRetry() {
    const delay = Math.min(800 * 2 ** this.retry, 8000);
    this.retry += 1;
    const scheduledAt = this.epoch;
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      // 排程期间用户主动断开或重新连接 → 这次重试已经没有意义
      if (scheduledAt !== this.epoch) return;
      try {
        // 只在第一次重试失败时诊断：此时原因通常刚发生变化（目标应用退出了、
        // 端口被顶掉了），说一次就够。后续每 8 秒刷一遍同样的结论纯属噪音。
        await this.connect(this.url, this.domain, { diagnose: this.retry === 1 });
        emit('reconnected');
      } catch (e) {
        // connect() 自己已经把状态置为 error 了。
        // 被顶替（用户点了断开 / 又发起了一次连接）就说明这次重连已被取消，别再排程；
        // 注意这里不能用 epoch 比对 —— connect() 自己就会推进 epoch。
        if (!isSuperseded(e)) this.scheduleRetry();
      }
    }, delay);
  }

  setStatus(status, error = '', diagnosis = null) {
    state.connection = {
      ...state.connection,
      status,
      url: this.url,
      domain: this.domain,
      error,
      diagnosis,
    };
    emit('connection', state.connection);
  }
}

export const session = new Session();
