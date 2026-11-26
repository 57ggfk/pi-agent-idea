// 069 真机探针:给 Pi 聊天 composer 发一条让 agent 走完整 068+069 链路的指令
// (复用 067 验证过的 CDP 真实键鼠流程)。真机前置:
//   PI_IDE_E2E=real PI_IDE_E2E_PROJECT=<repo>/test/e2e-project ./gradlew runIde
// 先手动(或让 agent open)打开 test/e2e-project/demo/agent-actions.html,
// 再跑: node build/ide-probe/069-agent-actions.mjs
import http from 'node:http';

const PROMPT = process.argv[2] ||
  '用 pi_browser 验证 demo/agent-actions.html：先 list 看看当前页签，然后 type 到 #inp 输入「你好 pi」，click #btn，用 read 确认 #out 出现了 btn clicked，再用 evaluate 取 document.title，把每步返回的 tab 字段和结果告诉我。';

const getJSON = (path) => new Promise((res, rej) => {
  http.get('http://127.0.0.1:9222' + path, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>res(JSON.parse(d))); }).on('error',rej);
});

const targets = await getJSON('/json/list');
// 聊天 SPA = 带 token 的本地 UI 页(不含 /preview/ 的那个)
const chat = targets.find(t => t.type === 'page' && t.url.includes('token=') && !t.url.includes('/preview/') && !t.url.startsWith('file://'));
if (!chat) { console.log('NO CHAT PAGE', targets.map(t=>t.url)); process.exit(1); }
console.log('chat url ok');

const ws = new WebSocket(chat.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
await new Promise(r => ws.onopen = r);
const send = (method, params={}) => new Promise(r => { const i=++id; pending.set(i,r); ws.send(JSON.stringify({id:i,method,params})); });
const evalJs = async (expression) => {
  const m = await send('Runtime.evaluate', {expression, returnByValue:true, awaitPromise:true});
  if (m.result?.error) throw new Error(m.result.error.message ?? 'eval error');
  return m.result?.result?.value;
};
await send('Runtime.enable');

// 定位 composer(textarea 或 contenteditable)
const rect = await evalJs(`(() => {
  const el = document.querySelector('textarea') || document.querySelector('[contenteditable="true"]');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return {x: r.x + r.width/2, y: Math.min(r.y + r.height/2, r.y + 20), w: r.width, h: r.height, tag: el.tagName};
})()`);
if (!rect) { console.log('NO COMPOSER'); process.exit(1); }
console.log('composer at', JSON.stringify(rect));

await send('Input.dispatchMouseEvent', {type:'mouseMoved', x:rect.x, y:rect.y});
await send('Input.dispatchMouseEvent', {type:'mousePressed', x:rect.x, y:rect.y, button:'left', clickCount:1});
await send('Input.dispatchMouseEvent', {type:'mouseReleased', x:rect.x, y:rect.y, button:'left', clickCount:1});
await new Promise(r => setTimeout(r, 400));

await send('Input.insertText', {text: PROMPT});
await new Promise(r => setTimeout(r, 300));
console.log('inserted, chars:', PROMPT.length);

await send('Input.dispatchKeyEvent', {type:'rawKeyDown', windowsVirtualKeyCode:13, code:'Enter', key:'Enter'});
await send('Input.dispatchKeyEvent', {type:'keyDown', windowsVirtualKeyCode:13, code:'Enter', key:'Enter'});
await send('Input.dispatchKeyEvent', {type:'char', text:'\r', windowsVirtualKeyCode:13, code:'Enter', key:'Enter'});
await send('Input.dispatchKeyEvent', {type:'keyUp', windowsVirtualKeyCode:13, code:'Enter', key:'Enter'});
console.log('enter sent — 人工核对要点:');
console.log('  1 list 回答枚举 t*/e* 页签且 selected 正确');
console.log('  2 type/click/evaluate 回答都带 tab 字段且与操作页签一致');
console.log('  3 click 后 #out 变成 btn clicked…(read 佐证)');
console.log('  4 type 后 #inp 的值为「你好 pi」(React setter 生效)');
console.log('  5 evaluate 的 value 返回页面标题字符串');
console.log('  6 故意 click #missing 应回 found:false + reason,不崩');
ws.close();
