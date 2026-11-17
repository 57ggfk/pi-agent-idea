// 041#9 真机探针：让 pi 输出内联 svg 代码块，探「在 IDE 打开」(openSnippet) 路径
// 用法: node probe-041-svg.mjs <port> <stage>   stage=feed|inspect|clicksnippet
import { writeFileSync } from "node:fs";

const PORT = process.argv[2] || "9223";
const STAGE = process.argv[3] || "feed";
const CDP = `http://127.0.0.1:${PORT}`;
const OUT = `${process.env.TEMP || "/tmp"}/fb-041-${STAGE}.json`;

async function withPage(fn) {
  const pages = await (await fetch(`${CDP}/json/list`)).json();
  const p = pages.find((x) => /token=/.test(x.url));
  if (!p) throw new Error("no pi page");
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/devtools/page/${p.id}`);
  let n = 1;
  const pend = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); }
  };
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const send = (method, params = {}) => new Promise((r) => {
    const id = n++; pend.set(id, r); ws.send(JSON.stringify({ id, method, params }));
  });
  try { return await fn(send); } finally { ws.close(); }
}
const ev = (send, expression) => send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function feed(send) {
  const PROMPT = "请只输出一个 markdown 代码块，语言标记为 svg，内容是 <svg xmlns=\"http://www.w3.org/2000/svg\" width=\"100\" height=\"100\"><circle cx=\"50\" cy=\"50\" r=\"40\" fill=\"tomato\"/></svg>。不要任何其它文字。";
  const r = await ev(send, `(() => {
    const ta = document.querySelector('[data-testid="composer-input"]');
    if (!ta) return {err:'no composer'};
    const setter = Object.getOwnPropertyDescriptor(HTMLElement.prototype,'value')?.set
      || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')?.set;
    if (setter) setter.call(ta, ${JSON.stringify(PROMPT)}); else ta.textContent = ${JSON.stringify(PROMPT)};
    ta.dispatchEvent(new Event('input',{bubbles:true}));
    return {len:(ta.value||ta.textContent||'').length};
  })()`);
  await sleep(400);
  await ev(send, `document.querySelector('[data-testid="send-btn"]')?.click()`);
  const start = Date.now();
  let last = null;
  while (Date.now() - start < 120000) {
    await sleep(1500);
    last = await ev(send, `(() => {
      const mds=[...document.querySelectorAll('.markdown')];
      const lastMd=mds[mds.length-1]?.textContent||'';
      return {mdCount:mds.length, hasSvg:/<svg[\\s\\S]*<\\/svg>/.test(lastMd),
        busy:!!document.querySelector('[data-testid=status-dot].busy')||/停止|中断/.test(document.body.innerText.slice(-200)),
        len:lastMd.length};
    })()`);
    const v = last.result?.value || {};
    if (v.hasSvg && v.mdCount >= 2) break;
  }
  return { sent: r.result?.value, final: last?.result?.value };
}

async function inspect(send) {
  return (await ev(send, `(() => {
    const pres=[...document.querySelectorAll('.markdown pre')];
    return pres.map((pre,i)=>({
      i,
      cls:pre.className,
      lang:pre.querySelector('code')?.className||'',
      hasSvg:/<svg/.test(pre.textContent||''),
      btns:[...pre.querySelectorAll('button,a,[role=button]')].map(b=>({t:(b.textContent||'').trim().slice(0,30), title:b.title||'', testid:b.getAttribute('data-testid')||''}))
    })).filter(x=>x.hasSvg);
  })()`)).result?.value;
}

async function clickSnippet(send) {
  const before = (await ev(send, `document.body.innerText.slice(-300)`)).result?.value;
  const r = await ev(send, `(() => {
    const pre=[...document.querySelectorAll('.markdown pre')].find(p=>/<svg/.test(p.textContent||''));
    if(!pre) return {err:'no svg pre'};
    const btn=[...pre.querySelectorAll('button,a,[role=button]')].find(b=>/打开|open/i.test((b.textContent||'')+' '+(b.title||'')));
    if(!btn) return {err:'no open btn', html:pre.parentElement?.outerHTML.slice(0,600)};
    btn.click();
    return {clicked:true, label:(btn.textContent||'').trim()};
  })()`);
  await sleep(1200);
  const after = (await ev(send, `document.body.innerText.slice(-300)`)).result?.value;
  return { click: r.result?.value, before, after };
}

(async () => {
  const report = { port: PORT, stage: STAGE, at: new Date().toISOString() };
  try {
    report.result = await withPage(async (send) => {
      if (STAGE === "feed") return feed(send);
      if (STAGE === "inspect") return inspect(send);
      if (STAGE === "clicksnippet") return clickSnippet(send);
      return { err: "unknown stage" };
    });
    report.ok = true;
  } catch (e) { report.ok = false; report.error = String(e?.stack || e); }
  writeFileSync(OUT, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
})();
