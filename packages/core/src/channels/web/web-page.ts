/**
 * web channel 内嵌测试页（单文件、无外部依赖；tsc 不拷贝静态资源，故内嵌为常量）。
 * 注意：内联 JS 一律用字符串拼接，不用反引号/模板字面量 —— 它们在外层 TS template literal 中需转义。
 */
export const WEB_PAGE_HTML = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>kda channel</title>
<style>
  :root { --bg:#111418; --panel:#1a1f26; --border:#2a313b; --text:#d7dde6; --dim:#7d8896; --accent:#4cc2ff; --me:#28402e; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.5 ui-monospace,Menlo,Consolas,monospace; display:flex; flex-direction:column; height:100vh; }
  header { display:flex; align-items:center; gap:10px; padding:10px 16px; border-bottom:1px solid var(--border); background:var(--panel); }
  header h1 { font-size:14px; margin:0; font-weight:600; color:var(--accent); }
  #meta { color:var(--dim); font-size:12px; }
  #dot { width:8px; height:8px; border-radius:50%; background:#e5484d; margin-left:auto; }
  #dot.on { background:#46a758; }
  #chat { flex:1; overflow-y:auto; padding:16px; display:flex; flex-direction:column; gap:10px; }
  .msg { max-width:80%; padding:8px 12px; border-radius:10px; white-space:pre-wrap; word-break:break-word; }
  .msg .who { font-size:11px; color:var(--dim); margin-bottom:2px; }
  .msg.me { align-self:flex-end; background:var(--me); }
  .msg.me.pending { opacity:.55; }
  .msg.agent { align-self:flex-start; background:var(--panel); border:1px solid var(--border); }
  .sys { align-self:center; color:var(--dim); font-size:12px; }
  footer { display:flex; gap:8px; padding:12px 16px; border-top:1px solid var(--border); background:var(--panel); }
  #sender { width:130px; background:var(--bg); border:1px solid var(--border); color:var(--text); border-radius:6px; padding:8px; }
  #text { flex:1; background:var(--bg); border:1px solid var(--border); color:var(--text); border-radius:6px; padding:8px; }
  button { background:var(--accent); border:0; color:#08222e; font-weight:600; border-radius:6px; padding:8px 16px; cursor:pointer; }
</style>
</head>
<body>
<header>
  <h1>kda · web channel</h1>
  <span id="meta">same agent session as the terminal</span>
  <span id="dot"></span>
</header>
<div id="chat"></div>
<footer>
  <input id="sender" title="sender name">
  <input id="text" placeholder="message… (Enter to send)" autocomplete="off">
  <button id="send">Send</button>
</footer>
<script>
(function () {
  var chat = document.getElementById("chat");
  var senderEl = document.getElementById("sender");
  var textEl = document.getElementById("text");
  var sendBtn = document.getElementById("send");
  var dot = document.getElementById("dot");

  senderEl.value = localStorage.getItem("kda-sender") || "web-user";
  senderEl.addEventListener("change", function () {
    localStorage.setItem("kda-sender", senderEl.value.trim() || "web-user");
  });

  function bubble(cls, who, text) {
    var div = document.createElement("div");
    div.className = "msg " + cls;
    var w = document.createElement("div");
    w.className = "who";
    w.textContent = who;
    var t = document.createElement("div");
    t.textContent = text;
    div.appendChild(w);
    div.appendChild(t);
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
    return div;
  }
  function sys(text) {
    var div = document.createElement("div");
    div.className = "sys";
    div.textContent = text;
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
  }

  // 自己发出的消息按 id 挂 pending，收到 replyTo === id 的回复后消除
  var pending = {};

  function send() {
    var text = textEl.value.trim();
    if (!text) return;
    var sender = senderEl.value.trim() || "web-user";
    fetch("/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: text, sender: sender })
    }).then(function (r) { return r.json(); }).then(function (data) {
      if (!data.ok) { sys("send failed: " + (data.error || "unknown")); return; }
      var node = bubble("me", sender, text);
      node.classList.add("pending");
      pending[data.id] = node;
      textEl.value = "";
    }).catch(function () { sys("send failed: network error"); });
  }

  sendBtn.addEventListener("click", send);
  textEl.addEventListener("keydown", function (e) {
    if (e.key === "Enter") send();
  });

  var es = new EventSource("/api/events");
  es.onopen = function () { dot.classList.add("on"); };
  es.onerror = function () { dot.classList.remove("on"); };
  es.onmessage = function (e) {
    var data = JSON.parse(e.data);
    var node = data.replyTo && pending[data.replyTo];
    if (node) {
      node.classList.remove("pending");
      delete pending[data.replyTo];
    }
    bubble("agent", "agent", data.text);
  };
})();
</script>
</body>
</html>
`;
