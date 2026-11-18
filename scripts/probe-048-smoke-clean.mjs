// 048 内置浏览器 P0 —— 干净安装版真机冒烟探针（自包含 + 轮询等待）
// 连接 preview 页 CDP，验证：marker 渲染 / popup 拦截同页导航 / target 数不增
import fs from 'node:fs';

const WS = fs.readFileSync('D:/code/github/pi-agent-idea-wt/release-0.5.10-20261116/build/.preview_ws.txt', 'utf8').trim();
const HTTP = 'http://127.0.0.1:9222/json/list';

let seq = 0;
const pending = new Map();
let ws;

function send(method, params = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 从干净 base URL 开始（去掉上次点击留下的 query）
const cleanUrl = WS && (await (async () => {
  const d = await (await fetch(HTTP)).json();
  const t = d.find(x => x.url.includes('/preview/'));
  return t ? t.url.split('?')[0] : null;
})());
if (!cleanUrl) { console.error('no preview target'); process.exit(2); }

ws = new WebSocket(WS);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  }
};
await send('Runtime.enable');
await send('Page.enable');

async function targets() {
  return (await (await fetch(HTTP)).json()).filter(t => t.type === 'page');
}
async function evalJs(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  return r.result.value;
}
// 轮询等待表达式为真（页面导航期间 DOM 会短暂失效）
async function waitFor(expr, pred, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await evalJs(expr);
      if (last && pred(JSON.parse(last))) return JSON.parse(last);
    } catch (e) { /* context 重建中 */ }
    await sleep(200);
  }
  return last ? JSON.parse(last) : null;
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name} | ${detail}`);
}

// 0) 使用外部已打开的干净 preview 页（不主动 navigate：token 白名单需走 kernel.load）
const initial = await waitFor(
  `JSON.stringify({title:document.title,marker:document.getElementById('marker')?.textContent,urlslot:document.getElementById('urlslot')?.textContent,hasPopup:!!document.getElementById('popup'),search:location.search,href:location.href})`,
  o => o && o.marker === 'PI-BROWSER-PROBE-H1'
);
check('干净 preview 已加载', initial?.marker === 'PI-BROWSER-PROBE-H1', `loaded=${initial?.marker === 'PI-BROWSER-PROBE-H1'}`);
check('标题正确', initial?.title === 'PI-BROWSER-PROBE-TITLE', `title=${initial?.title}`);
check('marker H1 渲染', initial?.marker === 'PI-BROWSER-PROBE-H1', `marker=${initial?.marker}`);
check('popup 按钮存在', initial?.hasPopup === true, `hasPopup=${initial?.hasPopup}`);
check('初始无 query', initial?.search === '', `search=${initial?.search}`);
check('初始 path 槽正确', initial?.urlslot === 'path=', `urlslot=${initial?.urlslot}`);

const beforeTargets = (await targets()).length;

// 1) 真实 CDP 鼠标点击 popup 按钮（程序化 .click() 不触发 JCEF onBeforePopup）
const rect = await waitFor(
  `(()=>{const e=document.getElementById('popup');if(!e)return 'null';const r=e.getBoundingClientRect();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2})})()`,
  o => o && typeof o.x === 'number'
);
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });

// 2) 轮询等待 popup 同页导航完成
const afterClick = await waitFor(
  `JSON.stringify({title:document.title,urlslot:document.getElementById('urlslot')?.textContent,search:location.search,href:location.href})`,
  o => o && o.search?.includes('popup=1')
);
check('popup 同页导航到 ?popup=1', afterClick?.search?.includes('popup=1') === true, `search=${afterClick?.search}`);
check('导航后 URL 仍是 preview 根', afterClick?.href?.includes('/preview/') === true, `href=${afterClick?.href}`);
check('urlslot 反映 query', afterClick?.urlslot === 'path=?popup=1', `urlslot=${afterClick?.urlslot}`);

const afterTargets = (await targets()).length;
check('popup 未新增 page target', afterTargets === beforeTargets, `before=${beforeTargets} after=${afterTargets}`);
check('preview target 唯一', (await targets()).filter(t => t.url.includes('/preview/')).length === 1, 'ok');

const pass = results.filter(r => r.ok).length;
console.log(`\n=== ${pass}/${results.length} PASS ===`);
ws.close();
process.exit(pass === results.length ? 0 : 1);
