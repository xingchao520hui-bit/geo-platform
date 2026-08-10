// 全页dump：当前状态 + 所有可见可点元素
const list = await (await fetch('http://127.0.0.1:3310/json/list')).json();
const tab = list.find(t => t.url && t.url.includes('/edit'));
if (!tab) { console.log('NO_EDIT_TAB'); process.exit(1); }
function evalTab(wsUrl, expr) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(wsUrl);
    const t = setTimeout(() => { ws.close(); rej(new Error('timeout')); }, 12000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id === 1) { clearTimeout(t); ws.close(); res(m.result?.result?.value); } };
  });
}
const wsUrl = tab.webSocketDebuggerUrl;
const st = await evalTab(wsUrl, `JSON.stringify({
  url: location.href,
  bodyLen: ((document.querySelector('.public-DraftEditor-content')||{}).innerText||'').length,
  allClickables: [...document.querySelectorAll('button,a,[role=button],div[tabindex]')]
    .filter(e=>e.offsetParent!==null)
    .map(e=>({tag:e.tagName,cls:(e.className||'').toString().slice(0,50),txt:e.textContent.trim().slice(0,20)}))
    .filter(x=>x.txt)
    .slice(-30)
})`);
console.log(st);
process.exit(0);
