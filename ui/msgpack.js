// 极简 MessagePack 编解码器（无依赖）。
// 覆盖 IObject 远程协议用到的类型：nil / bool / uint / int / str / bin / array / map。
// 编码策略与 IObject 使用的 msgpack11 对齐：字符串→str，二进制→bin，非负整数→uint。
(function (global) {
  'use strict';

  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder('utf-8');

  // ---------------- 编码 ----------------

  function encodeUint(out, n) {
    if (n >= 0) {
      if (n < 0x80) { out.push(n); }
      else if (n <= 0xff) { out.push(0xcc, n); }
      else if (n <= 0xffff) { out.push(0xcd, (n >> 8) & 0xff, n & 0xff); }
      else if (n <= 0xffffffff) { out.push(0xce, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff); }
      else {
        // uint64（n 上限 2^53，与协议「数值不超过 2^53」一致）
        out.push(0xcf);
        const hi = Math.floor(n / 4294967296);
        const lo = n >>> 0;
        out.push((hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff,
                 (lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff);
      }
    } else {
      if (n >= -32) { out.push(n & 0xff); }
      else if (n >= -128) { out.push(0xd0, n & 0xff); }
      else if (n >= -32768) { out.push(0xd1, (n >> 8) & 0xff, n & 0xff); }
      else if (n >= -2147483648) { out.push(0xd2, (n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff); }
      else { throw new Error('MsgPack.encode: 不支持 int64 负数'); }
    }
  }

  function encodeStr(out, str) {
    const bytes = textEncoder.encode(str);
    const n = bytes.length;
    if (n < 32) { out.push(0xa0 | n); }
    else if (n <= 0xff) { out.push(0xd9, n); }
    else if (n <= 0xffff) { out.push(0xda, (n >> 8) & 0xff, n & 0xff); }
    else { out.push(0xdb, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff); }
    for (let i = 0; i < bytes.length; i++) out.push(bytes[i]);
  }

  function encodeBin(out, bytes) {
    const n = bytes.length;
    if (n <= 0xff) { out.push(0xc4, n); }
    else if (n <= 0xffff) { out.push(0xc5, (n >> 8) & 0xff, n & 0xff); }
    else { out.push(0xc6, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff); }
    for (let i = 0; i < bytes.length; i++) out.push(bytes[i]);
  }

  function encodeValue(out, value) {
    if (value === null || value === undefined) { out.push(0xc0); return; }
    const t = typeof value;
    if (t === 'boolean') { out.push(value ? 0xc3 : 0xc2); return; }
    if (t === 'number') { encodeUint(out, value); return; }
    if (t === 'string') { encodeStr(out, value); return; }
    if (value instanceof Uint8Array) { encodeBin(out, value); return; }
    if (Array.isArray(value)) {
      const n = value.length;
      if (n < 16) out.push(0x90 | n);
      else if (n <= 0xffff) out.push(0xdc, (n >> 8) & 0xff, n & 0xff);
      else out.push(0xdd, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
      for (const item of value) encodeValue(out, item);
      return;
    }
    if (t === 'object') {
      const keys = Object.keys(value);
      const n = keys.length;
      if (n < 16) out.push(0x80 | n);
      else if (n <= 0xffff) out.push(0xde, (n >> 8) & 0xff, n & 0xff);
      else out.push(0xdf, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
      for (const k of keys) { encodeStr(out, k); encodeValue(out, value[k]); }
      return;
    }
    throw new Error('MsgPack.encode: 不支持的类型 ' + t);
  }

  function encode(value) {
    const out = [];
    encodeValue(out, value);
    return Uint8Array.from(out);
  }

  // ---------------- 解码 ----------------

  function readStr(s, len) {
    const bytes = new Uint8Array(s.view.buffer, s.view.byteOffset + s.off, len);
    s.off += len;
    return textDecoder.decode(bytes);
  }

  function readBin(s, len) {
    const bytes = new Uint8Array(s.view.buffer, s.view.byteOffset + s.off, len);
    s.off += len;
    return bytes.slice(); // 拷贝，脱离底层 ArrayBuffer
  }

  function readArray(s, len) {
    const arr = new Array(len);
    for (let i = 0; i < len; i++) arr[i] = readValue(s);
    return arr;
  }

  function readMap(s, len) {
    const obj = {};
    for (let i = 0; i < len; i++) {
      const key = readValue(s);
      obj[key] = readValue(s);
    }
    return obj;
  }

  function readValue(s) {
    const view = s.view;
    const b = view.getUint8(s.off++);

    if (b <= 0x7f) return b;                              // positive fixint 0x00-0x7f
    if (b >= 0xe0) return b - 0x100;                      // negative fixint 0xe0-0xff
    if (b >= 0xa0 && b <= 0xbf) return readStr(s, b & 0x1f);   // fixstr 0xa0-0xbf
    if (b >= 0x90 && b <= 0x9f) return readArray(s, b & 0x0f); // fixarray 0x90-0x9f
    if (b >= 0x80 && b <= 0x8f) return readMap(s, b & 0x0f);   // fixmap 0x80-0x8f

    switch (b) {
      case 0xc0: return null;
      case 0xc2: return false;
      case 0xc3: return true;
      case 0xc4: return readBin(s, view.getUint8(s.off++));
      case 0xc5: { const n = view.getUint16(s.off); s.off += 2; return readBin(s, n); }
      case 0xc6: { const n = view.getUint32(s.off); s.off += 4; return readBin(s, n); }
      case 0xca: { const v = view.getFloat32(s.off); s.off += 4; return v; }
      case 0xcb: { const v = view.getFloat64(s.off); s.off += 8; return v; }
      case 0xcc: return view.getUint8(s.off++);
      case 0xcd: { const v = view.getUint16(s.off); s.off += 2; return v; }
      case 0xce: { const v = view.getUint32(s.off); s.off += 4; return v; }
      case 0xcf: {
        const hi = view.getUint32(s.off); const lo = view.getUint32(s.off + 4); s.off += 8;
        return hi * 4294967296 + lo;
      }
      case 0xd0: return view.getInt8(s.off++);
      case 0xd1: { const v = view.getInt16(s.off); s.off += 2; return v; }
      case 0xd2: { const v = view.getInt32(s.off); s.off += 4; return v; }
      case 0xd3: {
        const hi = view.getUint32(s.off); const lo = view.getUint32(s.off + 4); s.off += 8;
        const u = hi * 4294967296 + lo;
        return (hi & 0x80000000) ? u - 18446744073709551616 : u;
      }
      case 0xd9: return readStr(s, view.getUint8(s.off++));
      case 0xda: { const n = view.getUint16(s.off); s.off += 2; return readStr(s, n); }
      case 0xdb: { const n = view.getUint32(s.off); s.off += 4; return readStr(s, n); }
      case 0xdc: { const n = view.getUint16(s.off); s.off += 2; return readArray(s, n); }
      case 0xdd: { const n = view.getUint32(s.off); s.off += 4; return readArray(s, n); }
      case 0xde: { const n = view.getUint16(s.off); s.off += 2; return readMap(s, n); }
      case 0xdf: { const n = view.getUint32(s.off); s.off += 4; return readMap(s, n); }
      default: throw new Error('MsgPack.decode: 不支持的字节 0x' + b.toString(16));
    }
  }

  function decode(bytes) {
    const buf = (bytes instanceof Uint8Array) ? bytes : new Uint8Array(bytes);
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const s = { view: view, off: 0 };
    return readValue(s);
  }

  global.MsgPack = { encode: encode, decode: decode };
})(typeof window !== 'undefined' ? window : globalThis);
