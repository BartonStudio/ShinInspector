// ShinInspector 设置页：选择通信方式；WS 模式在进入调试页前做一次真实握手校验。
import { IObjectClient } from 'iobject-js';

const $ = (id) => document.getElementById(id);

// 回显上次设置
const saved = localStorage.getItem('shin.mode') || 'ipc';
if (saved === 'ws') {
  document.querySelector('input[name="mode"][value="ws"]').checked = true;
  $('wsConfig').style.display = 'block';
}
$('wsUrl').value = localStorage.getItem('shin.wsUrl') || 'ws://127.0.0.1:9002';
$('wsDomain').value = localStorage.getItem('shin.wsDomain') || 'shininspector';

document.querySelectorAll('input[name="mode"]').forEach((r) => {
  r.onchange = () => { $('wsConfig').style.display = (r.value === 'ws' ? 'block' : 'none'); };
});

function showError(msg) {
  $('err').textContent = msg;
  $('err').style.display = 'block';
}
function clearError() { $('err').style.display = 'none'; }

// 用一次真实 Connect 握手校验「地址 + 域名」；只有服务端认这个域名才返回成功。
// 域名不对时 WS 服务端在首帧路由阶段直接断连，SDK 的 onclose 会立即 reject（无需超时兜底）。
async function validateWs(url, domain) {
  await IObjectClient.connect(url, { domain });
}

$('btnGo').onclick = async () => {
  clearError();
  const mode = document.querySelector('input[name="mode"]:checked').value;

  if (mode === 'ws') {
    const url = $('wsUrl').value.trim() || 'ws://127.0.0.1:9002';
    const domain = $('wsDomain').value.trim() || 'shininspector';
    $('btnGo').disabled = true;
    $('btnGo').textContent = '校验中…';
    try {
      await validateWs(url, domain); // 校验失败会抛异常，停在本页
      localStorage.setItem('shin.mode', 'ws');
      localStorage.setItem('shin.wsUrl', url);
      localStorage.setItem('shin.wsDomain', domain);
      location.href = 'index.html';
    } catch (e) {
      const why = (e && (e.code ? e.code + ': ' + e.message : e.message)) || String(e);
      showError('无法进入调试页：' + why + '（请检查地址与域名；domain 必须与宿主注册的路由键逐字一致，当前为 "shininspector"）');
    } finally {
      $('btnGo').disabled = false;
      $('btnGo').textContent = '进入调试';
    }
    return;
  }

  // IPC 本机零拷贝，无地址/域名可校验，直接进入。
  localStorage.setItem('shin.mode', 'ipc');
  location.href = 'index.html';
};
