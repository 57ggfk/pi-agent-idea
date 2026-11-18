// probe-042 test server: plain HTTP pages + HTTPS variants (self-signed /
// wrong-domain / private-CA). Temporary exploration asset — NOT part of the
// plugin repo. Run: node server.mjs
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

function page(title, body, extraHead = "") {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${extraHead}</head><body>${body}</body></html>`;
}

const routes = {
  "/": () => page("probe042 index", `<h1>probe042</h1><ul>
    <li><a href="/console.html">console</a></li>
    <li><a href="/element.html">element</a></li>
    <li><a href="/csp.html">csp</a></li>
    <li><a href="/cookie-set.html">cookie-set</a></li>
    <li><a href="/cookie-read.html">cookie-read</a></li>
    <li><a href="/popup.html">popup</a></li>
    <li><a href="/download.html">download</a></li>
    <li><a href="/attach.bin">download file (attachment)</a></li></ul>`),

  "/console.html": () => page("console probe", `<h1>console</h1><script>
    console.log("p042 log line", {i: 1});
    console.info("p042 info line");
    console.warn("p042 warn line");
    console.error("p042 error line");
    const obj = {big: new Array(50).fill("x").join("")};
    console.log("p042 object", obj);
    try { null.foo } catch (e) { console.error("p042 caught:", e.message) }
    setTimeout(() => { try { ({}).bar() } catch (e) { console.debug("p042 debug:", e.message) } }, 50);
  </script>`),

  "/element.html": () => page("element probe", `
    <style>.box { color: rgb(18, 52, 86); font-size: 14px; padding: 4px 8px; }</style>
    <div id="root"><section><h1 id="target-heading">Target Heading</h1>
    <button id="target-button" class="box" style="margin-top:8px">Click me</button>
    <ul id="list"><li>a</li><li>b</li><li>c</li></ul></section></div>`),

  "/csp.html": () => page("csp probe", `<h1>csp</h1>`,
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'">`),

  "/cookie-set.html": () => page("cookie set", `<h1>set</h1><script>
    document.cookie = "probe042=hello; path=/";
    document.title = "cookie-set done";
  </script>`),

  "/cookie-read.html": () => page("cookie read", `<h1>read</h1>`),

  "/popup.html": () => page("popup probe", `<a id="pop" href="/popup-child.html" target="_blank">open child</a>
    <script>document.getElementById("pop").addEventListener("click", () => {
      console.log("p042 popup clicked");
    });</script>`),
  "/popup-child.html": () => page("popup child", `<h1>popup child</h1>`),

  "/fps.html": () => page("fps probe", `<div id="out">counting…</div><div style="height:2000px"></div><script>
    // rAF counter: title = frames in the last 5s window, for external CDP readout
    let n = 0;
    function loop() { n++; requestAnimationFrame(loop); }
    requestAnimationFrame(loop);
    setInterval(() => { document.title = n + "f/5s"; n = 0; }, 5000);
    document.title = "fps counting";
  </script>`),
  "/download.html": () => page("download probe", `<a id="dl" href="/attach.bin">download bin</a>
    <script>document.getElementById("dl").addEventListener("click", () => {
      console.log("p042 download clicked");
    });</script>`),
  "/attach.bin": (req, res) => {
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": 'attachment; filename="probe042.bin"',
    });
    res.end(Buffer.alloc(64 * 1024, 7));
  },
};

const httpServer = http.createServer((req, res) => {
  const route = routes[req.url.split("?")[0]];
  if (!route) { res.writeHead(404); res.end("no route"); return; }
  const out = route(req, res);
  if (typeof out === "string") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(out);
  }
});

const tlsOpts = (cert, key) => ({ cert: fs.readFileSync(cert), key: fs.readFileSync(key) });

httpServer.listen(8771, "127.0.0.1", () => console.log("http  http://127.0.0.1:8771/"));
https.createServer(tlsOpts(path.join(ROOT, "certs/self-signed.crt"), path.join(ROOT, "certs/self-signed.key")), (req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(page("https self-signed OK", "<h1>self-signed page loaded</h1>"));
}).listen(8772, "127.0.0.1", () => console.log("https self-signed  https://127.0.0.1:8772/"));
https.createServer(tlsOpts(path.join(ROOT, "certs/wrong-domain.crt"), path.join(ROOT, "certs/wrong-domain.key")), (req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(page("https wrong-domain OK", "<h1>wrong-domain page loaded</h1>"));
}).listen(8773, "127.0.0.1", () => console.log("https wrong-domain https://127.0.0.1:8773/"));
https.createServer(tlsOpts(path.join(ROOT, "certs/private-ca.crt"), path.join(ROOT, "certs/private-ca.key")), (req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(page("https private-CA OK", "<h1>private-CA page loaded</h1>"));
}).listen(8774, "127.0.0.1", () => console.log("https private-CA  https://127.0.0.1:8774/"));
