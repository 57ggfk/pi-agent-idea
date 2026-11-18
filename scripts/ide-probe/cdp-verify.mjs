// bare CDP over native WebSocket — verify 048 browser tab behaviours
import http from 'node:http';

const getJSON = (path) => new Promise((res, rej) => {
  http.get('http://127.0.0.1:9222' + path, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>res(JSON.parse(d))); }).on('error',rej);
});

const targets = await getJSON('/json/list');
const page = targets.find(t => t.type === 'page' && t.title === 'PI-BROWSER-PROBE-TITLE');
if (!page) { console.log('NO BROWSER PAGE FOUND'); process.exit(1); }
console.log('page url before:', page.url);

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
await new Promise(r => ws.onopen = r);
const send = (method, params={}) => new Promise(r => { const i=++id; pending.set(i,r); ws.send(JSON.stringify({id:i,method,params})); });
const evalJs = async (expression) => {
  const m = await send('Runtime.evaluate', {expression, returnByValue:true, awaitPromise:true});
  return m.result?.result?.value;
};

await send('Runtime.enable');
console.log('title before:', await evalJs('document.title'));
console.log('h1 before:', await evalJs('document.getElementById("marker")?.textContent'));

// click target=_blank button — should navigate IN PLACE, no new window
await evalJs('document.getElementById("popup").click()');
await new Promise(r => setTimeout(r, 1500));

// find the (possibly recreated) browser page after in-place nav
const targets2 = await getJSON('/json/list');
const pages = targets2.filter(t => t.type === 'page');
console.log('page count after popup click:', pages.length, '(chat + markdown + browser = 3 expected)');
const navPage = targets2.find(t => t.type === 'page' && t.url.includes('/preview/'));
console.log('browser url after:', navPage?.url);
console.log('page title after:', navPage?.title);

ws.close();
