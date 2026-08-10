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
  reviewQid: null,
  anns: {},               // 批注数据（annotations.json，键统一为正斜杠路径）
  audioEl: null           // 正在播放的批注音频
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
/* ---------- 自定义输入框（系统 prompt() 在部分浏览器/安卓 WebView 会静默失败） ---------- */
var inputCb = null;
function askInput(title, initial, cb) {
  $('input-title').textContent = title;
  var f = $('input-field');
  f.value = initial || '';
  inputCb = cb;
  $('input-overlay').classList.add('show');
  setTimeout(function () { try { f.focus(); f.select(); } catch (e) {} }, 150);
}
function closeInput(ok) {
  $('input-overlay').classList.remove('show');
  var cb = inputCb;
  inputCb = null;
  if (ok && cb) cb($('input-field').value);
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
  // 统一图片路径里的反斜杠（电脑版 Windows 打包生成的路径带 \ ）
  BANKS.forEach(function (b) {
    var arr = S.questions[b] || [];
    for (var i = 0; i < arr.length; i++) {
      if (arr[i][2]) arr[i][2] = String(arr[i][2]).replace(/\\/g, '/');
      if (arr[i][3]) arr[i][3] = String(arr[i][3]).replace(/\\/g, '/');
    }
    if (!S.questions[b]) S.questions[b] = [];
  });
  S.questionsLoaded = true;
}

function loadQuestions(showStatus) {
  // 已经点过「更新」的设备：本机缓存才是最新题库，绝不能用内置旧题库覆盖它
  if (loadOssMeta() && loadQCache()) {
    if (showStatus) toast('题库已就绪');
    return Promise.resolve();
  }
  if (showStatus) toast('请点击更新后开始使用', 4500);
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

/* 显示图片：优先用更新包下载到本机的图片，没有再按原路径加载
   （电脑版题库的路径带 Windows 反斜杠，先统一成正斜杠；
     安卓 WebView 的 file:// 环境下 blob: 地址可能加载失败，统一转成 base64 data: 地址） */
function setImgSrc(el, path) {
  if (!path) return;
  var norm = String(path).replace(/\\/g, '/');
  el.src = norm;
  var alt = norm.replace(/^assets\//, '');
  idbGet('img:' + alt).then(function (b) {
    if (!b) { applyAnnComposite(el, alt); return; }
    var rd = new FileReader();
    rd.onload = function () { el.src = rd.result; applyAnnComposite(el, alt); };
    rd.readAsDataURL(b);
  }).catch(function () { applyAnnComposite(el, alt); });
}

/* ---------- 批注（音频/视频/图片批注，来自 OSS 更新包的 annotations.json） ---------- */
var ANN_KEY = 'mathlan_annotations_v1';

function normalizeAnns(raw) {
  var norm = {};
  Object.keys(raw || {}).forEach(function (k) {
    var v = raw[k];
    ['audio_annotations', 'video_annotations', 'image_annotations'].forEach(function (f) {
      (v[f] || []).forEach(function (a) { if (a.path) a.path = String(a.path).replace(/\\/g, '/'); });
    });
    norm[String(k).replace(/\\/g, '/')] = v;
  });
  return norm;
}
function loadAnns() {
  try { return JSON.parse(localStorage.getItem(ANN_KEY)) || {}; } catch (e) { return {}; }
}
function saveAnns(a) {
  try { localStorage.setItem(ANN_KEY, JSON.stringify(a)); } catch (e) {}
}
/* 某张题目/答案图片上挂的批注；没有则返回 null */
function annsFor(imgPath) {
  if (!imgPath) return null;
  var norm = String(imgPath).replace(/\\/g, '/').replace(/^assets\//, '');
  var a = (S.anns || {})[norm];
  if (!a) return null;
  var aud = a.audio_annotations || [], vid = a.video_annotations || [], img = a.image_annotations || [];
  var txt = a.text_annotations || [], fre = a.freehand_annotations || [];
  if (!aud.length && !vid.length && !img.length && !txt.length && !fre.length) return null;
  return { audio: aud, video: vid, image: img, text: txt, freehand: fre };
}
/* 把文本/符号/手写批注直接画到图片上（与电脑端一致：坐标基于图片原始像素） */
function drawAnns(ctx, anns) {
  (anns.freehand || []).forEach(function (a) {
    ctx.strokeStyle = a.color || 'red';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (a.type === 'circle' && a.center) {
      ctx.lineWidth = a.width || 2;
      ctx.setLineDash(a.dashed ? [5, 5] : []);
      ctx.beginPath();
      ctx.arc(a.center[0], a.center[1], a.radius || 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (a.type === 'line' && a.start_point && a.end_point) {
      ctx.lineWidth = a.width || 2;
      ctx.setLineDash(a.dashed ? [5, 5] : []);
      ctx.beginPath();
      ctx.moveTo(a.start_point[0], a.start_point[1]);
      ctx.lineTo(a.end_point[0], a.end_point[1]);
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      var pts = a.points || [];
      var ws = a.widths || a.dynamic_widths || [];
      for (var i = 0; i < pts.length - 1; i++) {
        var w1 = (ws[i] != null ? ws[i] : (a.width || 2));
        var w2 = (ws[i + 1] != null ? ws[i + 1] : (a.width || 2));
        ctx.lineWidth = Math.max(1, (w1 + w2) / 2);
        ctx.beginPath();
        ctx.moveTo(pts[i][0], pts[i][1]);
        ctx.lineTo(pts[i + 1][0], pts[i + 1][1]);
        ctx.stroke();
      }
    }
  });
  (anns.text || []).forEach(function (t) {
    var size = t.font_size || 64;
    ctx.font = (t.is_symbol ? 'bold ' : '') + size + 'px "Microsoft YaHei", "PingFang SC", sans-serif';
    ctx.fillStyle = t.color || 'red';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(t.text, t.x, t.y);
  });
}
/* 图片加载完成后，若上面有文字/手写批注则合成一张新图再显示 */
function applyAnnComposite(el, path) {
  var anns = annsFor(path);
  if (!anns || (!anns.text.length && !anns.freehand.length)) return;
  var stamp = String(Date.now()) + Math.random();
  el.dataset.annStamp = stamp;   // 防止快速翻题时旧图覆盖新图
  var im = new Image();
  im.onload = function () {
    if (el.dataset.annStamp !== stamp) return;
    try {
      if (!im.naturalWidth) return;
      var cv = document.createElement('canvas');
      cv.width = im.naturalWidth;
      cv.height = im.naturalHeight;
      var ctx = cv.getContext('2d');
      ctx.drawImage(im, 0, 0);
      drawAnns(ctx, anns);
      el.src = cv.toDataURL('image/png');
    } catch (e) {}
  };
  im.src = el.src;
}
/* 播放/查看批注文件（更新时已把批注文件存进 IndexedDB，键与图片相同规则） */
function playMedia(rel, kind) {
  var norm = String(rel).replace(/\\/g, '/');
  idbGet('img:' + norm).then(function (b) {
    if (!b) { toast('批注文件不在本机，请先点「更新」下载'); return; }
    if (kind === 'audio') {
      openAudioBar(b);   // 悬浮播放条：不遮挡页面，边听边看图
    } else if (kind === 'image') {
      var rd = new FileReader();
      rd.onload = function () { openMediaOverlay('image', rd.result); };
      rd.readAsDataURL(b);
    } else {
      openMediaOverlay(kind, b);
    }
  }).catch(function () { toast('读取批注失败'); });
}
/* 批注音频悬浮播放条：固定在屏幕底部，不遮挡题目/图片，可边听边操作 */
function openAudioBar(blob) {
  var bar = $('audio-bar'), a = $('audio-el');
  a.dataset.objUrl = '1';
  a.onerror = function () {
    if (!a.dataset.objUrl) return;
    a.dataset.objUrl = '';
    var rd = new FileReader();
    rd.onload = function () { a.src = rd.result; a.play().catch(function () {}); };
    rd.readAsDataURL(blob);
  };
  a.src = URL.createObjectURL(blob);
  bar.style.display = 'flex';
  var p = a.play();
  if (p && p.catch) p.catch(function () { toast('点底部播放条的 ▶ 开始收听'); });
}
function closeAudioBar() {
  var bar = $('audio-bar'), a = $('audio-el');
  try { a.pause(); } catch (e) {}
  a.removeAttribute('src');
  try { a.load(); } catch (e) {}
  bar.style.display = 'none';
}
/* 播放条位置可手动调整：按住 ⠿ 手柄拖动到任意位置 */
function initAudioBarDrag() {
  var bar = $('audio-bar'), grip = $('audio-grip');
  var sx = 0, sy = 0, sl = 0, st = 0, moving = false;
  function down(x, y) {
    var r = bar.getBoundingClientRect();
    sl = r.left; st = r.top;
    sx = x; sy = y;
    moving = true;
  }
  function move(x, y) {
    if (!moving) return;
    bar.classList.add('floating');
    bar.style.left = Math.max(0, Math.min(window.innerWidth - 80, sl + x - sx)) + 'px';
    bar.style.top = Math.max(0, Math.min(window.innerHeight - 50, st + y - sy)) + 'px';
  }
  function up() { moving = false; }
  grip.addEventListener('touchstart', function (e) { down(e.touches[0].clientX, e.touches[0].clientY); e.preventDefault(); }, { passive: false });
  grip.addEventListener('touchmove', function (e) { move(e.touches[0].clientX, e.touches[0].clientY); e.preventDefault(); }, { passive: false });
  grip.addEventListener('touchend', up);
  grip.addEventListener('mousedown', function (e) { down(e.clientX, e.clientY); e.preventDefault(); });
  window.addEventListener('mousemove', function (e) { move(e.clientX, e.clientY); });
  window.addEventListener('mouseup', up);
}
/* 音频/视频用悬浮播放器展示（带播放控件，自动播放被拦截时可手动点播放）。
   安卓 WebView 对 data: 地址的音视频支持差，优先用本机对象地址，加载失败再退回 data: 地址 */
function openMediaOverlay(kind, src) {
  var body = $('media-body');
  body.innerHTML = '';
  var media;
  if (kind === 'video') {
    media = document.createElement('video');
    media.controls = true; media.className = 'media-video';
    media.setAttribute('playsinline', '');
    $('media-title').textContent = '批注视频';
  } else if (kind === 'audio') {
    media = document.createElement('audio');
    media.controls = true; media.className = 'media-audio';
    $('media-title').textContent = '批注音频（点 ▶ 收听）';
  } else {
    media = document.createElement('img');
    media.className = 'media-img'; media.alt = '批注图片';
    $('media-title').textContent = '批注图片';
  }
  if (src instanceof Blob) {
    media.dataset.objUrl = '1';
    media.onerror = function () {
      if (!media.dataset.objUrl) return;
      media.dataset.objUrl = '';
      var rd = new FileReader();
      rd.onload = function () { media.src = rd.result; };
      rd.readAsDataURL(src);
    };
    media.src = URL.createObjectURL(src);
  } else {
    media.src = src;
  }
  if (kind === 'image') {
    media.addEventListener('click', function () {
      var src2 = media.src;
      closeMediaOverlay();   // 先关批注遮罩，放大页才能直接缩放旋转
      openZoom(src2);
    });
  }
  body.appendChild(media);
  $('media-overlay').classList.add('show');
  if (kind === 'audio' || kind === 'video') {
    var p = media.play();
    if (p && p.catch) p.catch(function () { /* 被拦截时用户手动点播放即可 */ });
  }
}
function closeMediaOverlay() {
  $('media-overlay').classList.remove('show');
  $('media-body').innerHTML = '';   // 同时停止视频播放
}
/* 在图片下方生成批注按钮条；没有批注则隐藏 */
function renderAnnBar(container, imgPath) {
  if (!container) return;
  container.innerHTML = '';
  var anns = annsFor(imgPath);
  if (!anns) { container.style.display = 'none'; return; }
  container.style.display = '';
  function addBtn(list, label, kind) {
    list.forEach(function (a, i) {
      var b = el('button', 'btn btn-small ann-btn', label + (list.length > 1 ? ' ' + (i + 1) : ''));
      b.addEventListener('click', function (ev) { ev.stopPropagation(); playMedia(a.path, kind); });
      container.appendChild(b);
    });
  }
  addBtn(anns.audio, '▶ 听批注', 'audio');
  addBtn(anns.video, '▶ 看批注视频', 'video');
  addBtn(anns.image, '🖼 看批注图', 'image');
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

/* ---------- 版本识别：先对比 OSS 文件的大小和时间，相同就不下载 ---------- */
var OSS_META_KEY = 'mathlan_oss_meta_v1';
/* 内容格式版本：v2 起更新包会下载批注文件；本机记录缺这个字段时，
   即使 OSS 文件没变也要重新下载一次，把批注补齐 */
var OSS_CONTENT_V = 2;

function saveOssMeta(size, lastModified) {
  try {
    localStorage.setItem(OSS_META_KEY, JSON.stringify({
      size: size, lastModified: lastModified, localTime: Date.now(), v: OSS_CONTENT_V
    }));
  } catch (e) {}
}

function loadOssMeta() {
  try {
    var s = localStorage.getItem(OSS_META_KEY);
    return s ? JSON.parse(s) : null;
  } catch (e) { return null; }
}

function fmtTime(t) {
  var d = new Date(t);
  function p(n) { return (n < 10 ? '0' : '') + n; }
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function refreshUpdateTimeLabel() {
  var el = $('update-time-label');
  if (!el) return;
  var m = loadOssMeta();
  el.textContent = m ? ('题库更新于 ' + fmtTime(m.localTime)) : '';
}

/* 用极小流量（只要前1个字节）读取 OSS 文件的大小和最后修改时间 */
function checkOssVersion() {
  return fetch(OSS_ZIP_URL + '?t=' + Date.now(), {
    headers: { Range: 'bytes=0-0' }, cache: 'no-store'
  }).then(function (r) {
    if (r.status !== 206 && !r.ok) throw new Error('meta ' + r.status);
    var size = 0;
    var cr = r.headers.get('Content-Range');
    if (cr) { var mm = /\/(\d+)\s*$/.exec(cr); if (mm) size = +mm[1]; }
    return { size: size, lastModified: r.headers.get('Last-Modified') || '' };
  });
}

function downloadAndApply(meta) {
  toast('发现新版本，正在下载…', 30000);
  return fetchBinRetry(OSS_ZIP_URL + '?t=' + Date.now(), 3, 1000)
    .then(function (buf) {
      var size = buf.byteLength;
      return JSZip.loadAsync(buf).then(function (zip) {
        var jobs = [];
        var qData = null, annData = null;
        zip.forEach(function (rel, file) {
          if (file.dir) return;
          rel = rel.replace(/\\/g, '/');
          if (rel === 'math_questions.json') {
            jobs.push(file.async('string').then(function (s) { qData = JSON.parse(s); }));
          } else if (rel === 'annotations.json') {
            jobs.push(file.async('string').then(function (s) {
              try { annData = normalizeAnns(JSON.parse(s)); } catch (e) {}
            }));
          } else if (/^(question_images|answer_images|audio_annotations|video_annotations|image_annotations)\//.test(rel)) {
            jobs.push(file.async('blob').then(function (b) { return idbSet('img:' + rel, b); }));
          }
        });
        return idbClearImages().then(function () { return Promise.all(jobs); }).then(function () {
          if (qData) {
            applyQuestions(qData);
            saveQCache(qData);
            // 与电脑版一致：更新后清空本机答题进度，旧题一律不留
            try { localStorage.removeItem(STORE_KEY); } catch (e) {}
            S.progress = blankProgress();
            saveProgress();
            S.bid = null;
            S.bidQuestions = [];
            renderBankGrid();
          }
          if (annData) { saveAnns(annData); S.anns = annData; }
          saveOssMeta(size, meta && meta.lastModified ? meta.lastModified : '');
          refreshUpdateTimeLabel();
          toast('更新完成 ✅ 题库更新于 ' + fmtTime(Date.now()), 3500);
        });
      });
    });
}

function ossUpdate() {
  if (typeof JSZip === 'undefined') { toast('更新组件缺失，请检查网络后刷新'); loadQuestions(false); return; }
  toast('正在检查更新…');
  checkOssVersion().then(function (meta) {
    var local = loadOssMeta();
    // OSS 文件的大小和时间与本机记录完全一致、且内容格式也是新版 → 已是最新，不下载
    if (local && local.v === OSS_CONTENT_V && meta.lastModified && local.lastModified === meta.lastModified &&
        (!meta.size || !local.size || local.size === meta.size)) {
      toast('您的题库已是最新版 ✅', 3000);
      return null;
    }
    return downloadAndApply(meta);
  }).catch(function () {
    // 版本识别失败时仍尝试完整下载更新
    downloadAndApply(null).catch(function () { toast('更新失败，请检查网络后重试', 4000); });
  });
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
      for (var u in saved) {
        if (!base[u]) { base[u] = saved[u]; continue; }   // 自由ID用户直接保留
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

/* 任意用户ID都可用：不存在时按需创建 */
function userData(uid, bid) {
  uid = String(uid);
  if (!S.progress[uid]) S.progress[uid] = {};
  if (!S.progress[uid][bid]) S.progress[uid][bid] = { remaining: [], history: [] };
  return S.progress[uid][bid];
}

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
    } else {
      // 第一次使用：默认填入 0 / 0（用户自己登录过以后就保留用户自己的）
      $('login-username').value = '0';
      $('login-password').value = '0';
      $('login-remember').checked = true;
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
      S.lastAIAnalysis = '';   // 换账户后清空上一次 AI 分析，避免混进别人的 PDF
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
  refreshUpdateTimeLabel();
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
  var allowed = allowedBanks();
  BANKS.forEach(function (bid) {
    var ok = !allowed || allowed.indexOf(bid) >= 0;
    var st = bankState(S.currentUser, bid);
    var b = el('button', 'btn' + (st ? ' ' + st : '') + (ok ? '' : ' locked'),
      bid + (st === 'ok' ? ' ✓' : st === 'bad' ? ' ?' : ''));
    b.addEventListener('click', function () {
      if (!ok) { toast('该账户只能打开 ' + allowed.join('、') + ' 题库的题目', 3000); return; }
      openQuiz(bid);
    });
    grid.appendChild(b);
  });
}

/* 当前账户允许打开的题库（无限制返回 null，账户 c2 只返回 ['C2']） */
function allowedBanks() {
  var sus = S.specialUsers || [];
  for (var i = 0; i < sus.length; i++) {
    if (sus[i].username === S.account && sus[i].banks) return sus[i].banks;
  }
  return null;
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
  var allowed = allowedBanks();
  if (allowed && allowed.indexOf(bid) < 0) { toast('该账户只能打开 ' + allowed.join('、') + ' 题库的题目', 3000); return; }
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
  renderAnnBar($('quiz-ann'), q[2]);

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
  renderAnnBar($('answer-ann'), src);
  $('answer-overlay').classList.add('show');
}

/* ---------- 查看（错题） ---------- */
var reviewTab = 'A1';
var reviewDelArm = 0;   // 安卓 WebView 不支持 confirm()，用「再点一次确认」代替
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
    renderAnnBar($('review-ann'), img);
    $('review-delete').style.display = '';
  } else {
    $('review-hint').style.display = '';
    $('review-hint').textContent = '该题目没有答案图片';
    $('review-img').style.display = 'none';
    renderAnnBar($('review-ann'), '');
    $('review-delete').style.display = '';
  }
  $('review-delete').onclick = function () {
    // 安卓 WebView 不支持 confirm() 弹窗，改为「再点一次确认」
    if (Date.now() - reviewDelArm >= 3000) {
      reviewDelArm = Date.now();
      toast('再点一次「删除」确认删除这条错误记录', 2800);
      return;
    }
    reviewDelArm = 0;
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

/* ---------- 打开「算算」网页（安卓 APP 由外壳接管跳转到系统浏览器） ---------- */
function openSuansuan() {
  try {
    var a = document.createElement('a');
    a.href = 'https://yue5945.github.io/suansuan/';
    a.target = '_blank';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (e) { toast('打开失败，请稍后再试'); }
}

/* ---------- 统计（统一页：总览 + 明细 + 分析建议 + 全员概览 + 导出PDF） ---------- */
function pct(x) { return (x * 100).toFixed(1) + '%'; }

function collectUserStats(uid) {
  var per = [], total = 0, correct = 0, time = 0;
  BANKS.forEach(function (bid) {
    var h = userData(uid, bid).history;
    if (!h.length) return;
    var c = 0, t = 0;
    h.forEach(function (r) { if (r.correct) c++; t += r.duration; });
    per.push({ bid: bid, total: h.length, correct: c, time: t });
    total += h.length; correct += c; time += t;
  });
  return { per: per, total: total, correct: correct, time: time };
}

function countWrongRecords(uid) {
  var seen = {}, n = 0;
  BANKS.forEach(function (bid) {
    userData(uid, bid).history.forEach(function (h, i) {
      if (h.correct) return;
      var qt = h.question || '';
      var qid = bid + ':' + (qt.indexOf(':') >= 0 ? qt.split(':')[0] : ('题目' + (i + 1)));
      if (!seen[qid]) { seen[qid] = 1; n++; }
    });
  });
  return n;
}

/* 根据数据生成分析与学习策略 */
function statsAdvice(st, uid) {
  var tips = [];
  if (!st.total) { tips.push('还没有答题记录，先选择题库开始答题吧。'); return tips; }
  var rate = st.correct / st.total;
  if (rate >= 0.9) tips.push('整体正确率 ' + pct(rate) + '，掌握得很好，可以加快节奏或挑战更多题库。');
  else if (rate >= 0.7) tips.push('整体正确率 ' + pct(rate) + '，基础扎实，重点巩固薄弱题库即可。');
  else tips.push('整体正确率 ' + pct(rate) + '，建议先放慢速度，复习错题后再刷新题。');
  if (st.per.length) {
    var weak = st.per.slice().sort(function (a, b) { return a.correct / a.total - b.correct / b.total; })[0];
    var wr = weak.correct / weak.total;
    if (wr < 0.8) tips.push('题库 ' + weak.bid + ' 正确率最低（' + pct(wr) + '），建议优先重练本题库，并到「错题本」复习对应错题。');
    var slow = st.per.slice().sort(function (a, b) { return b.time / b.total - a.time / a.total; })[0];
    var avg = slow.time / slow.total;
    if (avg > 60) tips.push('题库 ' + slow.bid + ' 平均用时 ' + avg.toFixed(0) + ' 秒偏长，注意总结题型套路、提升做题速度。');
  }
  var wrongs = countWrongRecords(uid);
  if (wrongs > 0) tips.push('当前共有 ' + wrongs + ' 道错题，建议今天先过一遍「错题本」再刷新题。');
  return tips;
}

function statCard(label, val) {
  var d = el('div', 'stat-card');
  d.appendChild(el('div', 'stat-card-val', String(val)));
  d.appendChild(el('div', 'stat-card-label', label));
  return d;
}

function openStats() {
  var uid = S.currentUser;
  $('stats-title').textContent = '统计 · 用户' + uid;
  var body = $('stats-body');
  body.innerHTML = '';
  var st = collectUserStats(uid);

  var cards = el('div', 'stat-cards');
  cards.appendChild(statCard('总答题', st.total));
  cards.appendChild(statCard('正确率', st.total ? pct(st.correct / st.total) : '--'));
  cards.appendChild(statCard('平均用时', st.total ? (st.time / st.total).toFixed(1) + '秒' : '--'));
  cards.appendChild(statCard('总用时', (st.time / 60).toFixed(1) + '分'));
  body.appendChild(cards);

  if (st.per.length) {
    var sec1 = el('div', 'stats-sec');
    sec1.appendChild(el('h3', '', '各题库明细'));
    sec1.appendChild(statsTable(['题库', '答题数', '正确数', '正确率', '平均用时(秒)'],
      st.per.map(function (p) { return [p.bid, p.total, p.correct, pct(p.correct / p.total), (p.time / p.total).toFixed(1)]; })));
    body.appendChild(sec1);
  }

  var sec2 = el('div', 'stats-sec');
  sec2.appendChild(el('h3', '', '分析与建议'));
  statsAdvice(st, uid).forEach(function (t) { sec2.appendChild(el('p', 'advice', '· ' + t)); });
  body.appendChild(sec2);

  // 全部用户概览（当前用户置顶）
  var uids = [String(uid)];
  Object.keys(S.progress).forEach(function (u) { if (u !== String(uid)) uids.push(u); });
  var rows = [];
  uids.forEach(function (u) {
    var s2 = collectUserStats(u);
    if (!s2.total) return;
    rows.push([u === String(uid) ? u + '（当前）' : u, s2.total, s2.correct, pct(s2.correct / s2.total), (s2.time / s2.total).toFixed(1)]);
  });
  if (rows.length) {
    var sec3 = el('div', 'stats-sec');
    sec3.appendChild(el('h3', '', '全部用户概览'));
    sec3.appendChild(statsTable(['用户', '答题数', '正确数', '正确率', '平均用时(秒)'], rows));
    body.appendChild(sec3);
  }
  showPage('page-stats');
}

/* ---------- 错题本（汇总全部题库的错题，可导出PDF） ---------- */
function collectWrongRecords() {
  var list = [], seen = {};
  BANKS.forEach(function (bid) {
    userData(S.currentUser, bid).history.forEach(function (h, i) {
      if (h.correct) return;
      var qt = h.question || '';
      var qid = qt.indexOf(':') >= 0 ? qt.split(':')[0] : ('题目' + (i + 1));
      var key = bid + ':' + qid;
      if (seen[key]) return;
      seen[key] = 1;
      list.push({ bid: bid, qid: qid, record: h });
    });
  });
  return list;
}

function openWrongbook() {
  var list = collectWrongRecords();
  $('wrongbook-count').textContent = list.length ? list.length + ' 道' : '';
  var box = $('wrong-list');
  box.innerHTML = '';
  if (!list.length) box.appendChild(el('p', 'review-empty', '太棒了，当前没有错题！'));
  list.forEach(function (item) {
    var row = el('div', 'review-item');
    row.appendChild(el('span', '', item.bid + ' · ' + item.qid));
    row.appendChild(el('span', '', '用时 ' + item.record.duration + ' 秒'));
    row.addEventListener('click', function () {
      var rows = box.querySelectorAll('.review-item');
      for (var i = 0; i < rows.length; i++) rows[i].classList.remove('on');
      row.classList.add('on');
      var img = item.record.answer_image || '';
      if (img) {
        $('wrong-hint').style.display = 'none';
        $('wrong-img').style.display = '';
        setImgSrc($('wrong-img'), img);
        renderAnnBar($('wrong-ann'), img);
      } else {
        $('wrong-hint').style.display = '';
        $('wrong-hint').textContent = '该题目没有答案图片';
        $('wrong-img').style.display = 'none';
        renderAnnBar($('wrong-ann'), '');
      }
    });
    box.appendChild(row);
  });
  $('wrong-hint').style.display = list.length ? '' : 'none';
  $('wrong-hint').textContent = '点击上方错题查看答案图片';
  $('wrong-img').style.display = 'none';
  renderAnnBar($('wrong-ann'), '');
  showPage('page-wrongbook');
}

/* ---------- AI 分析及建议（DeepSeek，错题本） ---------- */
/* Key 以 base64 存放（公开仓库安全扫描要求），运行时解码使用 */
var DEEPSEEK_KEY = atob('c2stNGNmOGRmMDljOTAyNDY0MzhkNzUzYWM0ZjBhMmViMTg=');
/* DeepSeek 官方接口只收文字，不能直接读图；先用 Tesseract 把每道错题的
   题目图/答案图识别成文字，再交给 AI 逐题分析知识点。
   轻量识别数据放在 GitHub Pages，安卓/网页通用，浏览器会自动缓存。 */
var TESS_LANG_PATH = 'https://yue5945.github.io/mathlan-web/tessdata';
var AI_OCR_MAX = 15;        // 单次最多分析 15 道错题（太多会很慢）
var AI_OCR_TIMEOUT = 45000; // 单张图识别最长 45 秒

/* 把任意图片来源统一转成 data: 地址（识别引擎在安卓 file:// 下读不了相对路径） */
function ensureDataURL(src) {
  return new Promise(function (res) {
    if (!src) { res(''); return; }
    if (String(src).indexOf('data:') === 0) { res(src); return; }
    var im = new Image();
    im.onload = function () {
      try {
        var cv = document.createElement('canvas');
        cv.width = im.naturalWidth; cv.height = im.naturalHeight;
        cv.getContext('2d').drawImage(im, 0, 0);
        res(cv.toDataURL('image/jpeg', 0.92));
      } catch (e) { res(''); }
    };
    im.onerror = function () { res(''); };
    im.src = src;
  });
}

/* 识别一道错题的题目图和答案图，返回文字 */
function ocrOneQuestion(worker, item) {
  var jobs = [];
  if (item.qimg) jobs.push(getCompositedDataURL(item.qimg).then(ensureDataURL));
  if (item.aimg) jobs.push(getCompositedDataURL(item.aimg).then(ensureDataURL));
  if (!jobs.length) return Promise.resolve({ q: '', a: '' });
  return Promise.all(jobs).then(function (srcs) {
    var out = { q: '', a: '' };
    var seq = Promise.resolve();
    srcs.forEach(function (src, i) {
      seq = seq.then(function () {
        if (!src) return;
        var job = worker.recognize(src).then(function (r) {
          var t = (r && r.data && r.data.text ? r.data.text : '').replace(/\s+/g, ' ').trim();
          if (item.qimg && i === 0) out.q = t; else out.a = t;
        });
        // 单张图超时保护：超时就跳过这张图，不拖垮整体
        return Promise.race([job, new Promise(function (res) { setTimeout(res, AI_OCR_TIMEOUT); })]);
      });
    });
    return seq.then(function () { return out; });
  });
}

/* 特殊账户 0/0：禁止使用 AI 分析和导出 PDF */
function deniedForAccount0() {
  if (S.account === '0') { toast('该账户暂不支持此功能，申请开通请微信mathlan3', 3500); return true; }
  return false;
}

function aiAnalyzeWrongbook() {
  if (deniedForAccount0()) return;
  var box = $('wrong-ai');
  var list = collectWrongRecords();
  box.style.display = '';
  if (!list.length) { box.textContent = '当前没有错题，全部掌握得很好，无需分析！'; return; }
  if (!window.Tesseract) { box.textContent = '图片识别组件未加载，请检查网络后刷新页面再试。'; return; }

  // 为每道错题找回题目图和答案图
  var items = [];
  list.forEach(function (it) {
    var row = null, qs = S.questions[it.bid] || [];
    for (var i = 0; i < qs.length; i++) {
      if (qs[i][0] === it.record.question) { row = qs[i]; break; }
    }
    items.push({
      bid: it.bid, qid: it.qid,
      qimg: row ? row[2] : '',
      aimg: (row && row[3]) || it.record.answer_image || ''
    });
  });
  var totalAll = items.length;
  var over = totalAll > AI_OCR_MAX;
  if (over) items = items.slice(0, AI_OCR_MAX);

  box.textContent = '首次使用正在下载图片识别数据（约4MB，以后不用再下）…';

  var worker = null;
  Tesseract.createWorker(['chi_sim', 'eng'], 1, { langPath: TESS_LANG_PATH }).then(function (w) {
    worker = w;
    var results = [];
    var seq = Promise.resolve();
    items.forEach(function (item, i) {
      seq = seq.then(function () {
        box.textContent = '正在识别错题图片 ' + (i + 1) + '/' + items.length +
          '（' + item.bid + ' · ' + item.qid + '）…';
        return ocrOneQuestion(worker, item).then(function (r) {
          results.push({ item: item, text: r });
        });
      });
    });
    return seq.then(function () { return results; });
  }).then(function (results) {
    box.textContent = '图片识别完成，AI 正在逐题分析知识点…';
    var blocks = results.map(function (r, i) {
      var q = (r.text.q || '').slice(0, 300);
      var a = (r.text.a || '').slice(0, 300);
      var body = '';
      if (q) body += '题目内容：' + q + '。';
      if (a) body += '答案/解析内容：' + a + '。';
      if (!body) body = '（该题图片文字识别失败）';
      return '第' + (i + 1) + '题（' + r.item.bid + '题库）：' + body;
    });
    var prompt = '你是一位经验丰富的数学老师。下面是一位学生做错的题目，内容由图片识别得到，' +
      '可能有少量错字或公式不完整，请结合数学常识判断。\n\n' + blocks.join('\n') +
      '\n\n请严格按以下三部分用中文回答：\n' +
      '一、逐题分析：每道题一行，格式为「第n题：考查知识点（要具体，如：立体几何—正三棱柱体积计算）；学生可能的易错点」。' +
      '若某题识别失败无法判断，就写「第n题：图片内容无法识别」。\n' +
      '二、归纳总结：把这些错题考查的知识点归类，指出该生最主要的2到3个薄弱模块。\n' +
      '三、学习建议：针对每个薄弱模块给出具体可操作的复习建议（练什么类型的题、注意什么方法步骤）。\n' +
      '语气亲切鼓励，总字数700字以内。';
    return fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + DEEPSEEK_KEY },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1500,
        temperature: 0.5
      })
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (d) {
      var text = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
      text = text || 'AI 没有返回内容，请稍后再试。';
      // 存起来，导出错题本 PDF 时一起带上
      S.lastAIAnalysis = (over ? '（错题较多，本次分析前 ' + AI_OCR_MAX + ' 道）\n' : '') + text;
      box.textContent = (over ? '（错题较多，本次分析前 ' + AI_OCR_MAX + ' 道）\n\n' : '') + text;
    });
  }).catch(function () {
    box.textContent = 'AI 分析失败，请检查网络后重试。';
  }).then(function () {
    if (worker) worker.terminate();
  });
}

/* ---------- PDF 生成（统计报告 / 错题本，可保存可转发微信） ---------- */
/* 取图片地址：优先本机更新包，并把文字/手写批注画上去 */
function getCompositedDataURL(path) {
  return new Promise(function (res) {
    var norm = String(path).replace(/\\/g, '/');
    var alt = norm.replace(/^assets\//, '');
    idbGet('img:' + alt).then(function (b) {
      if (!b) { finish(norm); return; }
      var rd = new FileReader();
      rd.onload = function () { finish(rd.result); };
      rd.readAsDataURL(b);
    }).catch(function () { finish(norm); });
    function finish(src) {
      var anns = annsFor(alt);
      if (!anns || (!anns.text.length && !anns.freehand.length)) { res(src); return; }
      var im = new Image();
      im.onload = function () {
        try {
          var cv = document.createElement('canvas');
          cv.width = im.naturalWidth; cv.height = im.naturalHeight;
          var ctx = cv.getContext('2d');
          ctx.drawImage(im, 0, 0);
          drawAnns(ctx, anns);
          res(cv.toDataURL('image/png'));
        } catch (e) { res(src); }
      };
      im.onerror = function () { res(src); };
      im.src = src;
    }
  });
}

/* 保存/分享：浏览器优先调系统分享（可转发微信），其次本机对象地址下载；
   安卓 APP（file://）走 data: 地址，由外壳保存到「下载」文件夹 */
function sharePDF(blob, filename) {
  try {
    var file = new File([blob], filename, { type: 'application/pdf' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: filename }).catch(function () {});
      return;
    }
  } catch (e) {}
  if (location.protocol === 'file:') {
    var rd = new FileReader();
    rd.onload = function () {
      // data: 地址附加文件名参数，便于安卓外壳识别保存
      var url = rd.result.replace('data:application/pdf',
        'data:application/pdf;filename=' + encodeURIComponent(filename));
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast('PDF 已生成，可在「下载」文件夹查看', 3200);
    };
    rd.readAsDataURL(blob);
  } else {
    // 浏览器：对象地址下载，稳定可靠
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 8000);
    toast('PDF 已开始下载', 3200);
  }
}

/* 把一段排版好的内容（隐藏容器内）渲染成多页 PDF */
function exportDomToPDF(dom, filename) {
  if (!window.jspdf || !window.html2canvas) { toast('PDF 组件未加载，请检查网络后刷新'); return; }
  toast('正在生成PDF…', 30000);
  var holder = $('pdf-holder');
  holder.innerHTML = '';
  holder.appendChild(dom);
  html2canvas(dom, { scale: 2, backgroundColor: '#FFF5E1', logging: false }).then(function (canvas) {
    holder.innerHTML = '';
    var pdf = new window.jspdf.jsPDF('p', 'mm', 'a4');
    var margin = 10, imgW = 190;
    var pxPerMm = canvas.width / imgW;
    var pagePxH = Math.floor(277 * pxPerMm);
    var y = 0, page = 0;
    while (y < canvas.height) {
      var h = Math.min(pagePxH, canvas.height - y);
      var pc = document.createElement('canvas');
      pc.width = canvas.width; pc.height = h;
      var ctx = pc.getContext('2d');
      ctx.fillStyle = '#FFF5E1';
      ctx.fillRect(0, 0, pc.width, pc.height);
      ctx.drawImage(canvas, 0, y, canvas.width, h, 0, 0, canvas.width, h);
      if (page > 0) pdf.addPage();
      pdf.addImage(pc.toDataURL('image/jpeg', 0.92), 'JPEG', margin, margin, imgW, h / pxPerMm);
      y += h; page++;
    }
    sharePDF(pdf.output('blob'), filename);
  }).catch(function () { holder.innerHTML = ''; toast('PDF 生成失败，请重试'); });
}

function exportStatsPDF() {
  if (deniedForAccount0()) return;
  var uid = S.currentUser;
  var st = collectUserStats(uid);
  var rep = el('div', 'pdf-report');
  rep.appendChild(el('h1', '', '数问阑珊 · 学习统计报告'));
  rep.appendChild(el('p', 'pdf-sub', '用户 ' + uid + ' · 生成时间 ' + fmtTime(Date.now())));
  rep.appendChild(el('p', 'pdf-line', '总答题 ' + st.total + ' 道 · 正确 ' + st.correct + ' 道 · 正确率 ' +
    (st.total ? pct(st.correct / st.total) : '--') + ' · 平均用时 ' + (st.total ? (st.time / st.total).toFixed(1) + ' 秒' : '--') +
    ' · 总用时 ' + (st.time / 60).toFixed(1) + ' 分钟'));
  if (st.per.length) {
    rep.appendChild(el('h2', '', '各题库明细'));
    rep.appendChild(statsTable(['题库', '答题数', '正确数', '正确率', '平均用时(秒)'],
      st.per.map(function (p) { return [p.bid, p.total, p.correct, pct(p.correct / p.total), (p.time / p.total).toFixed(1)]; })));
  }
  rep.appendChild(el('h2', '', '分析与建议'));
  statsAdvice(st, uid).forEach(function (t) { rep.appendChild(el('p', 'pdf-line', '· ' + t)); });
  rep.appendChild(el('p', 'pdf-foot', '数问阑珊 MathLan · 开发者微信：mathlan3'));
  exportDomToPDF(rep, '数问阑珊-统计报告-用户' + uid + '.pdf');
}

function exportWrongbookPDF() {
  if (deniedForAccount0()) return;
  var list = collectWrongRecords();
  if (!list.length) { toast('当前没有错题，无需导出'); return; }
  if (!window.jspdf || !window.html2canvas) { toast('PDF 组件未加载，请检查网络后刷新'); return; }
  toast('正在整理错题和图片…', 30000);
  var rep = el('div', 'pdf-report');
  rep.appendChild(el('h1', '', '数问阑珊 · 错题本'));
  rep.appendChild(el('p', 'pdf-sub', '用户 ' + S.currentUser + ' · 共 ' + list.length + ' 道错题 · 生成时间 ' + fmtTime(Date.now())));
  var chain = Promise.resolve();
  list.forEach(function (item, idx) {
    chain = chain.then(function () {
      var sec = el('div', 'pdf-wrong');
      sec.appendChild(el('h2', '', (idx + 1) + '. 题库 ' + item.bid + ' · ' + item.qid + '（用时 ' + item.record.duration + ' 秒）'));
      rep.appendChild(sec);
      var imgPath = item.record.answer_image || '';
      if (!imgPath) { sec.appendChild(el('p', 'pdf-line', '（无答案图片）')); return null; }
      return getCompositedDataURL(imgPath).then(function (url) {
        if (!url) { sec.appendChild(el('p', 'pdf-line', '（图片不在本机，请先点「更新」）')); return null; }
        var im = el('img', 'pdf-img');
        im.src = url;
        sec.appendChild(im);
        return new Promise(function (res) {
          if (im.complete && im.naturalWidth) { res(); return; }
          im.onload = function () { res(); };
          im.onerror = function () { res(); };
        });
      });
    });
  });
  chain.then(function () {
    // 如果刚做过 AI 分析，把分析结果附在错题后面一起导出
    if (S.lastAIAnalysis) {
      rep.appendChild(el('h2', '', 'AI 分析及建议'));
      S.lastAIAnalysis.split('\n').forEach(function (line) {
        if (line.trim()) rep.appendChild(el('p', 'pdf-line', line));
      });
    }
    rep.appendChild(el('p', 'pdf-foot', '数问阑珊 MathLan · 开发者微信：mathlan3'));
    exportDomToPDF(rep, '数问阑珊-错题本-用户' + S.currentUser + '.pdf');
  });
}

/* ---------- 图片放大（双击/按钮缩放、单指拖动、按钮旋转） ---------- */
function openZoom(src) {
  var img = $('zoom-img');
  img.src = src;
  img.style.transform = 'translate(0px,0px) scale(1) rotate(0deg)';
  $('audio-bar').classList.add('up');   // 播放条上移，避开缩放工具条
  $('zoom-overlay').classList.add('show');
  initZoom(img);
}

var zoomBound = false;
function initZoom(img) {
  if (zoomBound) return;
  zoomBound = true;
  var scale = 1, tx = 0, ty = 0, rot = 0;
  var startX = 0, startY = 0, dragging = false, moved = false;

  function apply() {
    img.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ') rotate(' + rot + 'deg)';
  }
  function bindCtrl(id, fn) {
    var b = $(id);
    if (b) b.addEventListener('click', function (e) { e.stopPropagation(); fn(); });
  }
  bindCtrl('zoom-in', function () { scale = Math.min(6, scale * 1.3); apply(); });
  bindCtrl('zoom-out', function () {
    scale = Math.max(0.4, scale / 1.3);
    if (scale <= 1) { tx = 0; ty = 0; }
    apply();
  });
  bindCtrl('zoom-rotl', function () { rot = (rot - 90 + 360) % 360; apply(); });
  bindCtrl('zoom-rotr', function () { rot = (rot + 90) % 360; apply(); });

  // 双指捏合缩放（双指间距变化控制大小，双指整体移动控制位置）
  var zoomBody = $('zoom-body');
  var pinchDist = 0, pinchScale = 1, pinchTx = 0, pinchTy = 0, pinchMidX = 0, pinchMidY = 0;
  function tDist(t) {
    var dx = t[0].clientX - t[1].clientX, dy = t[0].clientY - t[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }
  function tMid(t) { return { x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 }; }
  zoomBody.addEventListener('touchstart', function (e) {
    if (e.touches.length === 2) {
      dragging = false;
      pinchDist = tDist(e.touches);
      pinchScale = scale;
      pinchTx = tx; pinchTy = ty;
      var m = tMid(e.touches);
      pinchMidX = m.x; pinchMidY = m.y;
    }
  }, { passive: true });
  zoomBody.addEventListener('touchmove', function (e) {
    if (e.touches.length === 2 && pinchDist > 0) {
      scale = Math.min(6, Math.max(0.4, pinchScale * tDist(e.touches) / pinchDist));
      var m = tMid(e.touches);
      tx = pinchTx + (m.x - pinchMidX);
      ty = pinchTy + (m.y - pinchMidY);
      apply();
      e.preventDefault();
    }
  }, { passive: false });
  zoomBody.addEventListener('touchend', function (e) {
    if (e.touches.length < 2) pinchDist = 0;
  }, { passive: true });

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
      $('audio-bar').classList.remove('up');   // 播放条回到底部
      scale = 1; tx = 0; ty = 0; rot = 0; apply();
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
        askInput('请输入用户ID（可自由设置，不限数量）', S.currentUser, function (v) {
          v = (v || '').trim();
          if (v) {
            S.currentUser = v;
            $('main-user-label').textContent = '用户 ' + v;
            renderBankGrid();
            toast('用户' + v + '已登录');
          } else toast('用户ID不能为空');
        });
      } else if (act === 'review') openReview();
      else if (act === 'stats') openStats();
      else if (act === 'wrongbook') openWrongbook();
      else if (act === 'help') $('help-overlay').classList.add('show');
      else if (act === 'submit-go') toast('请先选择题库开始答题');
      else if (act === 'update') {
        if (S.account === '0') { toast('该账户不支持更新功能，详询微信：mathlan3', 3500); return; }
        // 从 OSS 下载最新更新包，浏览器内解压替换题库和图片，任何异常都不弹窗
        try { ossUpdate(); } catch (e) { toast('更新失败，请稍后再试'); }
      }
      else if (act === 'suansuan') openSuansuan();
      else if (act === 'app') toast('请在电脑端使用此功能');
    });
  }

  // 安卓 WebView 不支持 confirm() 弹窗（点击会静默失败），改为「再点一次确认」
  var logoutArm = 0;
  $('logout-btn').addEventListener('click', function () {
    if (Date.now() - logoutArm < 3000) { logoutArm = 0; showPage('page-login'); return; }
    logoutArm = Date.now();
    toast('再点一次「退出登录」确认退出（答题数据保留在本机）', 2800);
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
  $('media-close').addEventListener('click', closeMediaOverlay);
  $('audio-bar-close').addEventListener('click', closeAudioBar);
  $('input-ok').addEventListener('click', function () { closeInput(true); });
  $('input-cancel').addEventListener('click', function () { closeInput(false); });
  $('input-field').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') closeInput(true);
  });

  // 统计页
  $('stats-switch').addEventListener('click', function () {
    askInput('请输入要统计的用户ID', S.currentUser, function (v) {
      v = (v || '').trim();
      if (!v) return;
      S.currentUser = v;
      $('main-user-label').textContent = '用户 ' + v;
      renderBankGrid();
      openStats();
    });
  });
  $('stats-export').addEventListener('click', exportStatsPDF);

  // 错题本页
  $('wrongbook-back').addEventListener('click', function () { renderBankGrid(); enterMain(); });
  $('wrongbook-export').addEventListener('click', exportWrongbookPDF);
  $('wrong-ai-btn').addEventListener('click', aiAnalyzeWrongbook);
  $('wrong-img').addEventListener('click', function () { openZoom(this.src); });

  // 播放条拖动手柄
  initAudioBarDrag();
}

/* ---------- 启动 ---------- */
function boot() {
  fetchWithRetry('assets/special_users.json', 3, 800).catch(function () {
    return [
      { username: '0', password: '0', expire_date: '9999/12/31' },
      { username: 'admin', password: 'admin123', expire_date: '2025/10/26' },
      { username: 'test', password: 'test456', expire_date: '2025/10/26' },
      { username: 'c2', password: 'wlkq', expire_date: '2027/08/01', banks: ['C2'] }
    ];
  }).then(function (su) {
    S.specialUsers = su || [];
    S.anns = loadAnns();
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
    // 本机还没有批注数据时，尝试加载内置批注文件
    if (!Object.keys(S.anns).length) {
      fetchWithRetry('assets/annotations.json', 1, 500).then(function (a) {
        if (a && Object.keys(a).length) { S.anns = normalizeAnns(a); }
      }).catch(function () {});
    }
  });
}

document.addEventListener('DOMContentLoaded', boot);
})();
