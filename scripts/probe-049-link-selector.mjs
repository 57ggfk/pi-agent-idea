// 049 A3 —— 链接选择器真机探针（聊天页 CDP 侧）
// 用法：node scripts/probe-049-link-selector.mjs [port]
//   注入一个外链到聊天消息区，真实鼠标点击它，断言 CEF 导航被取消
//   （ASK 态的选择器是 Swing 弹层，由 win_ui.py / 截图在 bash 侧验证）
//   `clean` 子命令：移除注入的测试链接
import fs from 'node:fs';

const PORT = process.argv[2] || '9222';
const HTTP = `http://127.0.0.1:${PORT}/json/list`;
const LINK_ID = 'pi-049-route-test-link';
const LINK_URL = 'https://example.com/pi-049-route-test';

let seq = 0;
const pending = new Map();
const targets = async () => (await (await fetch(HTTP)).json()).filter(t => t.type === 'page');
const pages = await targets();
const chat = pages.find(t => t.url.includes('token=') && t.url.includes('instance=1'));
if (!chat) { console.error('FAIL | no chat target'); process.exit(2); }

const ws = new WebSocket(chat.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  }
};
const send = (method, params = {}) => {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const evalJs = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result.value;

await send('Runtime.enable');
await send('Page.enable');

// 注入测试链接（消息区顶部，绝对定位避免干扰列表）
await evalJs(`(() => {
  document.getElementById('${LINK_ID}')?.remove();
  const a = document.createElement('a');
  a.id = '${LINK_ID}';
  a.href = '${LINK_URL}';
  a.textContent = '[pi-049 route test link]';
  a.style.cssText = 'position:fixed;top:8px;right:8px;z-index:99999;background:#37474f;color:#fff;padding:6px 10px;border-radius:4px;font-size:12px;';
  document.body.appendChild(a);
  return true;
})()`);

const before = await evalJs('location.href');

// 真实鼠标点击（程序化 .click() 不触发 CEF 导航链路）
const rect = JSON.parse(await evalJs(`(() => { const r = document.getElementById('${LINK_ID}').getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`));
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
await sleep(1000);

const after = await evalJs('location.href');
const linkStill = await evalJs(`!!document.getElementById('${LINK_ID}')`);

const navCancelled = after === before; // ASK 态：选择器决定去向，CEF 导航必须已取消
console.log(`${navCancelled ? 'PASS' : 'FAIL'} | CEF 导航已取消（选择器接管） | before=${before.slice(0, 60)} after=${after.slice(0, 60)}`);
console.log(`${linkStill ? 'PASS' : 'FAIL'} | 测试链接仍在 | id=${LINK_ID}`);
console.log(`INFO | link screen pos: 由 bash 侧 win_ui.py 列 Swing 弹层确认选择器窗口`);

if (process.argv[3] === 'clean') {
  await evalJs(`document.getElementById('${LINK_ID}')?.remove(); true`);
}
ws.close();
process.exit(navCancelled ? 0 : 1);
