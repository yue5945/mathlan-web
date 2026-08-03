/* ============================================================
 * 数问阑珊 | MathLan 手机版
 * 逻辑与桌面版 mathlan1222.py 保持一致
 * ============================================================ */
(function () {
'use strict';
var C = window.MLCrypto;

var BANKS = ['A1','A2','A3','B1','B2','B3','C1','C2','C3'];
var STORE_KEY = 'mathlan_progress_v1';
var LOGIN_KEY = 'mathlan_login_v1';

// 全局静默：任何脚本错误都不允许弹窗（技术层面屏蔽报错框）
window.onerror = function () { return true; };
window.addEventListener('unhandledrejection', function (e) { e.preventDefault(); });

var S = {
  questions: {},          // 题库（加密答案，来自 assets/math_questions.json）
  specialUsers: [],       // 特殊用户（assets/special_users.json）
  account: '',            // 登录账号
  currentUser: '1',       // 用户ID 1-30
  statId: '',
  progress: {},           // {uid: {bid: {remaining:[], history:[]}}}
  bid: null,              // 当前题库
  bidQuestions: [],       // 当前题库题目列表
  qIndex: 0,
  qStart: 0,              // 当前题开始计时
  startTime: Date.now(),  // 运行计时
  reviewQid: null
};

/* ---------- 小工具 ---------- */
function $(id) { return document.getElementById(id); }
function el(tag, cls, text) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
var toastTimer = null;
function toast(msg, ms) {
  var t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.classList.remove('show'); }, ms || 2200);
}
function showPage(id) {
  var pages = document.querySelectorAll('.page');
  for (var i = 0; i < pages.length; i++) pages[i].classList.remove('active');
  $(id).classList.add('active');
  window.scrollTo(0, 0);
}
function deepcopy(o) { return JSON.parse(JSON.stringify(o)); }

/* ---------- 数据加载 ---------- */
function fetchJSON(url) {
  return fetch(url, { cache: 'no-store' }).then(function (r) {
    if (!r.ok) throw new Error(url + ' ' + r.status);
    return r.json();
  });
}

/* ---------- 题库加载：自动重试 + 本机缓存（网络不稳定时也能用） ---------- */
var QCACHE_KEY = 'mathlan_qcache_v1';

function fetchWithRetry(url, tries, delayMs) {
  return fetchJSON(url).catch(function (e) {
    if (tries <= 1) throw e;
    return new Promise(function (res) { setTimeout(res, delayMs); })
      .then(function () { return fetchWithRetry(url, tries - 1, delayMs * 2); });
  });
}

function saveQCache(data) {
  try { localStorage.setItem(QCACHE_KEY, JSON.stringify(data)); } catch (e) {}
}

function loadQCache() {
  try {
    var s = localStorage.getItem(QCACHE_KEY);
    return s ? JSON.parse(s) : null;
  } catch (e) { return null; }
}

function applyQuestions(q) {
  S.questions = q || {};
  BANKS.forEach(function (b) { if (!S.questions[b]) S.questions[b] = []; });
  S.questionsLoaded = true;
}

function loadQuestions(showStatus) {
  if (showStatus) toast('题库加载中…', 15000);
  return fetchWithRetry('assets/math_questions.json', 5, 800).then(function (q) {
    applyQuestions(q);
    saveQCache(q);
    if (showStatus) toast('题库已就绪');
  }).catch(function () {
    if (showStatus) toast('题库加载失败，请稍后点「更新」重试', 5000);
  });
}

/* ---------- IndexedDB：保存更新包里的题目/答案图片 ---------- */
function idbOpen() {
  return new Promise(function (res, rej) {
    var rq = indexedDB.open('mathlan-db', 1);
    rq.onupgradeneeded = function () { rq.result.createObjectStore('kv'); };
    rq.onsuccess = function () { res(rq.result); };
    rq.onerror = function () { rej(rq.error); };
  });
}

function idbGet(key) {
  return idbOpen().then(function (db) {
    return new Promise(function (res, rej) {
      var rq = db.transaction('kv', 'readonly').objectStore('kv').get(key);
      rq.onsuccess = function () { res(rq.result); };
      rq.onerror = function () { rej(rq.error); };
    });
  });
}

function idbSet(key, val) {
  return idbOpen().then(function (db) {
    return new Promise(function (res, rej) {
      var tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(val, key);
      tx.oncomplete = function () { res(); };
      tx.onerror = function () { rej(tx.error); };
    });
  });
}

function idbClearImages() {
  return idbOpen().then(function (db) {
    return new Promise(function (res, rej) {
      var rq = db.transaction('kv', 'readonly').objectStore('kv').getAllKeys();
      rq.onsuccess = function () {
        var keys = rq.result.filter(function (k) { return String(k).indexOf('img:') === 0; });
        var tx = db.transaction('kv', 'readwrite');
        keys.forEach(function (k) { tx.objectStore('kv').delete(k); });
        tx.oncomplete = function () { res(); };
        tx.onerror = function () { rej(tx.error); };
      };
      rq.onerror = function () { rej(rq.error); };
    });
  });
}

/* 显示图片：优先用更新包下载到本机的图片，没有再按原路径加载 */
function setImgSrc(el, path) {
  if (!path) return;
  el.src = path;
  var alt = String(path).replace(/^assets\//, '');
  idbGet('img:' + alt).then(function (b) {
    if (b) el.src = URL.createObjectURL(b);
  }).catch(function () {});
}

/* ---------- OSS 在线更新：下载 mathlan.zip 并在浏览器内解压替换题库 ---------- */
var OSS_ZIP_URL = 'https://mathlan.oss-cn-beijing.aliyuncs.com/mathlan.zip';

function fetchBinRetry(url, tries, delayMs) {
  return fetch(url, { cache: 'no-store' }).then(function (r) {
    if (!r.ok) throw new Error(url + ' ' + r.status);
    return r.arrayBuffer();
  }).catch(function (e) {
    if (tries <= 1) throw e;
    return new Promise(function (res) { setTimeout(res, delayMs); })
      .then(function () { return fetchBinRetry(url, tries - 1, delayMs * 2); });
  });
}

function ossUpdate() {
  if (typeof JSZip === 'undefined') { toast('更新组件缺失，请检查网络后刷新'); loadQuestions(false); return; }
  toast('正在下载更新包…', 30000);
  fetchBinRetry(OSS_ZIP_URL + '?t=' + Date.now(), 3, 1000)
    .then(function (buf) { return JSZip.loadAsync(buf); })
    .then(function (zip) {
      var jobs = [];
      var qData = null;
      zip.forEach(function (rel, file) {
        if (file.dir) return;
        if (rel === 'math_questions.json') {
          jobs.push(file.async('string').then(function (s) { qData = JSON.parse(s); }));
        } else if (/^(question_images|answer_images)\//.test(rel)) {
          jobs.push(file.async('blob').then(function (b) { return idbSet('img:' + rel, b); }));
        }
      });
      return idbClearImages().then(function () { return Promise.all(jobs); }).then(function () {
        if (qData) {
          applyQuestions(qData);
          saveQCache(qData);
          renderBankGrid();
        }
        toast('更新完成，题库已是最新 ✅');
      });
    })
    .catch(function () { toast('更新失败，请检查网络后重试', 4000); });
}

function blankProgress() {
  var p = {};
  for (var u = 1; u <= 30; u++) {
    p[String(u)] = {};
    for (var i = 0; i < BANKS.length; i++) {
      p[String(u)][BANKS[i]] = { remaining: [], history: [] };
    }
  }
  return p;
}

function loadProgress() {
  try {
    var raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      var saved = JSON.parse(raw);
      var base = blankProgress();
      for (var u in base) {
        if (!saved[u]) continue;
        for (var i = 0; i < BANKS.length; i++) {
          var b = BANKS[i];
          if (saved[u][b]) base[u][b] = saved[u][b];
        }
      }
      S.progress = base;
      return;
    }
  } catch (e) { /* 忽略损坏数据 */ }
  S.progress = blankProgress();
}

function saveProgress() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(S.progress)); } catch (e) {}
}

function userData(uid, bid) { return S.progress[uid][bid]; }

/* remaining 为空时从原始题库重新装满（与桌面版一致） */
function ensureRemaining(uid, bid) {
  var ud = userData(uid, bid);
  if (!ud.remaining.length) ud.remaining = deepcopy(S.questions[bid] || []);
  return ud;
}

/* ---------- 登录 ---------- */
function getNetworkDate() {
  // 优先网络时间，失败回退本地时间（与桌面版 check_date_validity 一致）
  return new Promise(function (resolve) {
    var done = false;
    var timer = setTimeout(function () { if (!done) { done = true; resolve(null); } }, 5000);
    fetch('https://worldtimeapi.org/api/ip', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (done) return;
        done = true; clearTimeout(timer);
        resolve(d.datetime ? d.datetime.slice(0, 10).replace(/-/g, '/') : null);
      })
      .catch(function () { if (!done) { done = true; clearTimeout(timer); resolve(null); } });
  });
}

function todayStr() {
  var d = new Date();
  return d.getFullYear() + '/' + ('0' + (d.getMonth() + 1)).slice(-2) + '/' + ('0' + d.getDate()).slice(-2);
}

function verifyLogin(username, password) {
  // 特殊用户
  for (var i = 0; i < S.specialUsers.length; i++) {
    var su = S.specialUsers[i];
    if (username === su.username && password === su.password) {
      return getNetworkDate().then(function (netDate) {
        var today = netDate || todayStr();
        if (today <= su.expire_date) return { ok: true };
        return { ok: false, msg: '该账户已过期，请重新申请！' };
      });
    }
  }
  // 普通用户：11位手机号 + 6位密码
  if (!/^\d{11}$/.test(username)) return Promise.resolve({ ok: false, msg: '用户名必须是11位数字！' });
  if (password.length !== 6) return Promise.resolve({ ok: false, msg: '密码必须是6位字符！' });
  var gen = C.generatePassword(username);
  if (gen === password) return Promise.resolve({ ok: true });
  return Promise.resolve({ ok: false, msg: '用户名或密码不匹配！' });
}

function initLogin() {
  try {
    var raw = localStorage.getItem(LOGIN_KEY);
    if (raw) {
      var cfg = JSON.parse(raw);
      if (cfg.remember) {
        $('login-username').value = cfg.username || '';
        $('login-password').value = cfg.password || '';
        $('login-remember').checked = true;
      }
    }
  } catch (e) {}

  $('login-btn').addEventListener('click', doLogin);
  $('login-password').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });

  function doLogin() {
    var u = $('login-username').value.trim();
    var p = $('login-password').value.trim();
    $('login-error').textContent = '';
    $('login-btn').disabled = true;
    verifyLogin(u, p).then(function (res) {
      $('login-btn').disabled = false;
      if (!res.ok) { $('login-error').textContent = res.msg; return; }
      S.account = u;
      // 用户名和密码自动保留，不清除
      $('login-remember').checked = true;
      try {
        localStorage.setItem(LOGIN_KEY, JSON.stringify({ username: u, password: p, remember: true }));
      } catch (e) {}
      enterMain();
    }).catch(function () {
      $('login-btn').disabled = false;
      $('login-error').textContent = '登录验证失败，请重试';
    });
  }
}

/* ---------- 主页 ---------- */
function enterMain() {
  renderBankGrid();
  $('main-user-label').textContent = '用户 ' + S.currentUser;
  showPage('page-main');
}

function bankState(uid, bid) {
  var ud = userData(uid, bid);
  if (!ud.remaining.length && ud.history.length > 0) return 'ok';
  var last = ud.history.slice(-3);
  for (var i = 0; i < last.length; i++) if (!last[i].correct) return 'bad';
  return '';
}

function renderBankGrid() {
  var grid = $('bank-grid');
  grid.innerHTML = '';
  BANKS.forEach(function (bid) {
    var st = bankState(S.currentUser, bid);
    var b = el('button', 'btn' + (st ? ' ' + st : ''),
      bid + (st === 'ok' ? ' ✓' : st === 'bad' ? ' ?' : ''));
    b.addEventListener('click', function () { openQuiz(bid); });
    grid.appendChild(b);
  });
}

/* ---------- 答题 ---------- */
function currentQ() { return S.bidQuestions[S.qIndex] || null; }

function answerOf(q) {
  var raw = C.AnswerCrypto.decryptAnswer(q[1], q[0]);
  var isSingle, correct;
  if (raw.indexOf('S:') === 0) { isSingle = true; correct = raw.slice(2); }
  else if (raw.indexOf('M:') === 0) { isSingle = false; correct = raw.slice(2); }
  else { correct = raw; isSingle = correct.length === 1; }
  return { isSingle: isSingle, correct: correct };
}

function openQuiz(bid) {
  if (!S.questionsLoaded) { toast('题库加载中，请稍候…'); loadQuestions(false); return; }
  S.bid = bid;
  var ud = ensureRemaining(S.currentUser, bid);
  S.bidQuestions = ud.remaining;   // 与桌面版一致：直接基于 remaining
  S.qIndex = 0;
  if (!S.bidQuestions.length) { toast('本题库没有题目！'); renderBankGrid(); return; }
  $('quiz-title').textContent = '题库 ' + bid;
  renderQuestion();
  showPage('page-quiz');
}

function renderQuestion() {
  var q = currentQ();
  if (!q) return;
  var ans = answerOf(q);
  $('quiz-qtext').textContent = (q[0] || '').trim();
  $('quiz-progress').textContent = (S.qIndex + 1) + ' / ' + S.bidQuestions.length;

  var imgWrap = $('quiz-img-wrap');
  if (q[2]) {
    setImgSrc($('quiz-img'), q[2]);
    imgWrap.style.display = '';
  } else {
    imgWrap.style.display = 'none';
  }

  // 选项：有图题默认 A-D，否则尝试从题干第二行解析（与桌面版一致）
  var options = ['A', 'B', 'C', 'D'];
  if (!q[2] && q[0] && q[0].split('\n').length > 1) {
    var parts = q[0].split('\n')[1].trim().split(/\s+/).filter(Boolean);
    if (parts.length) options = parts.map(function (p) { return p[0]; });
  }
  // 选项数量不少于答案最大字母
  var need = 0;
  for (var i = 0; i < ans.correct.length; i++) need = Math.max(need, ans.correct.charCodeAt(i) - 64);
  while (options.length < need) options.push(String.fromCharCode(65 + options.length));

  var box = $('quiz-options');
  box.innerHTML = '';
  box.dataset.type = ans.isSingle ? 'single' : 'multi';
  options.forEach(function (opt) {
    var b = el('button', 'opt', opt);
    b.dataset.value = opt;
    b.addEventListener('click', function () {
      if (box.dataset.type === 'single') {
        var all = box.querySelectorAll('.opt');
        for (var i = 0; i < all.length; i++) all[i].classList.remove('sel');
        b.classList.add('sel');
      } else {
        b.classList.toggle('sel');
      }
    });
    box.appendChild(b);
  });

  S.qStart = Date.now();
  $('quiz-body').scrollTop = 0;
}

function selectedAnswer() {
  var sel = [];
  var nodes = $('quiz-options').querySelectorAll('.opt.sel');
  for (var i = 0; i < nodes.length; i++) sel.push(nodes[i].dataset.value);
  return sel;
}

function submitAnswer() {
  var q = currentQ();
  if (!S.bid || !q) { toast('请先选择题库和题目'); return; }
  var ans = answerOf(q);
  var sel = selectedAnswer();
  var answerImg = q.length > 3 ? q[3] : '';

  // 未选择答案：只显示答案图片（与桌面版一致）
  if (!sel.length) {
    if (answerImg) showAnswerOverlay(answerImg, '答案');
    else toast('请先选择答案！');
    return;
  }

  var duration = Math.round((Date.now() - S.qStart) / 1000);
  var ud = userData(S.currentUser, S.bid);
  var selSorted = sel.slice().sort().join('');
  var corSorted = ans.correct.split('').sort().join('');

  if (selSorted === corSorted) {
    // 答对：从 remaining 移除当前题
    var idx = ud.remaining.indexOf(q);
    if (idx >= 0) ud.remaining.splice(idx, 1);
    ud.history.push({ duration: duration, correct: true, question: q[0] });

    if (!ud.remaining.length) {
      toast('恭喜！本题库全部答对！', 2600);
      saveProgress();
      renderBankGrid();
      enterMain();
      return;
    }
    toast('回答正确！');
    S.bidQuestions = ud.remaining;
    if (S.qIndex >= S.bidQuestions.length) S.qIndex = Math.max(0, S.bidQuestions.length - 1);
  } else {
    // 答错：记录错误并显示答案，前进到下一题
    ud.history.push({ duration: duration, correct: false, question: q[0], answer_image: answerImg });
    if (answerImg) showAnswerOverlay(answerImg, '回答错误 · 答案');
    else toast('回答错误，请重新尝试！');
    S.bidQuestions = ud.remaining;
    S.qIndex = (S.qIndex < S.bidQuestions.length - 1) ? S.qIndex + 1 : 0;
  }
  saveProgress();
  renderQuestion();
}

function navQuestion(delta) {
  if (!S.bidQuestions.length) return;
  S.qIndex = (S.qIndex + delta + S.bidQuestions.length) % S.bidQuestions.length;
  renderQuestion();
}

/* ---------- 答案遮罩 ---------- */
function showAnswerOverlay(src, title) {
  $('answer-overlay-title').textContent = title || '答案';
  setImgSrc($('answer-img'), src);
  $('answer-overlay').classList.add('show');
}

/* ---------- 查看（错题） ---------- */
var reviewTab = 'A1';
function openReview() {
  var tabs = $('review-tabs');
  tabs.innerHTML = '';
  BANKS.forEach(function (bid) {
    var t = el('button', 'tab' + (bid === reviewTab ? ' on' : ''), bid);
    t.addEventListener('click', function () { reviewTab = bid; openReview(); });
    tabs.appendChild(t);
  });

  var ud = userData(S.currentUser, reviewTab);
  var seen = {};
  var list = [];
  ud.history.forEach(function (h, i) {
    if (h.correct) return;
    var qt = h.question || '';
    var qid = qt.indexOf(':') >= 0 ? qt.split(':')[0] : ('题目' + (i + 1));
    if (!(qid in seen)) { seen[qid] = h; list.push({ qid: qid, record: h }); }
  });

  var box = $('review-list');
  box.innerHTML = '';
  if (!list.length) box.appendChild(el('p', 'review-empty', '该题库暂无错误记录'));
  list.forEach(function (item) {
    var row = el('div', 'review-item' + (item.qid === S.reviewQid ? ' on' : ''));
    row.appendChild(el('span', '', item.qid));
    row.appendChild(el('span', '', '用时 ' + item.record.duration + ' 秒'));
    row.addEventListener('click', function () {
      S.reviewQid = item.qid;
      showReviewAnswer(reviewTab, item);
      var rows = box.querySelectorAll('.review-item');
      for (var i = 0; i < rows.length; i++) rows[i].classList.remove('on');
      row.classList.add('on');
    });
    box.appendChild(row);
  });
  showPage('page-review');
}

function showReviewAnswer(bid, item) {
  var img = item.record.answer_image || '';
  if (img) {
    $('review-hint').style.display = 'none';
    $('review-img').style.display = '';
    setImgSrc($('review-img'), img);
    $('review-delete').style.display = '';
  } else {
    $('review-hint').style.display = '';
    $('review-hint').textContent = '该题目没有答案图片';
    $('review-img').style.display = 'none';
    $('review-delete').style.display = '';
  }
  $('review-delete').onclick = function () {
    if (!confirm('确定要删除这条错误记录吗？')) return;
    var ud = userData(S.currentUser, bid);
    ud.history = ud.history.filter(function (h) {
      return !(!h.correct && (h.question || '').indexOf(item.qid) === 0);
    });
    saveProgress();
    S.reviewQid = null;
    $('review-hint').style.display = '';
    $('review-hint').textContent = '请从上方选择题目查看答案';
    $('review-img').style.display = 'none';
    $('review-delete').style.display = 'none';
    renderBankGrid();
    openReview();
    toast('错误记录已删除');
  };
}

/* ---------- 统计 ---------- */
function statsTable(headers, rows) {
  var t = el('table', 'stats-table');
  var tr = el('tr');
  headers.forEach(function (h) { tr.appendChild(el('th', '', h)); });
  t.appendChild(tr);
  rows.forEach(function (r) {
    var row = el('tr');
    r.forEach(function (c) { row.appendChild(el('td', '', String(c))); });
    t.appendChild(row);
  });
  return t;
}

function openSingleStats() {
  var uid = S.statId;
  if (!/^\d+$/.test(uid) || +uid < 1 || +uid > 30) { toast('请先点「统计」输入用户编号（1-30）'); return; }
  $('stats-title').textContent = '用户' + uid + '答题统计';
  $('stats-tabs').style.display = 'none';
  var body = $('stats-body');
  body.innerHTML = '';
  var has = false;

  BANKS.forEach(function (bid) {
    var history = userData(uid, bid).history;
    if (!history.length) return;
    has = true;
    var byQ = {};
    history.forEach(function (r) {
      var qt = r.question || '';
      var qid = qt.indexOf(':') >= 0 ? qt.split(':')[0].trim() : '未知题号';
      if (!byQ[qid]) byQ[qid] = { total: 0, correct: 0, time: 0 };
      byQ[qid].total++;
      byQ[qid].time += r.duration;
      if (r.correct) byQ[qid].correct++;
    });
    var sec = el('div', 'stats-sec');
    sec.appendChild(el('h3', '', '题库 ' + bid));
    var rows = Object.keys(byQ).map(function (qid) {
      var s = byQ[qid];
      return [qid, s.total, s.correct, (s.total ? (s.correct / s.total * 100).toFixed(1) : '0.0') + '%', s.time];
    });
    sec.appendChild(statsTable(['题号', '答题次数', '正确次数', '正确率', '总用时(秒)'], rows));
    body.appendChild(sec);
  });

  if (!has) body.appendChild(el('p', 'stats-empty', '暂无答题记录'));
  showPage('page-stats');
}

var multiTab = 'bid';
function openMultiStats() {
  $('stats-title').textContent = '多用户统计';
  var tabs = $('stats-tabs');
  tabs.style.display = '';
  tabs.innerHTML = '';
  [['bid', '按题库统计'], ['user', '按用户统计']].forEach(function (pair) {
    var t = el('button', 'tab' + (multiTab === pair[0] ? ' on' : ''), pair[1]);
    t.addEventListener('click', function () { multiTab = pair[0]; openMultiStats(); });
    tabs.appendChild(t);
  });

  var body = $('stats-body');
  body.innerHTML = '';
  var has = false;

  if (multiTab === 'bid') {
    BANKS.forEach(function (bid) {
      var rows = [];
      for (var u = 1; u <= 30; u++) {
        var h = userData(String(u), bid).history;
        if (!h.length) continue;
        var correct = h.filter(function (r) { return r.correct; }).length;
        var time = h.reduce(function (s, r) { return s + r.duration; }, 0);
        rows.push([u, h.length, correct, (correct / h.length * 100).toFixed(1) + '%', (time / h.length).toFixed(1)]);
      }
      if (!rows.length) return;
      has = true;
      var sec = el('div', 'stats-sec');
      sec.appendChild(el('h3', '', '题库 ' + bid));
      sec.appendChild(statsTable(['用户ID', '答题总数', '正确次数', '正确率', '平均用时(秒)'], rows));
      body.appendChild(sec);
    });
  } else {
    for (var u = 1; u <= 30; u++) {
      var uid = String(u);
      var rows = [];
      BANKS.forEach(function (bid) {
        var h = userData(uid, bid).history;
        if (!h.length) return;
        var correct = h.filter(function (r) { return r.correct; }).length;
        var time = h.reduce(function (s, r) { return s + r.duration; }, 0);
        rows.push([bid, h.length, correct, (correct / h.length * 100).toFixed(1) + '%', (time / h.length).toFixed(1)]);
      });
      if (!rows.length) continue;
      has = true;
      var sec = el('div', 'stats-sec');
      sec.appendChild(el('h3', '', '用户 ' + uid));
      sec.appendChild(statsTable(['题库', '答题总数', '正确次数', '正确率', '平均用时(秒)'], rows));
      body.appendChild(sec);
    }
  }
  if (!has) body.appendChild(el('p', 'stats-empty', '暂无答题记录'));
  showPage('page-stats');
}

/* ---------- 图片放大 ---------- */
function openZoom(src) {
  var img = $('zoom-img');
  img.src = src;
  img.style.transform = 'scale(1)';
  $('zoom-overlay').classList.add('show');
  initZoom(img);
}

var zoomBound = false;
function initZoom(img) {
  if (zoomBound) return;
  zoomBound = true;
  var scale = 1, tx = 0, ty = 0;
  var startX = 0, startY = 0, dragging = false, moved = false;

  function apply() { img.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')'; }

  img.addEventListener('dblclick', function () {
    if (scale > 1) { scale = 1; tx = 0; ty = 0; } else { scale = 2.5; }
    apply();
  });
  img.addEventListener('touchstart', function (e) {
    if (e.touches.length === 1) {
      dragging = true; moved = false;
      startX = e.touches[0].clientX - tx;
      startY = e.touches[0].clientY - ty;
    }
  }, { passive: true });
  img.addEventListener('touchmove', function (e) {
    if (dragging && scale > 1 && e.touches.length === 1) {
      tx = e.touches[0].clientX - startX;
      ty = e.touches[0].clientY - startY;
      moved = true;
      apply();
      e.preventDefault();
    }
  }, { passive: false });
  img.addEventListener('touchend', function () { dragging = false; });
  img.addEventListener('mousedown', function (e) {
    if (scale <= 1) return;
    dragging = true; moved = false;
    startX = e.clientX - tx; startY = e.clientY - ty;
    e.preventDefault();
  });
  window.addEventListener('mousemove', function (e) {
    if (dragging && scale > 1) { tx = e.clientX - startX; ty = e.clientY - startY; apply(); }
  });
  window.addEventListener('mouseup', function () { dragging = false; });

  $('zoom-overlay').addEventListener('click', function (e) {
    if (e.target === $('zoom-overlay') || e.target === $('zoom-body')) {
      $('zoom-overlay').classList.remove('show');
      scale = 1; tx = 0; ty = 0; apply();
    }
  });
}

/* ---------- 时钟 ---------- */
function startClock() {
  function tick() {
    var d = new Date();
    var p = function (n) { return ('0' + n).slice(-2); };
    $('clock-now').textContent = '当前时间: ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    var sec = Math.floor((Date.now() - S.startTime) / 1000);
    $('clock-run').textContent = '运行时间: ' + p(Math.floor(sec / 3600)) + ':' + p(Math.floor(sec % 3600 / 60)) + ':' + p(sec % 60);
  }
  tick();
  setInterval(tick, 1000);
}

/* ---------- 事件绑定 ---------- */
function bindEvents() {
  // 主页功能按钮
  var btns = document.querySelectorAll('.func-grid .btn');
  for (var i = 0; i < btns.length; i++) {
    btns[i].addEventListener('click', function () {
      var act = this.dataset.act;
      if (act === 'user') {
        var v = prompt('请输入用户ID（1-30）:', S.currentUser);
        if (v === null) return;
        v = v.trim();
        if (/^\d+$/.test(v) && +v >= 1 && +v <= 30) {
          S.currentUser = v;
          $('main-user-label').textContent = '用户 ' + v;
          renderBankGrid();
          toast('用户' + v + '已登录');
        } else toast('无效的用户ID（请输入1-30之间的数字）');
      } else if (act === 'stat-id') {
        var s = prompt('请输入要统计的用户序号（1-30）:', S.statId || S.currentUser);
        if (s === null) return;
        S.statId = s.trim();
        if (S.statId) toast('统计对象：用户 ' + S.statId);
      } else if (act === 'review') openReview();
      else if (act === 'single') openSingleStats();
      else if (act === 'multi') openMultiStats();
      else if (act === 'help') $('help-overlay').classList.add('show');
      else if (act === 'submit-go') toast('请先选择题库开始答题');
      else if (act === 'update') {
        if (S.account === '0') { toast('该账户不支持更新功能！'); return; }
        // 从 OSS 下载最新更新包，浏览器内解压替换题库和图片，任何异常都不弹窗
        try { ossUpdate(); } catch (e) { toast('更新失败，请稍后再试'); }
      }
      else if (act === 'upload') toast('手机版暂不支持传题，请在电脑端使用');
      else if (act === 'app' || act === 'audio' || act === 'video') toast('请在电脑端使用此功能');
    });
  }

  $('logout-btn').addEventListener('click', function () {
    if (confirm('确定退出登录吗？（答题数据保留在本机）')) showPage('page-login');
  });

  // 答题页
  $('quiz-back').addEventListener('click', function () { renderBankGrid(); enterMain(); });
  $('quiz-submit').addEventListener('click', submitAnswer);
  $('quiz-prev').addEventListener('click', function () { navQuestion(-1); });
  $('quiz-next').addEventListener('click', function () { navQuestion(1); });
  $('quiz-img').addEventListener('click', function () { openZoom(this.src); });

  // 查看页
  $('review-back').addEventListener('click', function () { renderBankGrid(); enterMain(); });
  $('review-img').addEventListener('click', function () { openZoom(this.src); });

  // 统计页
  $('stats-back').addEventListener('click', function () { renderBankGrid(); enterMain(); });

  // 遮罩
  $('answer-close').addEventListener('click', function () { $('answer-overlay').classList.remove('show'); });
  $('answer-img').addEventListener('click', function () { openZoom(this.src); });
  $('help-close').addEventListener('click', function () { $('help-overlay').classList.remove('show'); });
}

/* ---------- 启动 ---------- */
function boot() {
  fetchWithRetry('assets/special_users.json', 3, 800).catch(function () {
    return [
      { username: '0', password: '0', expire_date: '9999/12/31' },
      { username: 'admin', password: 'admin123', expire_date: '2025/10/26' },
      { username: 'test', password: 'test456', expire_date: '2025/10/26' }
    ];
  }).then(function (su) {
    S.specialUsers = su || [];
    // 有缓存先用缓存（秒开），同时后台静默刷新到最新题库
    var cached = loadQCache();
    if (cached) {
      applyQuestions(cached);
    } else {
      S.questions = {};
      BANKS.forEach(function (b) { S.questions[b] = []; });
    }
    loadProgress();
    initLogin();
    bindEvents();
    startClock();
    loadQuestions(!cached);
  });
}

document.addEventListener('DOMContentLoaded', boot);
})();
