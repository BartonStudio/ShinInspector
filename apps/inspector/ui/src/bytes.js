// 字节编解码 + "人眼可读"推断。
// 协议把通道数据当作不透明字节，所以这里的类型推断只是**显示层的启发式**，不代表协议语义。

const decoder = new TextDecoder('utf-8', { fatal: false });
const encoder = new TextEncoder();

export function utf8(str) {
  return encoder.encode(str ?? '');
}

export function hexToBytes(hex) {
  const s = String(hex ?? '').replace(/[\s,]/g, '');
  if (s === '') return new Uint8Array(0);
  if (s.length % 2 !== 0) throw new Error('hex 长度必须为偶数');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    const b = parseInt(s.substr(i * 2, 2), 16);
    if (Number.isNaN(b)) throw new Error('非法 hex: ' + s.substr(i * 2, 2));
    out[i] = b;
  }
  return out;
}

export function bytesToHex(bytes, sep = ' ') {
  if (!bytes || bytes.length === 0) return '';
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(sep);
}

export function bytesToText(bytes) {
  if (!bytes || bytes.length === 0) return '';
  return decoder.decode(bytes);
}

export function parseBytes(str, asText) {
  return asText ? utf8(str) : hexToBytes(str);
}

function isPrintableAscii(bytes) {
  return bytes.length > 0 && Array.from(bytes).every((b) => b >= 0x20 && b < 0x7f);
}

/**
 * 按长度给一个"最可能是什么"的解读。纯显示层启发式：
 *   1 字节 -> u8；4 字节且非全可打印 ASCII -> u32(大端)；否则按 UTF-8 文本。
 */
export function interpret(bytes) {
  if (!bytes || bytes.length === 0) return { kind: 'empty', text: '(空)' };

  if (bytes.length === 1) return { kind: 'u8', text: 'u8 ' + bytes[0] };

  if (bytes.length === 4 && !isPrintableAscii(bytes)) {
    const be = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false);
    return { kind: 'u32', text: 'u32 ' + be };
  }

  const text = bytesToText(bytes);
  const clean = !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/.test(text);
  if (clean) return { kind: 'text', text: '“' + text + '”' };
  return { kind: 'bytes', text: bytes.length + ' bytes' };
}

/** 统一的可展示形态：主行（推断值）+ hex + text。 */
export function describe(bytes) {
  if (!bytes || bytes.length === 0) return { primary: '(空)', hex: '', text: '' };
  return {
    primary: interpret(bytes).text,
    hex: bytesToHex(bytes),
    text: bytesToText(bytes),
  };
}

export function errText(e) {
  if (!e) return '未知错误';
  if (e.code) return e.code + ': ' + (e.message || '');
  return e.message || String(e);
}

export function shortAddr(addr) {
  if (typeof addr !== 'number') return String(addr ?? '-');
  return '0x' + addr.toString(16).toUpperCase();
}
