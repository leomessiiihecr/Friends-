(function () {
  "use strict";

  var BROKER = "wss://broker.emqx.io:8084/mqtt";
  var NS = "barasalfa-kora/v1/";
  var BOT_NAMES = ["بوت أبو فهد", "بوت الكابتن", "بوت المعلّق"];
  var SHIRTS = ["#f2c230", "#5fb8ff", "#2fb36a", "#ff8a5b", "#d9e4ff", "#c8a6ff", "#ffd1dc", "#9be3c9", "#f7a8a8", "#e9f1e4", "#ffc56b", "#8fd3ff"];
  var MAX_PLAYERS = 12;
  var STALE_MS = 3 * 60 * 1000;

  var app = document.getElementById("app");
  var bar = document.getElementById("bar");
  var netDot = document.getElementById("net");

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function shuffle(a) {
    a = a.slice();
    for (var i = a.length - 1; i > 0; i--) { var j = (Math.random() * (i + 1)) | 0; var t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }
  function uid() { return Math.random().toString(36).slice(2, 10); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function cleanName(n) { return String(n || "").replace(/\s+/g, " ").trim().slice(0, 18) || "لاعب"; }
  function rand(a) { return a[(Math.random() * a.length) | 0]; }

  var toastTimer;
  function toast(msg) {
    var t = document.getElementById("toast");
    t.textContent = msg; t.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove("show"); }, 2600);
  }

  var myId = sessionStorage.getItem("bsk_id") || uid();
  sessionStorage.setItem("bsk_id", myId);

  var mode = null;   // null | "solo" | "host" | "guest"
  var code = null;
  var S = null;      // state as rendered
  var H = null;      // authoritative state (host / solo)
  var client = null;
  var ui = { revealed: false, round: -1, joinOpen: false, guessPick: null };
  var timers = [];
  var heartbeat = null, watchdog = null, joinTimer = null, joinDeadline = null;
  var lastStateAt = 0;

  function later(fn, ms) { var t = setTimeout(fn, ms); timers.push(t); return t; }
  function clearTimers() { timers.forEach(clearTimeout); timers = []; }

  /* ================= words (no repeats) ================= */
  var CATS = Object.keys(window.WORDS);
  function pickWord() {
    var used = [];
    try { used = JSON.parse(localStorage.getItem("bsk_used") || "[]"); } catch (e) { used = []; }
    var all = [];
    CATS.forEach(function (c) { window.WORDS[c].forEach(function (w) { all.push({ cat: c, word: w }); }); });
    var avail = all.filter(function (x) { return used.indexOf(x.word) === -1; });
    if (!avail.length) {
      var last = used[used.length - 1];
      used = [];
      avail = all.filter(function (x) { return x.word !== last; });
    }
    // prefer a category different from the last round's to keep things fresh
    if (H && H.category) {
      var other = avail.filter(function (x) { return x.cat !== H.category; });
      if (other.length) avail = other;
    }
    var p = rand(avail);
    used.push(p.word);
    localStorage.setItem("bsk_used", JSON.stringify(used));
    return p;
  }

  /* ================= host logic ================= */
  function hostInit(c, solo) {
    H = {
      code: c, hostId: myId, solo: !!solo, phase: "lobby", round: 0,
      players: [{ id: myId, name: myName(), bot: false, score: 0, online: true, shirt: 0 }],
      roundIds: [], category: null, word: null, outsiderId: null, options: [], votes: {},
      firstAsker: null, tally: null, result: null, ts: 0
    };
    if (solo) BOT_NAMES.forEach(function (n, i) {
      H.players.push({ id: "bot" + i, name: n, bot: true, score: 0, online: true, shirt: i + 1 });
    });
    commit();
  }
  function hp(id) { return H.players.filter(function (p) { return p.id === id; })[0]; }
  function nextShirt() {
    var taken = H.players.map(function (p) { return p.shirt; });
    for (var i = 0; i < SHIRTS.length; i++) if (taken.indexOf(i) === -1) return i;
    return H.players.length % SHIRTS.length;
  }

  function commit() {
    H.ts = Date.now();
    S = clone(H);
    if (mode === "host" && client && client.connected) {
      client.publish(NS + code + "/state", JSON.stringify(H), { qos: 1, retain: true });
    }
    render();
  }

  function onAction(a) {
    if (!H || !a || !a.from) return;
    var p = hp(a.from);
    switch (a.type) {
      case "join":
        if (p) { p.online = true; if (a.name) p.name = cleanName(a.name); }
        else {
          if (H.players.length >= MAX_PLAYERS) return;
          H.players.push({ id: a.from, name: cleanName(a.name), bot: false, score: 0, online: true, shirt: nextShirt() });
        }
        commit();
        break;
      case "leave":
        if (!p || p.id === H.hostId) return;
        if (H.phase === "lobby" && !p.score) H.players = H.players.filter(function (x) { return x.id !== p.id; });
        else p.online = false;
        commit();
        afterLeave(p.id);
        break;
      case "vote":
        if (H.phase !== "vote" || H.roundIds.indexOf(a.from) === -1 || H.roundIds.indexOf(a.target) === -1 || a.target === a.from) return;
        H.votes[a.from] = a.target;
        commit();
        checkVotes();
        break;
      case "guess":
        if (H.phase !== "guess" || a.from !== H.outsiderId) return;
        resolveGuess(String(a.word));
        break;
    }
  }

  function afterLeave(id) {
    if (H.phase === "vote") checkVotes();
    else if (H.phase === "guess" && id === H.outsiderId) resolveGuess(null);
  }

  function onlineRound() {
    return H.roundIds.filter(function (id) { var p = hp(id); return p && p.online; });
  }

  function startRound() {
    var active = H.players.filter(function (p) { return p.online; });
    if (active.length < 3) { toast("تحتاجون 3 لاعبين على الأقل لبدء الجولة"); return; }
    clearTimers();
    var pick = pickWord();
    var others = shuffle(window.WORDS[pick.cat].filter(function (w) { return w !== pick.word; })).slice(0, 5);
    H.round++;
    H.phase = "reveal";
    H.roundIds = active.map(function (p) { return p.id; });
    H.category = pick.cat;
    H.word = pick.word;
    H.outsiderId = rand(active).id;
    H.options = shuffle([pick.word].concat(others));
    H.votes = {}; H.tally = null; H.result = null;
    H.firstAsker = rand(active).id;
    commit();
  }

  function startVote() {
    if (H.phase !== "reveal") return;
    H.phase = "vote"; H.votes = {};
    commit();
    var round = H.round;
    H.roundIds.forEach(function (id) {
      var p = hp(id);
      if (!p || !p.bot) return;
      later(function () {
        if (!H || H.phase !== "vote" || H.round !== round) return;
        var targets = onlineRound().filter(function (t) { return t !== id; });
        // bots that are "in" lean slightly toward the real outsider
        var target = (id !== H.outsiderId && Math.random() < 0.4 && targets.indexOf(H.outsiderId) !== -1) ? H.outsiderId : rand(targets);
        onAction({ type: "vote", from: id, target: target });
      }, 1200 + Math.random() * 2800);
    });
  }

  function checkVotes() {
    if (H.phase !== "vote") return;
    var voters = onlineRound();
    if (voters.length && voters.every(function (id) { return H.votes[id]; })) tally();
  }

  function tally() {
    var counts = {}, max = 0;
    Object.keys(H.votes).forEach(function (v) { var t = H.votes[v]; counts[t] = (counts[t] || 0) + 1; });
    Object.keys(counts).forEach(function (k) { if (counts[k] > max) max = counts[k]; });
    var top = Object.keys(counts).filter(function (k) { return counts[k] === max; });
    var caught = max > 0 && top.length === 1 && top[0] === H.outsiderId;
    H.tally = { counts: counts, top: top, caught: caught };
    if (!caught) { finish({ caught: false, guess: null, correct: false }); return; }
    H.phase = "guess";
    commit();
    var o = hp(H.outsiderId), round = H.round;
    if (!o || !o.online) { resolveGuess(null); return; }
    if (o.bot) {
      later(function () {
        if (!H || H.phase !== "guess" || H.round !== round) return;
        var wrong = H.options.filter(function (w) { return w !== H.word; });
        resolveGuess(Math.random() < 0.35 ? H.word : rand(wrong));
      }, 2000);
    }
  }

  function resolveGuess(word) {
    if (H.phase !== "guess") return;
    finish({ caught: true, guess: word, correct: word === H.word });
  }

  function finish(r) {
    var deltas = {};
    if (!r.caught || r.correct) deltas[H.outsiderId] = 100;
    else Object.keys(H.votes).forEach(function (v) { if (H.votes[v] === H.outsiderId) deltas[v] = 100; });
    Object.keys(deltas).forEach(function (id) { var p = hp(id); if (p) p.score += deltas[id]; });
    r.deltas = deltas;
    H.result = r;
    H.phase = "result";
    commit();
  }

  /* ================= networking ================= */
  function send(a) {
    a.from = myId;
    if (mode === "solo" || mode === "host") { onAction(a); return; }
    if (client && client.connected) client.publish(NS + code + "/act", JSON.stringify(a), { qos: 1 });
    else toast("لا يوجد اتصال... جاري إعادة المحاولة");
  }

  function connect() {
    if (typeof mqtt === "undefined") { toast("تعذر تحميل مكتبة الاتصال، تحقق من الإنترنت"); goHome(); return false; }
    client = mqtt.connect(BROKER, {
      clientId: "bsk_" + myId + "_" + uid().slice(0, 4),
      clean: true, keepalive: 30, reconnectPeriod: 2000, connectTimeout: 10000,
      will: { topic: NS + code + "/act", payload: JSON.stringify({ type: "leave", from: myId }), qos: 1, retain: false }
    });
    client.on("connect", function () {
      setNet(true);
      if (mode === "host") {
        client.subscribe(NS + code + "/act", { qos: 1 }, function () { commit(); });
      } else if (mode === "guest") {
        client.subscribe(NS + code + "/state", { qos: 1 }, function () { sendJoin(); });
      }
    });
    client.on("close", function () { setNet(false); });
    client.on("offline", function () { setNet(false); });
    client.on("error", function () { setNet(false); });
    client.on("message", function (topic, payload) {
      var txt = payload.toString();
      if (mode === "host" && topic === NS + code + "/act") {
        try { onAction(JSON.parse(txt)); } catch (e) { }
      } else if (mode === "guest" && topic === NS + code + "/state") {
        onState(txt);
      }
    });
    return true;
  }

  function sendJoin() {
    if (mode !== "guest" || !client || !client.connected) return;
    client.publish(NS + code + "/act", JSON.stringify({ type: "join", from: myId, name: myName() }), { qos: 1 });
  }

  function onState(txt) {
    if (!txt) {
      if (S) { toast("أغلق المضيف الغرفة"); goHome(); }
      return;
    }
    var s;
    try { s = JSON.parse(txt); } catch (e) { return; }
    if (!s || s.code !== code) return;
    if (!S && Date.now() - s.ts > STALE_MS) return; // old abandoned room
    lastStateAt = Date.now();
    var inRoom = s.players.some(function (p) { return p.id === myId; });
    if (inRoom) { clearInterval(joinTimer); joinTimer = null; clearTimeout(joinDeadline); }
    else if (!joinTimer) {
      if (s.players.length >= MAX_PLAYERS) { toast("الغرفة ممتلئة"); goHome(); return; }
      joinTimer = setInterval(sendJoin, 2500);
    }
    S = s;
    render();
  }

  function setNet(on) { netDot.classList.toggle("on", !!on); }

  function myName() { return cleanName(localStorage.getItem("bsk_name")); }

  /* ================= entering / leaving ================= */
  function readName() {
    var inp = document.getElementById("nameIn");
    var n = inp.value.trim();
    if (!n) {
      inp.classList.remove("err"); void inp.offsetWidth; inp.classList.add("err");
      document.getElementById("errMsg").textContent = "اكتب اسمك أولاً";
      inp.focus();
      return null;
    }
    localStorage.setItem("bsk_name", cleanName(n));
    return n;
  }

  function startSolo() {
    if (!readName()) return;
    mode = "solo"; code = "SOLO";
    hostInit(code, true);
  }

  function createRoom() {
    if (!readName()) return;
    mode = "host";
    code = String(1000 + ((Math.random() * 9000) | 0));
    if (!connect()) return;
    hostInit(code, false);
    heartbeat = setInterval(function () { if (H) commit(); }, 15000);
    history.replaceState(null, "", "?room=" + code);
  }

  function joinRoom() {
    if (!readName()) return;
    var ci = document.getElementById("codeIn");
    var c = (ci.value || "").replace(/\D/g, "");
    if (c.length !== 4) {
      ci.classList.remove("err"); void ci.offsetWidth; ci.classList.add("err");
      document.getElementById("errMsg").textContent = "كود الغرفة 4 أرقام";
      return;
    }
    mode = "guest"; code = c; S = null;
    if (!connect()) return;
    renderConnecting();
    joinDeadline = setTimeout(function () {
      if (mode === "guest" && !S) { toast("ما لقينا غرفة بهذا الكود"); goHome(); }
    }, 9000);
    watchdog = setInterval(function () {
      if (mode === "guest" && S && Date.now() - lastStateAt > 45000) toast("انقطع الاتصال بالمضيف... ننتظر عودته");
    }, 15000);
    history.replaceState(null, "", "?room=" + code);
  }

  function goHome() {
    clearTimers();
    clearInterval(heartbeat); clearInterval(watchdog); clearInterval(joinTimer); clearTimeout(joinDeadline);
    heartbeat = watchdog = joinTimer = joinDeadline = null;
    if (client) {
      var c = client;
      try {
        if (mode === "host") c.publish(NS + code + "/state", "", { qos: 1, retain: true });
        else if (mode === "guest") c.publish(NS + code + "/act", JSON.stringify({ type: "leave", from: myId }), { qos: 1 });
      } catch (e) { }
      setTimeout(function () { try { c.end(true); } catch (e) { } }, 400);
    }
    client = null; mode = null; code = null; S = null; H = null;
    ui = { revealed: false, round: -1, joinOpen: false, guessPick: null };
    history.replaceState(null, "", location.pathname);
    render();
  }

  document.getElementById("exitBtn").onclick = function () {
    if (confirm("متأكد تبي تطلع من الغرفة؟")) goHome();
  };
  window.addEventListener("pagehide", function () {
    if (client && mode === "guest") try { client.publish(NS + code + "/act", JSON.stringify({ type: "leave", from: myId }), { qos: 0 }); } catch (e) { }
  });

  /* ================= rendering ================= */
  function isHost() { return mode === "solo" || mode === "host"; }
  function sp(id) { return S.players.filter(function (p) { return p.id === id; })[0]; }
  function pname(id) { var p = sp(id); return p ? p.name : "لاعب"; }

  function shirt(p) {
    return '<span class="shirt" style="background:' + SHIRTS[(p.shirt || 0) % SHIRTS.length] + '">' + esc(p.name.replace(/^بوت\s*/, "").charAt(0) || "؟") + "</span>";
  }
  function playerRow(p, extra) {
    var tags = "";
    if (p.id === S.hostId && !S.solo) tags += '<span class="tag host">المضيف</span>';
    if (p.id === myId) tags += '<span class="tag me">أنت</span>';
    if (p.bot) tags += '<span class="tag">بوت</span>';
    if (!p.online) tags += '<span class="tag">غير متصل</span>';
    return '<li class="' + (p.online ? "" : "off") + '">' + shirt(p) + '<span class="nm">' + esc(p.name) + "</span>" + tags + (extra || "") + "</li>";
  }
  function scoreboard(title) {
    var list = S.players.slice().sort(function (a, b) { return b.score - a.score; });
    var d = (S.result && S.result.deltas) || {};
    return '<section class="panel stack"><div class="row between"><h3>' + (title || "جدول النقاط") + '</h3><span class="label">الجولة ' + S.round + '</span></div><ul class="players">' +
      list.map(function (p, i) {
        return playerRow(p, (d[p.id] ? '<span class="delta">+' + d[p.id] + "</span>" : "") + '<span class="pts">' + p.score + "</span>")
          .replace("<li", '<li style="animation-delay:' + i * 0.05 + 's"');
      }).join("") + "</ul></section>";
  }
  function waitingFor(msg) {
    return '<div class="waiting">' + esc(msg) + ' <span class="dots"><i></i><i></i><i></i></span></div>';
  }

  var BALL = '<svg class="ball" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="46" fill="#e9f1e4" stroke="#0a2616" stroke-width="3"/>' +
    '<polygon points="50,30 66,42 60,61 40,61 34,42" fill="#0a2616"/>' +
    '<path d="M50 30V8M66 42l20-8M60 61l13 18M40 61L27 79M34 42l-20-8" stroke="#0a2616" stroke-width="3" fill="none"/></svg>';

  function render() {
    bar.hidden = !mode;
    if (mode) document.getElementById("barRoom").textContent = mode === "solo" ? "تجربة فردية" : code;
    if (mode === "solo") netDot.style.display = "none"; else netDot.style.display = "";

    if (!mode) return renderHome();
    if (!S) return renderConnecting();
    if (S.round !== ui.round) { ui.round = S.round; ui.revealed = false; ui.guessPick = null; }

    var inRound = S.roundIds.indexOf(myId) !== -1;
    if (S.phase !== "lobby" && S.phase !== "result" && !inRound) return renderSpectator();

    ({ lobby: renderLobby, reveal: renderReveal, vote: renderVote, guess: renderGuess, result: renderResult })[S.phase]();
  }

  function renderHome() {
    var preCode = (new URLSearchParams(location.search).get("room") || "").replace(/\D/g, "").slice(0, 4);
    if (preCode) ui.joinOpen = true;
    app.innerHTML =
      '<div class="screen">' +
      '<section class="hero">' + BALL +
      '<span class="kicker">لعبة جماعية للشلة</span>' +
      '<h1>برا <span>السالفة</span></h1>' +
      '<div class="sub">تحدي الكورة</div></section>' +
      '<div class="stack">' +
      '<div class="field"><label for="nameIn">اسمك في الملعب</label>' +
      '<input id="nameIn" maxlength="18" autocomplete="nickname" placeholder="مثلاً: أبو سلمان" value="' + esc(localStorage.getItem("bsk_name") || "") + '"></div>' +
      '<div class="err-msg" id="errMsg"></div>' +
      '<div class="stack home-actions">' +
      '<button class="yellow" id="soloBtn">تجربة لوحدي (مع بوتات)</button>' +
      '<button class="green" id="createBtn">إنشاء غرفة جديدة</button>' +
      (ui.joinOpen
        ? '<div class="join-row"><input id="codeIn" class="code-in" inputmode="numeric" maxlength="4" placeholder="0000" value="' + esc(preCode) + '"><button class="blue" id="joinGo">ادخل</button></div>'
        : '<button class="blue" id="joinBtn">دخول الغرفة</button>') +
      "</div></div>" +
      '<details class="rules"><summary>طريقة اللعب</summary><ol>' +
      "<li>الكل يشوف الفئة، ويكشف بطاقته على جواله.</li>" +
      "<li>كل اللاعبين يعرفون الكلمة السرية إلا واحد: هو <b>برا السالفة</b>.</li>" +
      "<li>تناقشوا واسألوا بعض أسئلة عن الكلمة بدون ما تفضحونها.</li>" +
      "<li>صوّتوا على اللي تشكون إنه برا السالفة. التعادل يعني إنه نجا.</li>" +
      "<li>لو انكشف، يخمّن الكلمة من 6 خيارات: صح = 100 نقطة له، غلط = 100 نقطة لكل من صوّت عليه.</li>" +
      "<li>لو ما انكشف، ياخذ 100 نقطة.</li></ol></details>" +
      "</div>";

    document.getElementById("soloBtn").onclick = startSolo;
    document.getElementById("createBtn").onclick = createRoom;
    if (ui.joinOpen) {
      var ci = document.getElementById("codeIn");
      ci.oninput = function () { ci.value = ci.value.replace(/\D/g, "").slice(0, 4); };
      ci.onkeydown = function (e) { if (e.key === "Enter") joinRoom(); };
      document.getElementById("joinGo").onclick = joinRoom;
      if (!preCode) ci.focus();
    } else {
      document.getElementById("joinBtn").onclick = function () { ui.joinOpen = true; render(); };
    }
    document.getElementById("nameIn").oninput = function () { document.getElementById("errMsg").textContent = ""; };
  }

  function renderConnecting() {
    bar.hidden = false;
    document.getElementById("barRoom").textContent = code || "";
    app.innerHTML = '<div class="screen stack" style="padding-top:60px">' +
      '<div class="panel center stack"><div class="label">جاري الدخول للغرفة</div><div class="big-code">' + esc(code) + "</div>" +
      waitingFor("نتصل بالملعب") + "</div></div>";
  }

  function renderSpectator() {
    app.innerHTML = '<div class="screen stack"><div class="panel center stack"><h2>الجولة شغّالة</h2>' +
      '<p class="muted" style="margin:0">دخلت في نص الجولة. بتنضم تلقائياً في الجولة الجاية.</p></div>' + scoreboard() + "</div>";
  }

  function renderLobby() {
    var online = S.players.filter(function (p) { return p.online; }).length;
    var html = '<div class="screen stack">';
    if (!S.solo) {
      html += '<section class="panel center stack"><div class="label">كود الغرفة، أرسله للشلة</div>' +
        '<div class="big-code">' + esc(S.code) + "</div>" +
        '<button class="ghost sm" id="shareBtn" style="justify-self:center">مشاركة رابط الغرفة</button></section>';
    } else {
      html += '<section class="panel stack"><h2>تجربة لوحدك</h2><p class="muted" style="margin:0">معك 3 بوتات يلعبون ويصوّتون. جرّب اللعبة قبل ما تجمع الشلة.</p></section>';
    }
    html += '<section class="panel stack"><div class="row between"><h3>اللاعبين</h3><span class="label">' + online + " / " + MAX_PLAYERS + "</span></div>" +
      '<ul class="players">' + S.players.map(function (p, i) { return playerRow(p).replace("<li", '<li style="animation-delay:' + i * 0.05 + 's"'); }).join("") + "</ul>" +
      (online < 3 ? '<p class="muted center" style="margin:0;font-size:14px">تحتاجون 3 لاعبين على الأقل</p>' : "") + "</section>";
    html += isHost()
      ? '<button class="green" id="startBtn"' + (online < 3 ? " disabled" : "") + ">ابدأ الجولة</button>"
      : waitingFor("ننتظر المضيف يبدأ الجولة");
    html += "</div>";
    app.innerHTML = html;
    var sb = document.getElementById("startBtn"); if (sb) sb.onclick = startRound;
    var sh = document.getElementById("shareBtn");
    if (sh) sh.onclick = function () {
      var url = location.origin + location.pathname + "?room=" + S.code;
      var text = "تعال العب معنا برا السالفة - تحدي الكورة. كود الغرفة: " + S.code;
      if (navigator.share) navigator.share({ title: "برا السالفة", text: text, url: url }).catch(function () { });
      else if (navigator.clipboard) navigator.clipboard.writeText(text + "\n" + url).then(function () { toast("تم نسخ الرابط"); });
      else toast("الكود: " + S.code);
    };
  }

  function catBlock() {
    return '<div class="cat"><span class="label">الفئة</span><span class="name">' + esc(S.category) + "</span></div>";
  }

  function renderReveal() {
    var out = S.outsiderId === myId;
    var back = out
      ? '<div class="face back out"><div class="k">بطاقتك</div><div class="word">أنت برا السالفة!</div><div class="hint">لا تنفضح. اسمع الأسئلة وحاول تعرف الكلمة.</div></div>'
      : '<div class="face back"><div class="k">الكلمة السرية</div><div class="word">' + esc(S.word) + '</div><div class="hint">واحد منكم ما يعرفها. اكتشفوه!</div></div>';
    app.innerHTML = '<div class="screen">' +
      '<div class="row between" style="margin-bottom:6px"><span class="phase-tag"><b>' + S.round + "</b> الجولة</span>" +
      '<span class="phase-tag">يبدأ بالسؤال: <b>' + esc(pname(S.firstAsker)) + "</b></span></div>" +
      catBlock() +
      '<div class="card-wrap"><button class="card' + (ui.revealed ? " flip" : "") + '" id="card" aria-label="اضغط لكشف بطاقتك">' +
      '<div class="face front"><span class="tap">اضغط لكشف بطاقتك</span></div>' + back + "</button></div>" +
      '<p class="muted center" style="margin:0 0 16px;font-size:14px">' + (ui.revealed ? "اضغط مرة ثانية لإخفاء البطاقة" : "خبّ الشاشة عن اللي جنبك") + "</p>" +
      (isHost() ? '<button class="yellow" id="voteBtn">خلصنا النقاش، ابدأ التصويت</button>' : waitingFor("تناقشوا... المضيف يبدأ التصويت")) +
      "</div>";
    document.getElementById("card").onclick = function () { ui.revealed = !ui.revealed; this.classList.toggle("flip", ui.revealed); };
    var vb = document.getElementById("voteBtn"); if (vb) vb.onclick = startVote;
  }

  function renderVote() {
    var ids = S.roundIds.filter(function (id) { var p = sp(id); return p && p.online; });
    var voted = ids.filter(function (id) { return S.votes[id]; }).length;
    var mine = S.votes[myId];
    var targets = ids.filter(function (id) { return id !== myId; });
    app.innerHTML = '<div class="screen stack">' + catBlock() +
      '<section class="panel stack"><h2>مين برا السالفة؟</h2><p class="muted" style="margin:0">صوّت على اللي تشك فيه. تقدر تغيّر صوتك قبل ما يكمّل الكل.</p>' +
      '<div class="vote-grid">' + targets.map(function (id) {
        var p = sp(id);
        return '<button data-id="' + esc(id) + '" class="' + (mine === id ? "sel" : "") + '">' + shirt(p) + "<span>" + esc(p.name) + "</span>" +
          '<span class="cnt">' + (mine === id ? "صوتك هنا" : "&nbsp;") + "</span></button>";
      }).join("") + "</div></section>" +
      '<section class="panel stack"><div class="row between"><span class="label">صوّت ' + voted + " من " + ids.length + '</span><span class="label">' +
      S.roundIds.filter(function (id) { return S.votes[id]; }).map(function (id) { return esc(pname(id)); }).join("، ") + "</span></div>" +
      '<div class="meter"><i style="transform:scaleX(' + (ids.length ? voted / ids.length : 0) + ')"></i></div></section>' +
      (isHost() && voted > 0 && voted < ids.length ? '<button class="ghost" id="forceBtn">إنهاء التصويت الآن</button>' : "") +
      "</div>";
    Array.prototype.forEach.call(app.querySelectorAll(".vote-grid button"), function (b) {
      b.onclick = function () { send({ type: "vote", target: b.getAttribute("data-id") }); };
    });
    var fb = document.getElementById("forceBtn"); if (fb) fb.onclick = function () { if (H.phase === "vote") tally(); };
  }

  function renderGuess() {
    var out = S.outsiderId === myId;
    var o = sp(S.outsiderId);
    var c = (S.tally && S.tally.counts[S.outsiderId]) || 0;
    var html = '<div class="screen stack">' + catBlock();
    if (out) {
      html += '<div class="banner escape"><h2>انكشفت!</h2><p>' + c + ' أصوات عليك. خمّن الكلمة السرية وخذ 100 نقطة</p></div>' +
        '<div class="opts">' + S.options.map(function (w) {
          var cls = ui.guessPick ? (w === ui.guessPick ? "sel" : "") : "";
          return '<button data-w="' + esc(w) + '" class="' + cls + '"' + (ui.guessPick ? " disabled" : "") + ">" + esc(w) + "</button>";
        }).join("") + "</div>";
    } else {
      html += '<div class="banner lose"><h2>كشفتوا ' + esc(o ? o.name : "") + "!</h2><p>" + c + " أصوات. الحين عنده فرصة يخمّن الكلمة</p></div>" +
        '<section class="panel stack"><div class="label">الخيارات اللي قدامه</div><div class="opts">' +
        S.options.map(function (w) { return '<button disabled style="opacity:.85">' + esc(w) + "</button>"; }).join("") + "</div></section>" +
        waitingFor(o && o.bot ? "البوت يفكّر" : "ننتظر تخمينه");
    }
    html += "</div>";
    app.innerHTML = html;
    if (out) Array.prototype.forEach.call(app.querySelectorAll(".opts button"), function (b) {
      b.onclick = function () { if (ui.guessPick) return; ui.guessPick = b.getAttribute("data-w"); send({ type: "guess", word: ui.guessPick }); render(); };
    });
  }

  function renderResult() {
    var r = S.result, o = sp(S.outsiderId), oname = o ? o.name : "", me = S.outsiderId === myId;
    var cls, title, sub;
    if (!r.caught) {
      cls = "escape"; title = me ? "نجوت منهم!" : oname + " نجا!";
      sub = "ما انكشف برا السالفة، وأخذ 100 نقطة";
    } else if (r.correct) {
      cls = "escape"; title = me ? "خمّنتها صح!" : oname + " خمّنها صح!";
      sub = "انكشف بس عرف الكلمة، وفاز بالجولة +100";
    } else {
      cls = "win"; title = "كشفتوه!";
      sub = oname + (r.guess ? " اختار «" + r.guess + "» وطلع غلط" : " ما لحق يخمّن") + ". النقاط لمن صوّت عليه";
    }
    var counts = (S.tally && S.tally.counts) || {};
    var votesHtml = S.roundIds.map(function (id) {
      var p = sp(id); if (!p) return "";
      var t = S.votes[id];
      return '<li>' + shirt(p) + '<span class="nm">' + esc(p.name) + '</span><span class="muted" style="font-size:14px">' +
        (t ? "صوّت على " + esc(pname(t)) : "ما صوّت") + "</span>" + (counts[id] ? '<span class="tag">' + counts[id] + " ص</span>" : "") + "</li>";
    }).join("");
    app.innerHTML = '<div class="screen stack">' +
      '<div class="banner ' + cls + '"><h2>' + esc(title) + "</h2><p>" + esc(sub) + "</p></div>" +
      '<div class="reveal-line"><div class="panel"><div class="label">الكلمة السرية</div><div class="v">' + esc(S.word) + "</div></div>" +
      '<div class="panel"><div class="label">برا السالفة كان</div><div class="v">' + esc(oname) + "</div></div></div>" +
      '<section class="panel stack"><h3>الأصوات</h3><ul class="players">' + votesHtml + "</ul></section>" +
      scoreboard() +
      (isHost() ? '<button class="green" id="nextBtn">جولة جديدة</button>' : waitingFor("ننتظر المضيف يبدأ جولة جديدة")) +
      "</div>";
    var nb = document.getElementById("nextBtn"); if (nb) nb.onclick = startRound;
  }

  render();
})();
