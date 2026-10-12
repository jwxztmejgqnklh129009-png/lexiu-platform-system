var CATEGORIES = ['消防', '文旅', '公安', '健康证', '其他'];
var SCOPES = { company: '企业证照', employee: '员工证照' };
var INVENTORY_CATEGORIES = ['酒水', '耗材', '其它'];
var LEVEL_CLASS = { ok: 'b-ok', warn: 'b-warn', danger: 'b-danger', notice: 'b-notice',
                    expired: 'b-expired', unknown: 'b-gray', longterm: 'b-longterm' };
var state = {
  view: 'dashboard', certs: [], certsByScope: {}, assets: [], employees: [], inventory: [], stocktake: [], me: null,
  currentCertId: null, certRequests: {}, inventoryRequests: {}, reviewRequest: null,
  assetRequest: null, userRequest: null, drinkRequest: null, reminderKind: null, listTimers: {},
  modalPrevFocus: null, modalPrevScroll: 0
};

var VIEW_LABELS = {
  dashboard: '工作台', apps: '应用', me: '我的', company: '企业证照', employee: '员工健康证',
  assets: '固定资产', inventory: '仓库管理', review: '审核中心', drinks: '酒水单', settings: '系统设置',
  reminders: '提醒明细'
};

function $(id) { return document.getElementById(id); }
function announceRoute(view) {
  var label = VIEW_LABELS[view] || '当前页面';
  var crumb = $('crumbNow');
  var announcer = $('pageAnnouncer');
  if (crumb) crumb.textContent = label;
  if (announcer) announcer.textContent = '已进入' + label;
  document.title = '乐秀 · ' + label;
}
function focusCurrentView(view) {
  var root = $('view-' + view);
  if (!root) return;
  var target = root.querySelector('.subbar-title, h1, [data-page-title]');
  if (!target) return;
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  setTimeout(function () {
    if (!$('view-' + view) || $('view-' + view).classList.contains('hidden')) return;
    try { target.focus({ preventScroll: true }); } catch (e) { try { target.focus(); } catch (ignore) {} }
  }, 0);
}
function renderListState(container, status, message, retry) {
  if (!container) return;
  var table = container.tagName === 'TBODY';
  var text = message || (status === 'loading' ? '正在加载…' : status === 'error' ? '加载失败' : '暂无数据');
  var html;
  if (table) {
    var colspan = container.closest('table') ? container.closest('table').querySelectorAll('thead th').length : 1;
    html = '<tr><td class="empty list-state list-state-' + esc(status) + '" colspan="' + Math.max(1, colspan) + '">' +
      '<span>' + esc(text) + '</span>' +
      (status === 'error' ? ' <button type="button" class="btn list-retry">点击重试</button>' : '') +
      '</td></tr>';
  } else {
    html = '<div class="empty list-state list-state-' + esc(status) + '"><span>' + esc(text) + '</span>' +
      (status === 'error' ? ' <button type="button" class="btn list-retry">点击重试</button>' : '') + '</div>';
  }
  container.innerHTML = html;
  var button = container.querySelector('.list-retry');
  if (button && typeof retry === 'function') button.addEventListener('click', retry);
}
function debounceList(key, fn, wait) {
  clearTimeout(state.listTimers[key]);
  state.listTimers[key] = setTimeout(fn, wait || 240);
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function strictInteger(value, minimum) {
  var raw = String(value == null ? '' : value).trim();
  if (!/^\d+$/.test(raw)) return null;
  var number = Number(raw);
  return Number.isSafeInteger(number) && number >= minimum ? number : null;
}
function readInteger(id, minimum, label) {
  var number = strictInteger($(id).value, minimum);
  if (number === null) showFormError(label + (minimum ? '必须是正整数' : '必须是非负整数'), id);
  return number;
}
function selectedFile(input, boxId, kind, stateKey, inputIds) {
  if (!input || !input.files || !input.files[0]) return;
  var file = input.files[0];
  var box = $(boxId);
  var check = LexiuFiles.validate(file, kind);
  if (!check.ok) { input.value = ''; showFormError(check.error, input.id); return; }
  state[stateKey] = file;
  LexiuFiles.showSelection(box, file, { kind: kind });
  bindPreviewActions(box, input, stateKey, inputIds);
}
function bindPreviewActions(box, input, stateKey, inputIds) {
  box.onclick = function (event) {
    var button = event.target.closest('[data-file-act]');
    if (!button) return;
    if (button.dataset.fileAct === 'clear') {
      state[stateKey] = null;
      (inputIds || []).forEach(function (id) { if ($(id)) $(id).value = ''; });
      LexiuFiles.release(box);
    } else if (button.dataset.fileAct === 'reselect') {
      if (input) input.click();
    }
  };
}
function releaseFilePreviews() {
  ['nf_preview', 'f_preview', 'i_preview', 'inv_preview', 'd_preview'].forEach(function (id) {
    if ($(id)) LexiuFiles.release($(id));
  });
}
function currentForm(token, stamp) {
  return state.activeFormToken === token && $('modal')._stamp === stamp &&
    !$('modal').classList.contains('hidden');
}
function currentModal(stamp) {
  return $('modal')._stamp === stamp && !$('modal').classList.contains('hidden');
}
function prepareTwoStepForm(primaryIds) {
  var body = $('modalBody');
  if (!body || !body.children) return;
  var primary = document.createElement('section'); primary.id = 'modalStepPrimary';
  var supplement = document.createElement('section'); supplement.id = 'modalStepSupplement';
  supplement.className = 'hidden';
  var nodes = Array.prototype.slice.call(body.children);
  nodes.forEach(function (node) {
    var main = primaryIds.some(function (id) { return node.id === id || node.querySelector('#' + id); });
    (main ? primary : supplement).appendChild(node);
  });
  primary.insertAdjacentHTML('afterbegin', '<h3>主要信息</h3>');
  supplement.insertAdjacentHTML('afterbegin', '<h3>补充与确认</h3><p id="modalStepSummary" class="hint"></p>');
  body.appendChild(primary); body.appendChild(supplement);
  var back = document.createElement('button'); back.type = 'button';
  back.className = 'btn hidden'; back.textContent = '返回修改'; back.id = 'modalStepBack';
  back.onclick = function () {
    supplement.classList.add('hidden'); primary.classList.remove('hidden');
    back.classList.add('hidden'); $('modalOk').textContent = '下一步：补充信息';
    var first = primary.querySelector('input,select,textarea');
    if (first) first.focus();
  };
  $('modalExtra').appendChild(back);
  $('modalOk').textContent = '下一步：补充信息';
}
function beginFormReview(summary) {
  var primary = $('modalStepPrimary'), supplement = $('modalStepSupplement');
  if (!primary || !supplement) return true;
  $('modalStepSummary').textContent = summary;
  if (primary.classList.contains('hidden')) return true;
  primary.classList.add('hidden'); supplement.classList.remove('hidden');
  $('modalStepBack').classList.remove('hidden'); $('modalOk').textContent = '确认保存';
  $('modalStepBack').focus();
  return false;
}
/* 防重复提交：同一个写请求还在路上时，再点一次直接挡掉。
   以前只有"上传酒单页"单独做了这个，证照上传、新增表单连点两下就存两份，
   结果同一张照片在服务器上躺了好几份。现在统一在这里拦，所有提交都沾光。
   只看"地址+方法+内容"，上传用的是 FormData（里面有文件，没法比内容），
   那种按地址判重就够——同一个人连点两次上传的是同一个地址。 */
var INFLIGHT = {};

function inflightKey(url, opts) {
  var m = ((opts && opts.method) || 'GET').toUpperCase();
  var b = opts && opts.body;
  var sig = (typeof b === 'string') ? b.slice(0, 400) : '';
  return m + ' ' + url + ' ' + sig;
}

function api(url, opts) {
  var key = inflightKey(url, opts);
  var isWrite = key.charAt(0) !== 'G';        // 不是 GET 才算"写"
  if (isWrite && INFLIGHT[key]) {
    return Promise.reject(new Error('还在处理中，请不要重复点击'));
  }
  var stamp = $('modal') && !$('modal').classList.contains('hidden') ? $('modal')._stamp : null;
  if (isWrite) {
    INFLIGHT[key] = true;
    if (stamp !== null) $('modal')._writes = ($('modal')._writes || 0) + 1;
  }
  var clear = function () {
    if (!isWrite) return;
    delete INFLIGHT[key];
    if (stamp !== null && $('modal')._stamp === stamp) $('modal')._writes = Math.max(0, ($('modal')._writes || 0) - 1);
  };
  opts = Object.assign({ credentials: 'same-origin' }, opts || {});
  var controller = (typeof AbortController === 'function' && !opts.signal) ? new AbortController() : null;
  var timer = null;
  if (controller) { opts.signal = controller.signal; timer = setTimeout(function () { controller.abort(); }, 30000); }
  return fetch(url, opts).then(function (r) {
    if (r.status === 401 && url !== '/api/login') {
      // 会话失效按原安全规则重新登录，不让未保存提示阻止安全退出。
      closeModal(); clearStocktake(); location.reload(); throw new Error('登录已过期');
    }
    return r.json().catch(function () {
      return {error: r.status === 413 ? '上传内容过大，请压缩照片后重试' : '服务器返回了无法识别的结果，请刷新后重试'};
    }).then(function (d) {
      if (!r.ok) {
        var err = new Error(d.error || ('请求失败 ' + r.status));
        err.status = r.status;
        err.code = d.code;
        err.details = d.errors_detail || [];
        err.unchanged = d.unchanged || [];
        throw err;
      }
      return d;
    });
  }).then(function (d) { if (timer) clearTimeout(timer); clear(); return d; },
          function (e) {
            if (timer) clearTimeout(timer);
            clear();
            if (e && e.name === 'AbortError') e = new Error('请求超时，请检查网络后重试');
            if (stamp !== null && currentModal(stamp)) showFormError(e.message);
            throw e;
          });
}
var SAFE_HEADER = { 'X-Requested-With': 'lexiu' };
function post(url, body) {
  return api(url, { method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'lexiu' },
                    body: JSON.stringify(body || {}) });
}
function put(url, body) {
  return api(url, { method: 'PUT',
                    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'lexiu' },
                    body: JSON.stringify(body || {}) });
}
function del(url, body) {
  return api(url, { method: 'DELETE',
                    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'lexiu' },
                    body: JSON.stringify(body || {}) });
}
function toast(msg) {
  var t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
  var live = $('toastLive');
  if (live) { live.textContent = ''; live.textContent = msg; }
  clearTimeout(t._t); t._t = setTimeout(function () { t.classList.add('hidden'); },
    String(msg).length > 45 ? 6500 : 2800);
}
function badge(level, label) {
  return '<span class="badge ' + (LEVEL_CLASS[level] || 'b-gray') + '">' + esc(label) + '</span>';
}

/* 审核状态标记：没审过的、被退回的，本人和管理员要一眼看出来，
   不然提交了半天不知道东西卡在哪儿 */
function reviewBadge(status) {
  if (status === 'pending') { return ' ' + badge('notice', '待审核'); }
  if (status === 'rejected') { return ' ' + badge('danger', '已退回'); }
  return '';
}

/* ---------- 登录 ---------- */
// 「记住本机」只把账号名存在这台设备上，密码一个字都不存
var REMEMBER_KEY = 'lexiu_login_user';

function loadRememberedUser() {
  var el = $('loginUser'); if (!el) return;
  try {
    var saved = localStorage.getItem(REMEMBER_KEY);
    if (saved) {
      el.value = saved;
      var box = $('loginRemember'); if (box) box.checked = true;
    }
  } catch (e) { /* 浏览器不让存就算了，不影响登录 */ }
}

function saveRememberedUser(name) {
  var box = $('loginRemember');
  try {
    if (box && box.checked && name) localStorage.setItem(REMEMBER_KEY, name);
    else localStorage.removeItem(REMEMBER_KEY);
  } catch (e) { /* 同上 */ }
}

function bindLogin() {
  var form = $('loginForm'); if (!form) return;
  loadRememberedUser();
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var name = $('loginUser').value.trim();
    post('/api/login', { username: name, password: $('loginPass').value })
      .then(function () { saveRememberedUser(name); location.reload(); })
      .catch(function (err) { $('loginErr').textContent = err.message; });
  });
}

/* ---------- 导航 ---------- */
function go(view) {
  if (!state.userActionAllowed && hasUnsavedWork()) {
    return requestUserExit(function () { closeModal(); clearStocktake(); go(view); });
  }
  if (modalProcessing()) { toast('正在处理，请等操作完成后再离开'); return false; }
  if ($('modal') && !$('modal').classList.contains('hidden')) closeModal();
  if (view !== 'inventory' && !stocktakeDirty()) clearStocktake();
  var returningFromReminder = state.reminderReturn && state.reminderReturn.view === view;
  state.view = view;
  if (typeof window.markNav === 'function') window.markNav(view);
  ['dashboard', 'apps', 'me', 'company', 'employee', 'assets', 'inventory', 'review',
   'drinks', 'settings', 'reminders'].forEach(function (v) {
    var el = $('view-' + v); if (el) el.classList.toggle('hidden', v !== view);
  });
  announceRoute(view);
  if (!returningFromReminder) window.scrollTo(0, 0);
  focusCurrentView(view);
  // 兜底：任何一个页面元素缺失都不能中断后面的数据加载
  try { load(view); } catch (e) { toast('页面加载出错：' + e.message); }
  if (state.reminderReturn && state.reminderReturn.view === view) {
    var scroll = state.reminderReturn.scroll;
    setTimeout(function () { window.scrollTo(0, scroll); }, 0);
    state.reminderReturn = null;
  }
}
function load(view) {
  if (view === 'dashboard') return loadDashboard();
  if (view === 'apps' || view === 'me') return;
  if (view === 'company') return loadCerts('company', true);
  if (view === 'employee') return loadCerts('employee', true);
  if (view === 'assets') return loadAssets();
  if (view === 'inventory') return loadInventory(true);
  if (view === 'reminders') return loadReminders(state.reminderKind);
  if (view === 'review') return loadReviews();
  if (view === 'drinks') return loadDrinks();
  if (view === 'settings') return loadUsers();
}

/* ---------- 看板 ---------- */
function loadDashboard() {
  api('/api/dashboard').then(function (d) {
    var s = d.stats, c = d.counts || {};
    if ($('heroName')) $('heroName').textContent = (state.me && state.me.name) || '同事';
    var urgent = (s.expired || 0) + (s.warn || 0);
    var pendingCount = state.me && state.me.role === 'admin' ? (d.pending_total || 0) : 0;
    $('heroSub').textContent = urgent
      ? ('有 ' + urgent + ' 份资料要尽快处理 —— 已过期 ' + (s.expired || 0) +
         ' 份、15 天内到期 ' + (s.warn || 0) + ' 份' +
         (pendingCount ? ('；另有 ' + pendingCount + ' 项待审核') : ''))
      : '目前没有过期或 15 天内到期的资料，一切正常。' +
        (pendingCount ? ('有 ' + pendingCount + ' 项待审核。') : '');
    // 提醒只做两档：已过期、15 天内到期。另外把"长期有效/有效期待确认"单独显示，
    // 否则这类资料会从概览里消失，没人知道它们还在。
    var cards = [
      card(s.total, '在管资料总数'),
      card(s.expired, '已过期', 'expired'),
      card(s.warn, '15 天内到期', 'warn')
    ];
    if (s.longterm) cards.push(card(s.longterm, '长期有效', 'longterm'));
    if (s.unknown) cards.push(card(s.unknown, '有效期待确认', 'unknown'));
    cards.push(card(s.ok, '正常有效', 'ok'));
    $('cards').innerHTML = cards.join('');
    setText('cnt-company', c.company);
    setText('cnt-employee', c.employee);
    setText('cnt-assets', c.assets);
    setText('cnt-drinks', c.drinks);
    setText('cnt-users', c.users);
    setText('cnt-inventory', c.inventory);
    var wh = d.warehouse || { items: [] };
    setText('reminder-cert-expired', s.expired || 0);
    setText('reminder-cert-warn', s.warn || 0);
    setText('reminder-inventory-expired', wh.expired || 0);
    setText('reminder-inventory-warn', wh.warn || 0);
    setText('reminder-inventory-low', wh.low_stock || 0);
    var certEmpty = $('reminder-cert-empty');
    var inventoryEmpty = $('reminder-inventory-empty');
    if (certEmpty) certEmpty.hidden = !!(s.expired || s.warn);
    if (inventoryEmpty) inventoryEmpty.hidden = !!((wh.expired || 0) + (wh.warn || 0) + (wh.low_stock || 0));
    // 顺带把"等你审核"的几件摆到工作台上
    loadReviewSummary();
  }).catch(function (e) { toast(e.message); });
}
function setText(id, val) {
  var el = $(id);
  if (el) el.textContent = (val === null || val === undefined || val === '') ? '—' : val;
}
function openReminderCertificates() {
  state.reminderKind = 'certificates';
  go('reminders');
}
function openReminderInventory() {
  state.reminderKind = 'inventory';
  go('reminders');
}
function openReminderCert(id, scope) {
  go(scope === 'employee' ? 'employee' : 'company');
  openCert(id);
}
function openReminderItem(id) {
  go('inventory');
  openInv(id);
}

function loadReminders(kind) {
  var box = $('reminderDetailList');
  var title = $('reminderTitle');
  var hint = $('reminderHint');
  var allBtn = $('reminderAllBtn');
  if (!box) return;
  if (kind === 'inventory') {
    if (title) title.textContent = '库存预警';
    if (hint) hint.textContent = '只显示过期、15 天内到期或库存不足的物品。';
    if (allBtn) allBtn.onclick = function () { go('inventory'); };
    renderListState(box, 'loading', '正在加载库存预警…');
    api('/api/inventory').then(function (rows) {
      var alerts = (rows || []).filter(function (it) {
        return it.expiry && (it.expiry.level === 'expired' || it.expiry.level === 'warn' ||
          (it.safety_stock > 0 && it.quantity < it.safety_stock));
      });
      if (!alerts.length) {
        box.innerHTML = '<div class="empty">当前没有库存预警</div>';
        return;
      }
      box.innerHTML = '<table><thead><tr><th>物品</th><th>分类</th><th>当前库存</th><th>提醒</th><th>操作</th></tr></thead><tbody>' +
        alerts.map(function (it) {
          var tags = [];
          if (it.expiry && (it.expiry.level === 'expired' || it.expiry.level === 'warn'))
            tags.push(badge(it.expiry.level, it.expiry.label));
          if (it.safety_stock > 0 && it.quantity < it.safety_stock) tags.push(badge('danger', '库存不足'));
          return '<tr><td data-label="物品">' + esc(it.name) + '</td>' +
            '<td data-label="分类">' + esc(it.category) + '</td>' +
            '<td data-label="当前库存"><b>' + esc(it.quantity) + '</b> ' + esc(it.unit) + '</td>' +
            '<td data-label="提醒">' + tags.join(' ') + '</td>' +
            '<td data-label="操作"><button class="btn" type="button" onclick="openReminderItem(' + Number(it.id) + ')">查看详情</button></td></tr>';
        }).join('') + '</tbody></table>';
    }).catch(function (e) {
      renderListState(box, 'error', e.message || '库存预警加载失败', function () { loadReminders('inventory'); });
      toast(e.message);
    });
    return;
  }
  if (title) title.textContent = '证照到期提醒';
  if (hint) hint.textContent = '只显示已过期和 15 天内到期的企业证照、员工健康证。';
  if (allBtn) allBtn.onclick = function () { go('company'); };
  renderListState(box, 'loading', '正在加载证照提醒…');
  api('/api/certificates').then(function (rows) {
    var alerts = (rows || []).filter(function (c) {
      return c.expiry && (c.expiry.level === 'expired' || c.expiry.level === 'warn');
    }).sort(function (a, b) {
      return (a.expiry.days == null ? 999999 : a.expiry.days) - (b.expiry.days == null ? 999999 : b.expiry.days);
    });
    state.certs = rows || [];
    if (!alerts.length) {
      box.innerHTML = '<div class="empty">当前没有证照到期提醒</div>';
      return;
    }
    box.innerHTML = '<table><thead><tr><th>资料</th><th>所属模块</th><th>持证人</th><th>到期日</th><th>状态</th><th>操作</th></tr></thead><tbody>' +
      alerts.map(function (c) {
        return '<tr><td data-label="资料">' + esc(c.name) + '</td>' +
          '<td data-label="所属模块">' + esc(SCOPES[c.scope] || '') + '</td>' +
          '<td data-label="持证人">' + esc(c.holder || '-') + '</td>' +
          '<td data-label="到期日">' + esc(c.expiry_date || '-') + '</td>' +
          '<td data-label="状态">' + badge(c.expiry.level, c.expiry.label) + '</td>' +
          '<td data-label="操作"><button class="btn" type="button" onclick="openReminderCert(' + Number(c.id) + ',\'' + (c.scope === 'employee' ? 'employee' : 'company') + '\')">查看详情</button></td></tr>';
      }).join('') + '</tbody></table>';
  }).catch(function (e) {
    renderListState(box, 'error', e.message || '证照提醒加载失败', function () { loadReminders('certificates'); });
    toast(e.message);
  });
}

function card(num, cap, level) {
  return '<div class="card' + (level ? ' k-' + level : '') + '">' +
    '<div class="num">' + esc(num) + '</div>' +
    '<div class="cap">' + esc(cap) + '</div></div>';
}

/* ---------- 证照 / 健康证 ---------- */
function daysText(e) {
  if (e.level === 'longterm') return '长期有效';
  if (e.level === 'unknown') return '有效期待确认';
  if (e.days === null) return '-';
  return e.days < 0 ? ('已过期 ' + (-e.days) + ' 天') : ('还剩 ' + e.days + ' 天');
}

function loadCerts(scope, immediate) {
  if (!immediate) {
    debounceList('cert:' + scope, function () { loadCerts(scope, true); });
    return;
  }
  var q = ($('q-' + scope) || {}).value || '';
  // 员工名下的资料在这一页一概显示，不再只挑「健康证」这一类：
  // 表单本来就允许给员工存别的分类，以前存完两页都找不到，
  // 用户以为没保存住，就会再录一遍（审计 10/03 S-01，北於定：员工页显示全部）。
  var url = '/api/certificates?scope=' + scope + '&q=' + encodeURIComponent(q);
  var requestToken = {};
  state.certRequests[scope] = requestToken;
  var box = $('list-' + scope);
  renderListState(box, 'loading', '正在加载…');
  api(url).then(function (rows) {
    if (state.certRequests[scope] !== requestToken ||
        (scope === 'company' && state.view !== 'company') ||
        (scope === 'employee' && state.view !== 'employee')) return;
    state.certsByScope[scope] = rows;
    state.certs = rows;
    box.innerHTML = rows.length ? rows.map(function (c) {
      var v = c.current_version || {};
      var photo = v.thumb_url
        ? '<img src="' + esc(v.thumb_url) + '" loading="lazy" alt="' + esc(c.name) + '">'
        : (v.original_name ? '<div class="file-cover"><span>' + esc(LexiuFiles.fileType(v.original_name)) + '</span></div>'
          : '<div class="no-photo">未上传</div>');
      var canDel = state.me && state.me.role === 'admin';
      return '<div class="cert-card">' +
        '<div class="cert-media" tabindex="0" role="button" aria-label="打开' + esc(c.name) + '图片" onclick="viewPhoto(' + c.id + ')" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();viewPhoto(' + c.id + ')}">' +
          '<span class="cert-tag">' + esc(c.expiry.label) + '</span>' + photo +
        '</div>' +
        '<div class="cert-info" tabindex="0" role="button" aria-label="打开' + esc(c.name) + '详情" onclick="openCert(' + c.id + ')" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();openCert(' + c.id + ')}">' +
          '<div class="cert-name">' + esc(c.name) + reviewBadge(c.flow_status) + '</div>' +
          '<div class="cert-days d-' + c.expiry.level + '">' + esc(daysText(c.expiry)) + '</div>' +
          '<div class="cert-sub">' + esc(c.category) + ' · ' + esc(c.expiry_date || '无固定到期日') + '</div>' +
          // 删除放在卡片右下角：不用点进详情翻半天。点它不会连带打开详情（stopPropagation），
          // 后端管理员权限和记录存在性检查仍是最终门槛。
          (canDel ? '<div class="cert-foot">' +
            '<button class="btn danger cert-del" onclick="event.stopPropagation();cardDeleteCert(' + c.id + ')">删除</button>' +
          '</div>' : '') +
        '</div></div>';
    }).join('') : '<div class="empty">' + (scope === 'employee' ? '还没有健康证记录，点右上角「新增健康证」开始' : '还没有资料，点右上角「新增」开始') + '</div>';
  }).catch(function (e) {
    if (state.certRequests[scope] !== requestToken) return;
    renderListState(box, 'error', e.message || '证照列表加载失败', function () { loadCerts(scope, true); });
    toast(e.message);
  });
}

/* ---------- 审核中心 ---------- */
/* 员工交上来的东西都汇总到这一个类里处理：新建的资料、新传的附件、新录的仓库物品。
   以前得挨个模块翻，漏一个就一直压在那儿谁也不知道。 */
var REVIEW_KIND = { cert: '新建资料', cert_edit: '资料修改', version: '上传附件', item: '仓库物品',
                    item_image: '仓库图片', asset: '固定资产', fire_photo: '消防照片', fire_order: '消防页序' };

function editChanges(changes, checkConflict) {
  var conflict = false;
  var rows = (changes || []).map(function (change) {
    var changed = change.current !== change.before;
    if (changed) conflict = true;
    function value(v) {
      var labels = change.field === 'scope' ? SCOPES : (change.field === 'expiry_mode'
        ? { date: '有明确到期日', longterm: '长期有效', unknown: '暂不确定' } : null);
      if (labels && Object.prototype.hasOwnProperty.call(labels, v)) v = labels[v];
      return esc(v == null || v === '' ? '—' : v);
    }
    return '<div class="cert-edit-field"><b>' + esc(change.label || change.field) + '</b>' +
      '<div class="cert-edit-values">' +
        '<div><span>提交时原值</span><p>' + value(change.before) + '</p></div>' +
        '<div' + (changed ? ' class="cert-edit-changed"' : '') + '><span>当前值</span><p>' + value(change.current) + '</p></div>' +
        '<div><span>申请值</span><p>' + value(change.after) + '</p></div>' +
      '</div></div>';
  }).join('');
  return '<div class="cert-edit-diff">' +
    (conflict && checkConflict ? '<p class="cert-edit-warning">当前值已变化，请核对；有冲突的申请需退回后重新提交。</p>' : '') +
    rows + '</div>';
}

function editRequestHistory(c) {
  var requests = c.edit_requests || [];
  if (!requests.length) return '';
  var admin = state.me && state.me.role === 'admin';
  return '<section class="cert-edit-history"><h3>修改申请' + (admin ? '' : '（我的申请）') + '</h3>' +
    '<p class="hint">等待审核时，原内容与到期提醒继续有效。</p>' +
    requests.map(function (r) {
      var status = r.status === 'approved' ? badge('ok', '已通过') : reviewBadge(r.status);
      return '<div class="cert-edit-request"><div class="cert-edit-heading"><b>申请 #' + esc(r.id) + '</b>' + status + '</div>' +
        '<p class="cert-sub">' + esc(r.by || '未知') + ' · ' + esc((r.at || '').slice(0, 16)) + '</p>' +
        (r.reviewed_at ? '<p class="cert-sub">审核：' + esc(r.reviewed_by || '管理员') + ' · ' + esc(r.reviewed_at.slice(0, 16)) + '</p>' : '') +
        (r.reject_reason ? '<p class="cert-edit-warning">退回原因：' + esc(r.reject_reason) + '</p>' : '') +
        editChanges(r.changes, r.status === 'pending') +
        (admin && r.status === 'pending' ? '<div class="row-actions">' +
          '<button class="btn primary" onclick="reviewOne(\'cert_edit\', ' + r.id + ', \'approve\', ' + c.id + ')">通过</button>' +
          '<button class="btn danger" onclick="reviewOne(\'cert_edit\', ' + r.id + ', \'reject\', ' + c.id + ')">退回</button></div>' : '') +
        '</div>';
    }).join('') + '</section>';
}

function reviewFile(r) {
  if (r.kind === 'cert_edit') return editChanges(r.changes, true);
  if (r.kind === 'fire_order') return '<div class="review-file"><p>提交时原序：' + esc((r.base_photo_ids || []).join(' → ')) +
    '</p><p>申请顺序：' + esc((r.photo_ids || []).join(' → ')) + '</p>' +
    (r.conflict ? '<p class="cert-edit-warning">当前照片或页序已变化，请刷新核对；不能覆盖后续操作。</p>' : '') + '</div>';
  if (r.kind === 'fire_photo') return '<div class="review-file"><span>' +
    (r.replaces_photo_id ? '更换原照片 #' + esc(r.replaces_photo_id) + '（审核前保留原图）' : '新增照片（审核后按已确认批次页序生效）') + '</span>' +
    LexiuFiles.renderSaved({ original_name: r.original_name, file_size: r.file_size,
      web_url: r.url, thumb_url: r.thumb_url }, { imageOnly: true }) + '</div>';
  if (r.kind !== 'version' && r.kind !== 'item_image') return '';
  var name = r.original_name || String(r.sub || '').split(' · ').pop();
  var isImage = /\.(jpe?g|png)$/i.test(name);
  return '<div class="review-file"><span>第 ' + esc(r.version_no || '?') + ' 版</span>' +
    LexiuFiles.renderSaved({ original_name: name, file_size: r.file_size,
      web_url: isImage ? r.url : null, thumb_url: r.thumb_url,
      raw_url: !isImage && r.kind === 'version' ? r.url : null }, { imageOnly: isImage }) + '</div>';
}

function reviewCard(r) {
  return '<div class="cert-card">' +
    '<div class="cert-info">' +
      '<div class="cert-name">' + esc(r.title) + '</div>' +
      '<div class="cert-sub">' + esc(REVIEW_KIND[r.kind] || r.kind) + ' · ' + esc(r.sub) + '</div>' +
      '<div class="cert-sub">' + esc(r.by || '未知') + ' · ' + esc((r.at || '').slice(0, 16)) + '</div>' +
      reviewFile(r) +
      '<div class="row-actions" style="margin-top:8px">' +
        (r.kind === 'cert_edit' ? '<button class="btn" onclick="openCert(' + r.parent_id + ')">查看资料</button>' : '') +
        '<button class="btn primary" onclick="reviewOne(\'' + r.kind + '\', ' + r.id + ', \'approve\')">通过</button>' +
        '<button class="btn danger" onclick="reviewOne(\'' + r.kind + '\', ' + r.id + ', \'reject\')">退回</button>' +
      '</div>' +
    '</div></div>';
}

function loadReviews() {
  var box = $('reviewList');
  var requestToken = {};
  state.reviewRequest = requestToken;
  renderListState(box, 'loading', '正在加载…');
  api('/api/reviews').then(function (d) {
    if (state.reviewRequest !== requestToken || state.view !== 'review') return;
    var items = d.items || [];
    box.innerHTML = items.length ? items.map(function (r) {
      return '<tr>' +
        '<td data-label="类别">' + esc(REVIEW_KIND[r.kind] || r.kind) + '</td>' +
        '<td data-label="名称">' + esc(r.title) +
          '<div class="cert-sub">' + esc(r.sub) + '</div>' + reviewFile(r) + '</td>' +
        '<td data-label="提交人">' + esc(r.by || '-') + '</td>' +
        '<td data-label="时间">' + esc((r.at || '').slice(0, 16)) + '</td>' +
        '<td data-label="操作"><div class="row-actions">' +
          (r.kind === 'cert_edit' ? '<button class="btn" onclick="openCert(' + r.parent_id + ')">查看资料</button>' : '') +
          '<button class="btn primary" onclick="reviewOne(\'' + r.kind + '\', ' + r.id + ', \'approve\')">通过</button>' +
          '<button class="btn danger" onclick="reviewOne(\'' + r.kind + '\', ' + r.id + ', \'reject\')">退回</button>' +
        '</div></td></tr>';
    }).join('') : '<tr><td class="empty">没有待审核的内容，都处理完了</td></tr>';
  }).catch(function (e) {
    if (state.reviewRequest !== requestToken) return;
    renderListState(box, 'error', e.message || '审核列表加载失败', loadReviews);
    toast(e.message);
  });
}

function reviewOne(kind, id, action, certId) {
  if (action === 'reject') {
    openModal('退回审核',
      '<div class="field"><label>退回原因 *</label>' +
      '<textarea id="review_reason" maxlength="200" placeholder="提交的人会看到这句话"></textarea></div>',
      function () {
        var reason = $('review_reason').value.trim();
        if (!reason) { showFormError('请填写退回原因', 'review_reason'); return false; }
        if (reason.length > 200) { showFormError('退回原因不能超过 200 字', 'review_reason'); return false; }
        var stamp = $('modal')._stamp;
        return post('/api/reviews/' + kind + '/' + id, { action: 'reject', reason: reason })
          .then(function () {
            var active = currentModal(stamp);
            if (active) closeModal();
            toast('已退回');
            if (state.view === 'review') loadReviews(); else load(state.view);
            loadReviewSummary();
            if (kind === 'cert_edit' && certId && active) openCert(certId);
          })
          .catch(function (e) { reviewError(e, stamp, kind); });
      }, null, '确认退回');
    return;
  }
  var stamp = $('modal')._stamp;
  return post('/api/reviews/' + kind + '/' + id, { action: action })
    .then(function () {
      toast(kind === 'cert_edit' ? '修改申请已通过，修改已生效' : (action === 'approve' ? '已通过，大家都看得到了' : '已退回'));
      if (state.view === 'review') { loadReviews(); } else { load(state.view); }
      loadReviewSummary();
      if (kind === 'cert_edit' && certId && currentModal(stamp) && state.currentCertId === certId) {
        closeModal(); openCert(certId);
      }
    })
    .catch(function (e) { reviewError(e, stamp, kind); });
}
function reviewError(error, stamp, kind) {
  if (error.status === 409 || error.status === 404) {
    if (currentModal(stamp)) closeModal();
    if (state.view === 'review') loadReviews(); else load(state.view);
    loadReviewSummary();
    toast((error.status === 409 ? '审核冲突：' : '') + error.message +
      (kind === 'cert_edit' ? '；请核对申请状态，必要时退回后重新提交。' : '；待审列表已刷新，请重新核对。'));
    return;
  }
  showFormError(error.message);
}

/* 工作台上的"审核中心"：只有确实有待审内容时才作为提醒显示 */
function loadReviewSummary() {
  if (!state.me || state.me.role !== 'admin') { return; }
  return api('/api/reviews').then(function (d) {
    var items = d.items || [];
    var box = $('reviewBox');
    var dot = $('navReviewDot');
    if (dot) { dot.hidden = !items.length; }
    if (!box) { return; }
    box.hidden = !items.length;
    if ($('reviewSum')) {
      $('reviewSum').textContent = items.length
        ? ('共 ' + items.length + ' 项等你确认')
        : '';
    }
    $('reviewBoxList').innerHTML = items.length
      ? items.slice(0, 6).map(reviewCard).join('')
      : '';
  }).catch(function () { });
}

function viewPhoto(certId) {
  var c = null;
  state.certs.forEach(function (x) { if (x.id === certId) c = x; });
  var v = (c && c.current_version) || {};
  if (!v.web_url) {
    if (v.original_name && v.raw_url) { openCert(certId); return; }
    // 被退回的图后端不会再给预览地址（避免点开是打不开的图），提示要说清原因
    toast(v.status === 'rejected' ? '这张图被退回了，重新上传后才能查看' : '这份资料还没上传图片');
    return;
  }
  openModal(c.name,
    '<div class="a4box"><img src="' + esc(v.web_url) + '" alt=""></div>' +
    '<p class="hint" style="margin-top:10px">' +
    '按 A4 比例完整显示，未裁剪。' +
    (v.raw_url ? '<a href="' + esc(v.raw_url) + '">下载原图（未压缩）</a>' : '') + '</p>',
    null);
}

function pickFile(which) {
  var el = $(which === 'camera' ? 'f_cam' : 'f_pick');
  if (el) el.click();
}

function showCertForm(cert) {
  var isNew = !cert;
  var pendingEdit = !isNew && (!state.me || state.me.role !== 'admin');
  var formToken = {};
  state.formFile = null;
  cert = cert || { scope: state.view === 'employee' ? 'employee' : 'company', category: '其他',
                   expiry_mode: 'date', remind_days: 15 };
  openModal(isNew ? '新增资料' : (pendingEdit ? '提交资料修改审核' : '编辑资料'),
    (pendingEdit ? '<p id="cert_edit_tip" class="hint">提交修改审核后，等待管理员审核；审核通过前原内容与到期提醒继续有效。附件单独按原流程审核。</p>' : '') +
    '<div class="field"><label>归属</label><select id="f_scope">' +
      '<option value="company"' + (cert.scope === 'company' ? ' selected' : '') + '>企业证照</option>' +
      '<option value="employee"' + (cert.scope === 'employee' ? ' selected' : '') + '>员工证照</option></select></div>' +
    '<div class="field"><label>分类</label><select id="f_category">' +
      CATEGORIES.map(function (c) { return '<option' + (cert.category === c ? ' selected' : '') + '>' + c + '</option>'; }).join('') +
      '</select></div>' +
    '<div class="field"><label>资料名称 *</label><input id="f_name" value="' + esc(cert.name || '') + '"></div>' +
    '<div class="field"><label>编号</label><input id="f_no" value="' + esc(cert.cert_no || '') + '"></div>' +
    '<div class="field"><label>发证/出具单位</label><input id="f_issuer" value="' + esc(cert.issuer || '') + '"></div>' +
    '<div class="field"><label>持证人 / 持证主体</label><input id="f_holder" value="' + esc(cert.holder || '') + '"></div>' +
    '<div class="field"><label>保管人 / 责任部门</label><input id="f_keeper" value="' + esc(cert.keeper || '') + '"></div>' +
    '<div class="field"><label>有效期方式</label><select id="f_mode">' +
      '<option value="date"' + (cert.expiry_mode === 'date' ? ' selected' : '') + '>有明确到期日</option>' +
      '<option value="longterm"' + (cert.expiry_mode === 'longterm' ? ' selected' : '') + '>长期有效</option>' +
      '<option value="unknown"' + (cert.expiry_mode === 'unknown' ? ' selected' : '') + '>暂不确定</option></select></div>' +
    '<div class="field"><label>到期日期</label><input type="date" id="f_expiry" value="' + esc(cert.expiry_date || '') + '"></div>' +
    '<div class="field"><label>纸质原件存放位置</label><input id="f_paper" value="' + esc(cert.paper_location || '') + '"></div>' +
    '<div class="field file-picker"><label>证照照片 / 扫描件（可在这里直接传，也可以后再补）</label>' +
      '<div class="row-actions">' +
        '<button class="btn" onclick="pickFormFile(\'camera\')">拍照上传</button>' +
        '<button class="btn" onclick="pickFormFile(\'file\')">从手机 / 电脑选文件</button>' +
      '</div>' +
      '<input type="file" id="nf_cam" accept="image/*" capture="environment" class="hidden" onchange="onFormFile(this)">' +
      '<input type="file" id="nf_pick" accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx" class="hidden" onchange="onFormFile(this)">' +
      '<div id="nf_preview" style="margin-top:8px"></div>' +
    '</div>' +
    '<div class="field"><label>换版说明（可选）</label><input id="f_change" placeholder="例如：换证后新证"></div>' +
    '<div class="field"><label>备注</label><textarea id="f_note">' + esc(cert.note || '') + '</textarea></div>',
    function () {
      var body = {
        scope: $('f_scope').value, category: $('f_category').value,
        name: $('f_name').value.trim(), cert_no: $('f_no').value, issuer: $('f_issuer').value,
        holder: $('f_holder').value, keeper: $('f_keeper').value,
        expiry_mode: $('f_mode').value, expiry_date: $('f_expiry').value,
        paper_location: $('f_paper').value, note: $('f_note').value
      };
      if (!body.name) { showFormError('请填写资料名称', 'f_name'); return false; }
      if (body.expiry_mode === 'date' && !body.expiry_date) { showFormError('请填写到期日期', 'f_expiry'); return false; }
      if (!beginFormReview('资料：' + body.name + '；归属：' + (SCOPES[body.scope] || body.scope))) {
        if (pendingEdit) $('modalOk').textContent = '提交修改审核';
        return false;
      }
      var file = state.formFile;
      var note = $('f_change').value || '';
      var stamp = $('modal')._stamp;
      var req = isNew ? post('/api/certificates', body) : put('/api/certificates/' + cert.id, body);
      // 分两步的事（先存资料、再传附件）必须分清楚是哪一步成的。
      // 以前只要图片那一步报错，页面就笼统地提示失败，弹窗按「新建」留着，
      // 用户再点一次就多出一份一模一样的资料（审计 10/03 S-02）。
      return req.then(function (r) {
        var cid = isNew ? r.id : cert.id;
        var result = { id: cid, err: '', pending: r.pending, unchanged: r.unchanged };
        if (!file) return result;
        return uploadFileTo(cid, file, note).then(function (up) {
          result.filePending = !up.auto_approved;
          return result;
        }).catch(function (up) {
          result.err = up.message || '文件没传成功';
          return result;
        });
      }).then(function (res) {
        var message = isNew ? '资料已保存' : (res.pending
          ? '修改申请已提交，等待管理员审核；原内容与到期提醒继续有效'
          : (res.unchanged ? '资料没有修改，未新增修改申请' : '修改已保存并生效'));
        if (file && !res.err) message += res.filePending ? '；附件等待管理员审核' : '；附件已生效';
        if (!currentForm(formToken, stamp)) {
          toast('此前' + message + (res.err ? '；附件未成功（' + res.err + '），请到该资料重传' : ''));
          return;
        }
        if (res.err) state.pendingRetryFile = { id: res.id, file: file, note: note, message: message + '；附件未成功（' + res.err + '），请在这里重试附件上传。' };
        if (!res.err) {
          closeModal(); toast(message); load(state.view); loadReviewSummary();
          if (!isNew && res.pending) openCert(res.id);
          return;
        }
        // 资料已经落库了：直接把这份资料打开，让他在里头重传附件
        closeModal(); load(state.view);
        toast(message + '；附件没传成功（' + res.err + '）。已经打开这份资料，请在这里重传附件。');
        openCert(res.id);
      }).catch(function (e) { toast(e.message); });
    }, null, '下一步：确认');
  state.activeFormToken = formToken;
  prepareTwoStepForm(['cert_edit_tip', 'f_scope', 'f_category', 'f_name', 'f_mode', 'f_expiry']);
}

function pickFormFile(which) {
  var el = $(which === 'camera' ? 'nf_cam' : 'nf_pick');
  if (el) el.click();
}

function onFormFile(input) {
  selectedFile(input, 'nf_preview', $('h_name') ? 'health' : 'certificate', 'formFile', ['nf_cam', 'nf_pick']);
}

function clearFormFile() {
  state.formFile = null;
  var c = $('nf_cam'), p = $('nf_pick'), b = $('nf_preview');
  if (c) c.value = '';
  if (p) p.value = '';
  if (b) LexiuFiles.release(b);
}

function uploadFileTo(certId, file, note) {
  var fd = new FormData();
  fd.append('file', file);
  fd.append('change_note', note || '');
  // 走 api() 而不是直接 fetch：api() 里带了"同一个请求还在路上就挡掉"的保护，
  // 传图要几秒钟，不加这个，看着没反应再点一次就变成传两遍。
  return api('/api/certificates/' + certId + '/versions',
             { method: 'POST', headers: SAFE_HEADER, body: fd });
}

function showHealthForm() {
  var formToken = {};
  state.formFile = null;
  openModal('新增健康证',
    '<div class="field"><label>姓名 *</label><input id="h_name" placeholder="员工姓名"></div>' +
    '<div class="field"><label>健康证到期日期 *</label><input type="date" id="h_expiry"></div>' +
    '<div class="field"><label>证照编号（可选）</label><input id="h_no"></div>' +
    '<div class="field"><label>发证单位（可选）</label><input id="h_issuer" placeholder="例如：区疾控中心 / 卫健委"></div>' +
    '<div class="field file-picker"><label>健康证照片（可拍照，也可以之后再补）</label>' +
      '<div class="row-actions">' +
        '<button class="btn" onclick="pickFormFile(\'camera\')">拍照上传</button>' +
        '<button class="btn" onclick="pickFormFile(\'file\')">从手机 / 电脑选文件</button>' +
      '</div>' +
      '<input type="file" id="nf_cam" accept="image/*" capture="environment" class="hidden" onchange="onFormFile(this)">' +
      '<input type="file" id="nf_pick" accept="image/*,application/pdf" class="hidden" onchange="onFormFile(this)">' +
      '<div id="nf_preview" style="margin-top:8px"></div>' +
    '</div>',
    function () {
      var name = $('h_name').value.trim();
      if (!name) { showFormError('请填写姓名', 'h_name'); return false; }
      var expiry = $('h_expiry').value;
      if (!expiry) { showFormError('请填写到期日期', 'h_expiry'); return false; }
      var body = {
        name: name, expiry_date: expiry,
        cert_no: $('h_no').value, issuer: $('h_issuer').value
      };
      if (!beginFormReview('健康证：' + name + '；到期：' + expiry)) return false;
      var file = state.formFile;
      var stamp = $('modal')._stamp;
      // 把请求返回出去（而不是 return false），弹窗才知道"正在提交"，
      // 会把确定按钮锁住显示"处理中…"。不然网络慢的时候看着没动静，就会再点一次。
      return post('/api/health-certs', body).then(function (r) {
        // 同上：健康证也是「先存人、后传图」两步。以前图传失败时页面只说失败，
        // 关掉弹窗再新增一次，同一个员工就有了两条同名健康证（审计 10/03 S-02）。
        if (!file) return { id: r.id, err: '' };
        return uploadFileTo(r.id, file, '').then(function () {
          return { id: r.id, err: '' };
        }).catch(function (up) {
          return { id: r.id, err: up.message || '照片没传成功' };
        });
      }).then(function (res) {
        if (!currentForm(formToken, stamp)) {
          toast(res.err ? '此前健康证已保存，但附件未成功（' + res.err + '），请到该资料重传' : '此前健康证已保存');
          return;
        }
        if (res.err) state.pendingRetryFile = { id: res.id, file: file, message: '健康证已保存；附件未成功（' + res.err + '），请在这里重试附件上传。' };
        if (!res.err) { closeModal(); toast('健康证已添加'); load(state.view); return; }
        closeModal(); load(state.view);
        toast('健康证已经记下了，照片没传成功（' + res.err + '）。已经打开这份资料，在这里重传就行，千万不要再新增一次。');
        openCert(res.id);
      }).catch(function (e) { toast(e.message); });
    }, null, '下一步：确认');
  state.activeFormToken = formToken;
  prepareTwoStepForm(['h_name', 'h_expiry']);
}

function openCert(id) {
  var requestToken = {};
  state.detailRequestToken = requestToken;
  var stamp = $('modal')._stamp;
  api('/api/certificates/' + id).then(function (c) {
    if (state.detailRequestToken !== requestToken || $('modal')._stamp !== stamp) return;
    if (!acceptModalResponse(function () { openCert(id); })) return;
    state.currentCertId = id;
    state.currentCert = c;
    var versions = (c.versions || []).map(function (v) {
      // 链接只给「服务器说能打开」的版本。以前这里无条件拼一个 /files/ 链接，
      // 页面另一处却又写着「这张图不能看」，点下去必定 404（审计 10/03 S-06）。
      // 现在后端已经把 raw_url 算好了（打不开的是 null），这里照着它渲染。
      var fileCell = LexiuFiles.renderSaved(v);
      return '<tr><td data-label="版本">v' + v.version_no + '</td>' +
        '<td data-label="文件">' + fileCell + '</td>' +
        '<td data-label="上传人">' + esc(v.uploaded_by || '-') + '</td>' +
        '<td data-label="时间">' + esc((v.uploaded_at || '').slice(0, 16)) + '</td>' +
        '<td data-label="状态">' + vStatus(v) + '</td>' +
        '<td data-label="操作">' + (v.status === 'pending' && state.me.role === 'admin'
          ? '<div class="row-actions"><button class="btn" onclick="review(' + v.id + ',\'approve\')">通过</button>' +
            '<button class="btn danger" onclick="review(' + v.id + ',\'reject\')">退回</button></div>' : '') +
        '</td></tr>';
    }).join('') || '<tr><td class="empty">还没有上传附件</td></tr>';

    var cur = c.current_version || {};
    var bigPhoto = LexiuFiles.renderSaved(cur);

    openModal('资料详情',
      certActionBar(c) +
      bigPhoto +
      '<div class="field" style="margin-top:12px"><b>' + esc(c.name) + '</b>　' +
        badge(c.expiry.level, c.expiry.label) + '　<span class="cert-days d-' + c.expiry.level + '" style="font-size:16px">'
        + esc(daysText(c.expiry)) + '</span></div>' +
      '<div class="field">分类：' + esc(c.category) + '　编号：' + esc(c.cert_no || '-') + '</div>' +
      '<div class="field">持证：' + esc(c.holder || '-') + '　保管：' + esc(c.keeper || '-') + '</div>' +
      '<div class="field">到期：' + esc(c.expiry_date || '-') + '　纸质位置：' + esc(c.paper_location || '-') + '</div>' +
      '<div class="field">备注：' + esc(c.note || '-') + '</div>' +
      editRequestHistory(c) +
      '<hr style="border:none;border-top:1px solid #E2D9C8;margin:14px 0">' +
      '<h3 style="font-size:14px;margin-bottom:8px">上传新版本（' +
        (state.me && state.me.role === 'admin' ? '管理员上传后直接生效' : '提交后待管理员审核') + '）</h3>' +
      '<div class="field file-picker row-actions">' +
        '<button class="btn" onclick="pickFile(\'camera\')">拍照上传</button>' +
        '<button class="btn" onclick="pickFile(\'file\')">从手机 / 电脑选文件</button>' +
      '</div>' +
      '<input type="file" id="f_cam" accept="image/*" capture="environment" class="hidden"' +
        ' onchange="onVersionFile(this)">' +
      '<input type="file" id="f_pick" accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx" class="hidden"' +
        ' onchange="onVersionFile(this)">' +
      '<div id="f_preview"></div>' +
      '<div class="field"><label>换版说明</label><input id="f_change" placeholder="例如：换证后新证"></div>' +
      '<hr style="border:none;border-top:1px solid #E2D9C8;margin:14px 0">' +
      '<h3 style="font-size:14px;margin-bottom:8px">历史版本</h3>' +
      '<table>' + versions + '</table>',
      function () { return uploadVersion(c.id); }, null, '上传新版本');
    var retry = state.pendingRetryFile;
    state.versionFile = retry && retry.id === id ? retry.file : null;
    if (state.versionFile) state.pendingRetryFile = null;
    if (state.versionFile) {
      LexiuFiles.showSelection($('f_preview'), state.versionFile, { kind: 'certificate' });
      bindPreviewActions($('f_preview'), $('f_pick'), 'versionFile', ['f_cam', 'f_pick']);
      if (retry.note) $('f_change').value = retry.note;
      showFormError(retry.message || '资料已保存，附件未成功，请重试附件上传。');
    }
  });
}

/* 详情页顶部的操作栏：编辑人人可用，删除只有管理员能看见。
   放在顶部是因为手机上这个弹窗很长（大图 + 上传区 + 历史版本），
   按钮放底部要滚很久才看得到，容易被当成"没有删除功能"。
   不做"停用"：不用了的资料直接删除，不留半死不活的隐藏记录。 */
function certActionBar(c) {
  var h = '<div class="row-actions" style="margin-bottom:12px">' +
    '<button class="btn" onclick="certEdit()">' +
      (state.me && state.me.role === 'admin' ? '编辑' : '编辑并提交审核') + '</button>';
  if (state.me && state.me.role === 'admin') {
    h += '<button class="btn danger" onclick="certDelete()">删除</button>';
  }
  return h + '</div>';
}
function certEdit() {
  var c = state.currentCert;
  closeModal();
  showCertForm(c);
}
function certDelete() {
  var c = state.currentCert;
  if (!c) return;
  askDeleteCert(c);
}

/* 卡片右下角那个删除按钮走的入口。
   列表里没带附件明细，先问一次详情，才能告诉他要一起删掉几个文件。 */
function cardDeleteCert(id) {
  var c = null;
  (state.certs || []).forEach(function (x) { if (x.id === id) c = x; });
  if (!c) return;
  if (c.versions) { askDeleteCert(c); return; }
  api('/api/certificates/' + id).then(function (full) { askDeleteCert(full); })
    .catch(function (e) { toast(e.message); });
}

/* 删除资料保留二次确认，管理员无需手输名称。 */
function askDeleteCert(c) {
  var vs = (c.versions || []).length;
  openModal('确认删除',
    '<p>要删除的是：<b>' + esc(c.name) + '</b></p>' +
    '<p class="hint">删除后<b>无法恢复</b>，它的 ' + vs + ' 个附件文件也会一起删掉。</p>',
    function () {
      return del('/api/certificates/' + c.id).then(function (r) {
        closeModal();
        toast('已删除' + (r.removed_files ? '，同时清理了 ' + r.removed_files + ' 个附件' : ''));
        load(state.view);
      }).catch(function (e) { toast(e.message); });
    }, null, '确定删除');
}

function vStatus(v) {
  var map = { pending: ['b-notice', '待审核'], approved: ['b-ok', '当前有效'],
              rejected: ['b-danger', '已退回'], history: ['b-gray', '历史版本'] };
  var m = map[v.status] || ['b-gray', v.status];
  return '<span class="badge ' + m[0] + '">' + m[1] + '</span>' +
    (v.reject_reason ? '　' + esc(v.reject_reason) : '');
}

function onVersionFile(input) {
  selectedFile(input, 'f_preview', 'certificate', 'versionFile', ['f_cam', 'f_pick']);
}
function uploadVersion(certId) {
  if (!state.versionFile) { showFormError('请先选择文件或拍照'); return false; }
  var file = state.versionFile;
  var stamp = $('modal')._stamp;
  var note = ($('f_change') || {}).value || '';
  return uploadFileTo(certId, file, note)
    .then(function (d) {
      toast(d.auto_approved ? '已上传并生效' : '已上传，等待管理员审核');
      if (currentModal(stamp)) {
        state.versionFile = null;
        closeModal(); load(state.view); openCert(certId);
      }
    })
    .catch(function (e) { toast(e.message); });
}

function review(vid, action) {
  if (action === 'reject') {
    openModal('退回附件版本',
      '<div class="field"><label>退回原因 *</label>' +
      '<textarea id="review_reason" maxlength="200" placeholder="上传人会看到这句话"></textarea></div>',
      function () {
        var reason = $('review_reason').value.trim();
        if (!reason) { showFormError('请填写退回原因', 'review_reason'); return false; }
        if (reason.length > 200) { showFormError('退回原因不能超过 200 字', 'review_reason'); return false; }
        var stamp = $('modal')._stamp;
        return post('/api/versions/' + vid + '/review', { action: 'reject', reason: reason })
          .then(function () {
            if (currentModal(stamp)) closeModal();
            toast('已退回'); load(state.view); loadReviewSummary();
          })
          .catch(function (e) { reviewError(e, stamp, 'version'); });
      }, null, '确认退回');
    return;
  }
  var stamp = $('modal')._stamp;
  return post('/api/versions/' + vid + '/review', { action: action, reason: '' })
    .then(function () { toast('已处理'); if (currentModal(stamp)) closeModal(); load(state.view); loadReviewSummary(); })
    .catch(function (e) { reviewError(e, stamp, 'version'); });
}

/* ---------- 资产 ---------- */
function loadAssets() {
  var box = $('assetList');
  var requestToken = {};
  state.assetRequest = requestToken;
  renderListState(box, 'loading', '正在加载…');
  api('/api/assets').then(function (rows) {
    if (state.assetRequest !== requestToken || state.view !== 'assets') return;
    state.assets = rows;
    box.innerHTML = rows.length ? rows.map(function (a) {
      var out = a.status === 'taken';
      var waiting = a.review_status && a.review_status !== 'approved';
      return '<tr>' +
        '<td data-label="名称">' + esc(a.name) +
          (waiting ? badge('notice', a.review_status === 'rejected' ? '已退回' : '待审核') : '') + '</td>' +
        '<td data-label="编号">' + esc(a.code || '-') + '</td>' +
        '<td data-label="分类">' + esc(a.category || '-') + '</td>' +
        '<td data-label="位置">' + esc(a.location || '-') + '</td>' +
        '<td data-label="状态">' + (out ? badge('warn', '已借出') : badge('ok', '在库')) + '</td>' +
        '<td data-label="领用人">' + esc(a.holder || '-') + '</td>' +
        '<td data-label="操作"><div class="row-actions">' +
          (waiting
            ? '<span class="cert-sub">审过之后才能领用 / 归还</span>'
            : (out ? '<button class="btn" onclick="moveAsset(' + a.id + ',\'return\')">登记归还</button>'
                   : '<button class="btn" onclick="moveAsset(' + a.id + ',\'take\')">登记领用</button>')) +
        '</div></td></tr>';
    }).join('') : '<tr><td class="empty">还没有资产记录</td></tr>';
  }).catch(function (e) {
    if (state.assetRequest !== requestToken) return;
    renderListState(box, 'error', e.message || '资产列表加载失败', loadAssets);
    toast(e.message);
  });
}

function showAssetForm() {
  var tip = (state.me && state.me.role === 'admin')
    ? '' : '<p class="cert-sub">登记后先交管理员审核，通过之后大家才看得到。</p>';
  openModal('新增资产', tip +
    '<div class="field"><label>名称 *</label><input id="a_name"></div>' +
    '<div class="field"><label>编号（可选）</label><input id="a_code"></div>' +
    '<div class="field"><label>分类</label><input id="a_category" placeholder="例如：电器 / 音响 / 家具"></div>' +
    '<div class="field"><label>存放位置</label><input id="a_location" placeholder="例如：二楼库房"></div>' +
    '<div class="field"><label>备注</label><input id="a_note"></div>',
    function () {
      var name = $('a_name').value.trim();
      if (!name) { showFormError('请填写名称', 'a_name'); return false; }
      if (!beginFormReview('资产：' + name)) return false;
      return post('/api/assets', { name: name, code: $('a_code').value, category: $('a_category').value,
                                   location: $('a_location').value, note: $('a_note').value })
        .then(function (res) {
          closeModal();
          toast(res && res.pending
            ? '已提交，等管理员审核通过后大家才看得到'
            : '已添加');
          loadAssets(); loadReviewSummary();
        })
        .catch(function (e) { toast(e.message); });
    }, null, '下一步：确认');
  prepareTwoStepForm(['a_name', 'a_category', 'a_location']);
}

function moveAsset(id, action) {
  var taking = action === 'take';
  openModal(taking ? '登记领用' : '登记归还',
    '<div class="field"><label>' + (taking ? '领用人' : '归还人') + ' *</label>' +
    '<input id="asset_person" maxlength="60" autocomplete="off" placeholder="填写姓名"></div>',
    function () {
      var person = $('asset_person').value.trim();
      if (!person) { showFormError('请填写' + (taking ? '领用人' : '归还人'), 'asset_person'); return false; }
      if (person.length > 60) { showFormError('姓名不能超过 60 字', 'asset_person'); return false; }
      var stamp = $('modal')._stamp;
      return post('/api/assets/' + id + '/move', { action: action, person: person })
        .then(function () {
          if (currentModal(stamp)) closeModal();
          toast('已登记'); loadAssets();
        })
        .catch(function (e) { toast(e.message); });
    }, null, taking ? '确认领用' : '确认归还');
}

/* ---------- 仓库 ---------- */
function loadInventory(immediate) {
  if (immediate) return loadInventoryNow();
  debounceList('inventory', function () { loadInventoryNow(); });
}
function loadInventoryNow() {
  var q = ($('q-inventory') || {}).value || '';
  var cat = ($('cat-inventory') || {}).value || '';
  var url = '/api/inventory?q=' + encodeURIComponent(q) +
            (cat ? '&category=' + encodeURIComponent(cat) : '');
  var box = $('invList');
  var requestToken = {};
  state.inventoryRequests.main = requestToken;
  renderListState(box, 'loading', '正在加载…');
  api(url).then(function (rows) {
    if (state.inventoryRequests.main !== requestToken || state.view !== 'inventory') return;
    state.inventory = rows;
    var expiring = 0, low = 0;
    rows.forEach(function (it) {
      if (it.expiry.level === 'expired' || it.expiry.level === 'warn') expiring++;
      if (it.safety_stock > 0 && it.quantity < it.safety_stock) low++;
    });
    if ($('invStat')) $('invStat').innerHTML = [
      card(rows.length, '物品总数'),
      card(expiring, '即将过期', 'warn'),
      card(low, '库存不足', 'danger')
    ].join('');
    box.innerHTML = rows.length ? rows.map(function (it) {
      var e = it.expiry;
      var low = it.safety_stock > 0 && it.quantity < it.safety_stock;
      var pending = it.status === 'pending' || it.status === 'rejected';
      var acts = '<div class="row-actions">' +
        (pending ? '<span class="cert-sub">审过之后才能登记库存</span>' :
        '<button class="btn" onclick="invIn(' + it.id + ')">采购入库</button>' +
        '<button class="btn" onclick="invOut(' + it.id + ')">消耗出库</button>' +
        '<button class="btn" onclick="invCount(' + it.id + ')">盘点</button>') +
        '<button class="btn" onclick="openInv(' + it.id + ')">详情</button>' +
        (state.me && state.me.role === 'admin'
          ? '<button class="btn danger" onclick="deleteInv(' + it.id + ')">删除</button>' : '') +
        '</div>';
      return '<tr>' +
        '<td data-label="名称">' + (it.thumb_url ? '<img src="' + esc(it.thumb_url) + '" alt="' + esc(it.name) +
          '" style="width:34px;height:34px;object-fit:contain;border-radius:6px;vertical-align:middle;margin-right:6px">' : '') +
          esc(it.name) + reviewBadge(it.status) + '</td>' +
        '<td data-label="分类">' + esc(it.category) + '</td>' +
        '<td data-label="规格">' + esc(it.spec || '-') + '</td>' +
        '<td data-label="当前库存"><b>' + esc(it.quantity) + '</b> ' + esc(it.unit) +
          (low ? ' ' + badge('danger', '库存不足') : '') + '</td>' +
        '<td data-label="过期">' + badge(e.level, e.label) + '</td>' +
        '<td data-label="安全库存">' + esc(it.safety_stock || 0) + '</td>' +
        '<td data-label="操作">' + acts + '</td></tr>';
    }).join('') :
      '<tr><td class="empty">仓库还是空的，点右上角「新增物品」先把常备的酒水、耗材建好</td></tr>';
  }).catch(function (e) {
    if (state.inventoryRequests.main !== requestToken) return;
    renderListState(box, 'error', e.message || '仓库列表加载失败', loadInventoryNow);
    toast(e.message);
  });
}

function openStocktake() {
  if ($('invMain')) $('invMain').classList.add('hidden');
  if ($('stocktakePanel')) $('stocktakePanel').classList.remove('hidden');
  loadStocktake();
}

function closeStocktake() {
  return requestUserExit(clearStocktake);
}
function clearStocktake() {
  if ($('stocktakePanel')) $('stocktakePanel').classList.add('hidden');
  if ($('invMain')) $('invMain').classList.remove('hidden');
  state.stocktake = [];
  if ($('stocktakeFeedback')) $('stocktakeFeedback').textContent = '';
}

function loadStocktake() {
  var cat = ($('st-cat') || {}).value || '酒水';
  if (stocktakeDirty() && !state.userActionAllowed) {
    $('st-cat').value = state.stocktakeCategory || cat;
    return requestUserExit(function () { closeModal(); clearStocktake(); openStocktakeCategory(cat); });
  }
  return fetchStocktake(cat, false);
}
function openStocktakeCategory(cat) {
  $('st-cat').value = cat;
  $('stocktakePanel').classList.remove('hidden'); $('invMain').classList.add('hidden');
  return fetchStocktake(cat, false);
}
function refreshStocktake() {
  if (modalProcessing()) { toast('正在处理，请稍后再刷新'); return; }
  return fetchStocktake(state.stocktakeCategory || $('st-cat').value, true);
}
function fetchStocktake(cat, preserve) {
  var requestToken = {};
  state.stocktakeRequestToken = requestToken;
  var previous = {};
  if (preserve) (state.stocktake || []).forEach(function (row) {
    previous[row.id] = { row: row };
  });
  return api('/api/inventory/stocktake?category=' + encodeURIComponent(cat)).then(function (d) {
    if (state.stocktakeRequestToken !== requestToken) return;
    state.stocktakeCategory = cat;
    state.stocktake = d.rows.map(function (r) {
      var old = previous[r.id];
      if (!old) return r;
      // 请求等待时仍可填写；在响应重绘前读取同一批当前输入。
      var input = $('st_' + r.id);
      r.actualInput = input ? input.value : String(old.row.quantity);
      // 显式刷新只展示候选账面；勾选重新清点后才将其作为提交基准。
      r.pendingBaseline = { quantity: r.quantity, stock_log_id: r.stock_log_id };
      r.quantity = old.row.quantity; r.stock_log_id = old.row.stock_log_id;
      r.needsRecount = true;
      return r;
    });
    if ($('stocktakeFeedback')) $('stocktakeFeedback').textContent = preserve
      ? '最新账面已加载，原实盘输入保留。请逐项重新清点并勾选确认后提交差异项。' : '';
    var sum = $('st-summary');
    if (sum) sum.textContent = d.month + ' 月 · 共 ' + d.rows.length + ' 项';
    var box = $('stList');
    if (!box) return;
    box.innerHTML = state.stocktake.length ? state.stocktake.map(function (r) {
      var displayed = r.pendingBaseline ? r.pendingBaseline.quantity : r.quantity;
      return '<tr>' +
        '<td data-label="物品名称">' + esc(r.name) + '</td>' +
        '<td data-label="规格">' + esc(r.spec || '-') + '</td>' +
        '<td data-label="月初库存">' + r.month_begin + '</td>' +
        '<td data-label="当月采购" class="pos">+' + r.month_purchase + '</td>' +
        '<td data-label="当月领用" class="neg">-' + r.month_consume + '</td>' +
        '<td data-label="结余"><b id="st_balance_' + r.id + '">' + displayed + '</b> ' + esc(r.unit) + '</td>' +
        '<td data-label="实盘数"><input aria-label="' + esc(r.name + '实盘数') + '" type="number" id="st_' + r.id + '" value="' + esc(r.actualInput === undefined ? r.quantity : r.actualInput) + '" min="0" step="1" style="width:74px">' +
          (r.needsRecount ? '<label class="recount-check"><input type="checkbox" id="st_recount_' + r.id + '">已按最新账面重新清点</label>' : '') + '</td>' +
        '<td data-label="差异" id="std_' + r.id + '"></td></tr>';
    }).join('') : '<tr><td class="empty">该分类下还没有物品，先去「物品列表」建好</td></tr>';
    if (d.rows.length) bindStocktakeDiff();
  }).catch(function (e) { toast(e.message); });
}

function bindStocktakeDiff() {
  (state.stocktake || []).forEach(function (r) {
    var inp = $('st_' + r.id);
    if (!inp) return;
    inp.oninput = function () {
      var v = strictInteger(inp.value, 0);
      var cell = $('std_' + r.id);
      if (!cell) return;
      if (r.conflict) { cell.innerHTML = '<span class="neg">账面已变化，请重新加载并清点</span>'; return; }
      if (r.needsRecount) { cell.innerHTML = '<span class="neg">请重新清点并勾选确认</span>'; return; }
      if (v === null) { cell.innerHTML = '<span class="neg">请输入非负整数</span>'; return; }
      var diff = v - r.quantity;
      if (diff === 0) cell.innerHTML = '<span class="muted">相符</span>';
      else if (diff > 0) cell.innerHTML = '<span class="pos">盘盈 ' + diff + '</span>';
      else cell.innerHTML = '<span class="neg">盘亏 ' + (-diff) + '</span>';
    };
    var recount = $('st_recount_' + r.id);
    if (recount) recount.onchange = function () {
      if (recount.checked && r.pendingBaseline) {
        r.quantity = r.pendingBaseline.quantity; r.stock_log_id = r.pendingBaseline.stock_log_id;
        r.needsRecount = false; r.conflict = false; r.pendingBaseline = null;
        recount.disabled = true;
      }
      inp.oninput();
    };
    inp.oninput();
  });
}

function syncStocktakeSettled(done, unchanged, items) {
  (done || []).forEach(function (result) {
    var row = (state.stocktake || []).filter(function (r) { return r.id === result.id; })[0];
    if (row) { row.quantity = result.quantity; row.settled = true; }
    if ($('st_' + result.id)) $('st_' + result.id).disabled = true;
    var balance = $('st_balance_' + result.id);
    if (balance) balance.textContent = String(result.quantity);
  });
  (unchanged || []).forEach(function (id) {
    var row = (state.stocktake || []).filter(function (r) { return r.id === id; })[0];
    var sent = items.filter(function (item) { return item.id === id; })[0];
    if (!row || !sent) return;
    row.quantity = sent.actual;
    row.settled = true;
    if ($('st_' + id)) $('st_' + id).disabled = true;
    var balance = $('st_balance_' + id);
    if (balance) balance.textContent = String(sent.actual);
  });
  bindStocktakeDiff();
}

function submitStocktake() {
  if (modalProcessing()) return;
  var cat = ($('st-cat') || {}).value || '酒水';
  var items = [];
  var invalid = false;
  (state.stocktake || []).forEach(function (r) {
    var inp = $('st_' + r.id);
    if (!inp || r.settled) return;
    if (r.conflict || r.needsRecount) { invalid = true; return; }
    var v = strictInteger(inp.value, 0);
    if (v === null) { invalid = true; return; }
    if (v !== r.quantity) items.push({ id: r.id, actual: v,
      expected_quantity: r.quantity, expected_stock_log_id: r.stock_log_id });
  });
  if (invalid) { showFormError('请检查实盘数；账面冲突项须重新加载账面并重新清点确认'); bindStocktakeDiff(); return; }
  if (!items.length) { toast('没有变化，无需提交'); return; }
  var lines = items.map(function (it) {
    var r = (state.stocktake || []).filter(function (x) { return x.id === it.id; })[0];
    var d = it.actual - r.quantity;
    return r.name + '：' + r.quantity + ' → ' + it.actual + '（' + (d > 0 ? '盘盈 ' + d : '盘亏 ' + (-d)) + '）';
  });
  openModal('确认提交盘点 · ' + cat,
    '<p class="hint">将记录以下 ' + items.length + ' 项盘点（账实相符的不记）：</p>' +
    '<div style="max-height:240px;overflow:auto">' +
    lines.map(function (t) { return '<div style="padding:4px 0;border-bottom:0.5px solid #E2D9C8">' + esc(t) + '</div>'; }).join('') +
    '</div>',
    function () {
      var stamp = $('modal')._stamp;
      return post('/api/inventory/stocktake', { items: items })
        .then(function (res) {
          var msg = '盘点已提交：' + res.done.length + ' 项更新';
          if (!currentModal(stamp)) {
            toast('此前盘点请求已完成，请返回盘点页核对结果');
            return;
          }
          var errors = res.errors_detail || [];
          if (errors.length || (res.errors && res.errors.length)) {
            syncStocktakeSettled(res.done, res.unchanged, items);
            $('modalBody').innerHTML = '<p>' + esc(msg) + '，仍有 ' + (errors.length || res.errors.length) + ' 项未通过：</p>' +
              (errors.length ? errors.map(function (error) {
                var row = (state.stocktake || []).filter(function (r) { return r.id === error.id; })[0];
                return '<p class="hint">' + (row ? '<b>' + esc(row.name) + '：</b>' : '') + esc(error.message) + '</p>';
              }) : res.errors.map(function (error) {
                return '<p class="hint">' + esc(error) + '</p>';
              })).join('') +
              '<p>返回盘点后可修改原有实盘数，再提交失败项。</p>';
            $('modalOk').classList.add('hidden');
            $('modalCancel').textContent = '返回盘点';
            return;
          }
          syncStocktakeSettled(res.done, res.unchanged, items);
          closeModal(); toast(msg);
          if ($('stocktakeFeedback')) $('stocktakeFeedback').textContent = msg + '。仅提交的差异项已处理，未提交行不算已盘点；再次盘点请重新加载账面。';
        })
        .catch(function (e) {
          if (!currentModal(stamp) || !e.details || !e.details.length) { showFormError(e.message); return; }
          var conflict = e.status === 409 && e.code === 'stocktake_conflict';
          if (conflict) {
            e.details.forEach(function (detail) {
              var row = (state.stocktake || []).filter(function (r) { return r.id === detail.id; })[0];
              if (row) row.conflict = true;
            });
            if ($('stocktakeFeedback')) $('stocktakeFeedback').textContent = '账面已变化，本次整批未写入。实盘输入已保留，请重新加载账面数据，重新清点并确认。';
            bindStocktakeDiff();
          } else syncStocktakeSettled([], e.unchanged, items);
          $('modalBody').innerHTML = '<p>本次盘点未写入，以下物品需要处理：</p>' +
            e.details.map(function (detail) {
              var row = (state.stocktake || []).filter(function (r) { return r.id === detail.id; })[0];
              return '<p class="hint">' + (row ? '<b>' + esc(row.name) + '：</b>' : '') +
                esc(detail.message) + '</p>';
            }).join('') + (conflict ? '<p>原实盘输入保留；返回盘点后请重新加载账面数据，并重新清点确认。</p>' : '<p>返回盘点后可修改原有实盘数。</p>');
          $('modalOk').classList.add('hidden');
          $('modalCancel').textContent = '返回盘点';
        });
    });
}

function showInvForm() {
  var formToken = {};
  state.invFile = null;
  openModal('新增物品',
    '<div class="field"><label>名称 *</label><input id="i_name" placeholder="例如：百威啤酒 / 纸巾"></div>' +
    '<div class="field"><label>分类</label><select id="i_cat">' +
      INVENTORY_CATEGORIES.map(function (c) { return '<option' + (c === '其它' ? ' selected' : '') + '>' + c + '</option>'; }).join('') +
      '</select></div>' +
    '<div class="field"><label>规格</label><input id="i_spec" placeholder="例如：500ml/瓶 / 24瓶/箱"></div>' +
    '<div class="field"><label>单位</label><input id="i_unit" value="个" placeholder="瓶/箱/个/包/件"></div>' +
    '<div class="field"><label>当前库存（期初数）*</label><input type="number" id="i_qty" value="0" min="0"></div>' +
    '<div class="field"><label>安全库存（低于此数提示补货，0=不提醒）</label><input type="number" id="i_safe" value="0" min="0"></div>' +
    '<div class="field"><label>有效期方式</label><select id="i_mode">' +
      '<option value="date">有明确到期日</option>' +
      '<option value="longterm">长期有效</option>' +
      '<option value="unknown">暂不确定</option></select></div>' +
    '<div class="field"><label>过期日期</label><input type="date" id="i_expiry"></div>' +
    '<div class="field"><label>存放位置</label><input id="i_loc" placeholder="例如：二楼库房"></div>' +
    '<div class="field file-picker"><label>物品图片（可选，建好后可再传）</label>' +
      '<input type="file" id="i_img" accept="image/jpeg,image/png" onchange="onInvNewFile(this)">' +
      '<div id="i_preview"></div></div>' +
    '<div class="field"><label>备注</label><textarea id="i_note"></textarea></div>',
    function () {
      var name = $('i_name').value.trim();
      if (!name) { showFormError('请填写名称', 'i_name'); return false; }
      var qty = readInteger('i_qty', 0, '库存');
      if (qty === null) return false;
      var mode = $('i_mode').value, expiry = $('i_expiry').value;
      if (mode === 'date' && !expiry) { showFormError('请填写到期日期', 'i_expiry'); return false; }
      if (!beginFormReview('物品：' + name + '；期初数：' + qty)) return false;
      var safety = readInteger('i_safe', 0, '安全库存');
      if (safety === null) return false;
      var body = {
        name: name, category: $('i_cat').value, spec: $('i_spec').value,
        unit: ($('i_unit').value || '个').trim() || '个', quantity: qty,
        safety_stock: safety,
        expiry_mode: mode, expiry_date: expiry,
        location: $('i_loc').value, note: $('i_note').value
      };
      var file = state.invFile;
      var stamp = $('modal')._stamp;
      return post('/api/inventory', body)
        .then(function (res) {
          var msg = (res && res.status === 'pending')
            ? '已提交，等管理员审核通过后大家才看得到'
            : '已添加';
          if (!file) {
            var active = currentForm(formToken, stamp);
            if (active) { closeModal(); loadInventory(); loadReviewSummary(); }
            toast(active ? msg : '此前物品已保存');
            return;
          }
          var fd = new FormData();
          fd.append('file', file);
          // 传图这一步的请求必须 return 出去、并且自己接住失败：
          // 以前它孤零零地发出去没人管，图没传成也一声不响，
          // 出错时在后台留一个没人处理的失败（审计 10/03 S-02）。
          return api('/api/inventory/' + res.id + '/image',
                     { method: 'POST', headers: SAFE_HEADER, body: fd })
            .then(function (imageResult) {
              if (currentForm(formToken, stamp)) { closeModal(); loadInventory(); loadReviewSummary(); }
              toast(msg + (imageResult.status === 'pending' ? '；图片等待管理员审核' : '；图片已保存'));
            })
            .catch(function (e) {
              if (!currentForm(formToken, stamp)) {
                toast('此前物品已保存，但图片未成功（' + e.message + '），请到该物品重传');
                return;
              }
              state.pendingInvFile = { id: res.id, file: file, message: '物品已保存；图片未成功（' + e.message + '），请在这里重试图片上传。' };
              closeModal(); loadInventory(); loadReviewSummary();
              toast('物品已经记下了，图片没传成功（' + e.message + '）。已打开这件物品，可直接重试图片上传。');
              openInv(res.id);
            });
        })
        .catch(function (e) { toast(e.message); });
    }, null, '下一步：确认');
  state.activeFormToken = formToken;
  prepareTwoStepForm(['i_name', 'i_cat', 'i_spec', 'i_unit', 'i_qty', 'i_mode', 'i_expiry']);
}
function onInvNewFile(input) {
  selectedFile(input, 'i_preview', 'inventory', 'invFile', ['i_img']);
}

function invIn(id) {
  var it = state.inventory.filter(function (x) { return x.id === id; })[0];
  openModal('采购入库 · ' + (it ? it.name : ''),
    '<div class="field"><label>入库数量 *</label><input type="number" id="in_qty" value="1" min="1"></div>' +
    '<div class="field"><label>供应商（可选）</label><input id="in_sup" placeholder="例如：xx商贸"></div>' +
    '<div class="field"><label>备注（可选）</label><input id="in_note"></div>',
    function () {
      var q = readInteger('in_qty', 1, '入库数量');
      if (q === null) return false;
      return post('/api/inventory/' + id + '/in', { qty: q, supplier: $('in_sup').value, note: $('in_note').value })
        .then(function () { closeModal(); toast('已入库'); loadInventory(); })
        .catch(function (e) { toast(e.message); });
    });
}

function invOut(id) {
  var it = state.inventory.filter(function (x) { return x.id === id; })[0];
  openModal('消耗出库 · ' + (it ? it.name : ''),
    '<div class="field"><label>当前库存</label><input value="' + (it ? esc(it.quantity + ' ' + it.unit) : '') + '" disabled></div>' +
    '<div class="field"><label>出库数量 *</label><input type="number" id="out_qty" value="1" min="1"></div>' +
    '<div class="field"><label>用途 / 备注（可选）</label><input id="out_note" placeholder="例如：3 包厢用"></div>',
    function () {
      var q = readInteger('out_qty', 1, '出库数量');
      if (q === null) return false;
      return post('/api/inventory/' + id + '/out', { qty: q, note: $('out_note').value })
        .then(function () { closeModal(); toast('已出库'); loadInventory(); })
        .catch(function (e) { toast(e.message); });
    });
}

function invCount(id) {
  var stamp = $('modal')._stamp, requestToken = {};
  state.countRequestToken = requestToken;
  return api('/api/inventory/' + id).then(function (it) {
    if (state.countRequestToken !== requestToken || $('modal')._stamp !== stamp) return;
    if (!acceptModalResponse(function () { invCount(id); })) return;
    openModal('盘点 · ' + it.name,
    '<p class="hint">录入你实际数到的数量，系统自动算盘盈 / 盘亏。</p>' +
    '<div class="field"><label>系统账面数量</label><input id="cnt_balance" value="' + esc(it.quantity + ' ' + it.unit) + '" disabled></div>' +
    '<div class="field"><label>实物实际数量 *</label><input type="number" id="cnt_actual" value="' + it.quantity + '" min="0"></div>' +
    '<div id="cnt_conflict" class="hidden"><button type="button" class="btn" onclick="refreshSingleStocktake()">重新加载账面数据</button>' +
    '<label id="cnt_recount_label" class="recount-check hidden"><input type="checkbox" id="cnt_recount">已按最新账面重新清点确认</label></div>',
    function () {
      var a = readInteger('cnt_actual', 0, '实物数量');
      if (a === null) return false;
      var count = state.singleStocktake;
      if (count.conflict || (count.pendingBaseline && !$('cnt_recount').checked)) {
        showFormError('账面已变化，请重新加载账面数据并重新清点确认'); return false;
      }
      if (count.pendingBaseline) {
        count.quantity = count.pendingBaseline.quantity; count.stock_log_id = count.pendingBaseline.stock_log_id;
        count.pendingBaseline = null;
      }
      return post('/api/inventory/' + id + '/count', { actual: a,
        expected_quantity: count.quantity, expected_stock_log_id: count.stock_log_id })
        .then(function () { closeModal(); toast('盘点已记录'); loadInventory(); })
        .catch(function (e) {
          if (e.status === 409 && e.code === 'stocktake_conflict') {
            count.conflict = true;
            $('cnt_conflict').classList.remove('hidden');
            $('cnt_recount').checked = false; $('cnt_recount_label').classList.add('hidden');
            showFormError('账面已变化，本次未写入，实盘输入已保留。请重新加载账面数据并重新清点确认。');
          } else showFormError(e.message);
        });
    });
    state.singleStocktake = { id: id, unit: it.unit, quantity: it.quantity, stock_log_id: it.stock_log_id };
  }).catch(function (e) { showFormError(e.message); });
}
function refreshSingleStocktake() {
  if (modalProcessing() || !state.singleStocktake) return;
  var count = state.singleStocktake, stamp = $('modal')._stamp;
  return api('/api/inventory/' + count.id).then(function (it) {
    if (!currentModal(stamp) || state.singleStocktake !== count) return;
    count.pendingBaseline = { quantity: it.quantity, stock_log_id: it.stock_log_id };
    count.conflict = false;
    $('cnt_balance').value = it.quantity + ' ' + it.unit;
    $('cnt_recount').checked = false;
    $('cnt_recount_label').classList.remove('hidden');
    showFormError('最新账面已加载，原实盘输入保留。请重新清点，再勾选确认后提交。');
  }).catch(function (e) { showFormError(e.message); });
}

function openInv(id) {
  var requestToken = {};
  state.detailRequestToken = requestToken;
  var stamp = $('modal')._stamp;
  api('/api/inventory/' + id).then(function (it) {
    if (state.detailRequestToken !== requestToken || $('modal')._stamp !== stamp) return;
    if (!acceptModalResponse(function () { openInv(id); })) return;
    var e = it.expiry;
    var actMap = { purchase: '采购入库', consume: '消耗出库', adjust: '盘点调整', initial: '期初建账' };
    var imgBlock = '';
    imgBlock = it.web_url
      ? LexiuFiles.renderSaved({ original_name: it.original_name || '物品图片.jpg',
          web_url: it.web_url, file_size: it.file_size }, { imageOnly: true })
      : '<div class="no-photo">尚未上传物品图片</div>';
    imgBlock += '<div class="field file-picker"><label>选择物品图片（JPG / PNG）</label>' +
      '<input type="file" id="inv_img" accept="image/jpeg,image/png" onchange="onInvImageFile(this)">' +
      '<div id="inv_preview"></div>' +
      '<button type="button" id="invImageSubmit" class="btn primary" onclick="uploadInvImage(' + it.id + ')">确认上传图片</button>' +
      '</div>';
    if (state.me && state.me.role === 'admin' && it.web_url) {
      imgBlock += '<button class="btn danger" onclick="removeInvImage(' + it.id + ')">移除图片</button>';
    }
    var imageVersions = (it.image_versions || []).map(function (v) {
      return '<div class="file-history"><span>v' + esc(v.version_no) + ' · ' +
        esc(v.status === 'pending' ? '待审核' : v.status === 'rejected' ? '已退回' :
          v.status === 'history' ? '历史版本' : '当前有效') + '</span>' +
        '<span class="file-size">' + esc(v.uploaded_by || '') + ' · ' +
          esc((v.uploaded_at || '').slice(0, 16)) + '</span>' +
        LexiuFiles.renderSaved(v, { imageOnly: true }) +
        (v.reject_reason ? '<p>' + esc(v.reject_reason) + '</p>' : '') + '</div>';
    }).join('');
    if (imageVersions) imgBlock += '<h3>图片版本</h3>' + imageVersions;
    var logs = (it.logs || []).map(function (l) {
      var sign = l.change_qty > 0 ? ('+' + l.change_qty) : ('' + l.change_qty);
      return '<tr>' +
        '<td data-label="时间">' + esc((l.at || '').slice(0, 16)) + '</td>' +
        '<td data-label="动作">' + esc(actMap[l.action] || l.action) + '</td>' +
        '<td data-label="变动">' + sign + '</td>' +
        '<td data-label="变动后">' + esc(l.after_qty) + '</td>' +
        '<td data-label="操作人">' + esc(l.operator || '-') + '</td>' +
        '<td data-label="说明">' + (l.supplier ? ('供应商：' + esc(l.supplier) + ' ') : '') + esc(l.note || '-') + '</td></tr>';
    }).join('') || '<tr><td class="empty">还没有流水记录</td></tr>';
    // 管理员能直接在详情页改档案：设计文档里就是这么定的，后端 PUT 也早就有了，
    // 可页面以前只给看、不给改，录错了只能删掉重来（审计 10/03 S-04）。
    // 只有档案字段能改；库存数量一律不在这里动，它必须由入/出/盘点产生流水，
    // 不然账面上的数和流水就对不上了。员工看到的还是原来的只读样子。
    var isAdmin = !!(state.me && state.me.role === 'admin');
    var detailBody;
    if (isAdmin) {
      detailBody =
        '<div class="field"><label>名称 *</label><input id="iv_name" value="' + esc(it.name) + '"></div>' +
        '<div class="field"><label>分类</label><select id="iv_cat">' +
          INVENTORY_CATEGORIES.map(function (c) {
            return '<option' + (c === it.category ? ' selected' : '') + '>' + c + '</option>';
          }).join('') + '</select></div>' +
        '<div class="field"><label>规格</label><input id="iv_spec" value="' + esc(it.spec || '') + '"></div>' +
        '<div class="field"><label>单位</label><input id="iv_unit" value="' + esc(it.unit || '个') + '"></div>' +
        '<div class="field"><label>当前库存</label><input value="' + esc(it.quantity + ' ' + (it.unit || '个')) + '" disabled>' +
          '<p class="hint">库存数量不在这里改：要点右边的「入库 / 出库 / 盘点」，每一笔都会留下流水。</p></div>' +
        '<div class="field"><label>安全库存（低于此数提示补货，0=不提醒）</label>' +
          '<input type="number" id="iv_safe" min="0" value="' + esc(it.safety_stock || 0) + '"></div>' +
        '<div class="field"><label>有效期方式</label><select id="iv_mode">' +
          '<option value="date"' + (it.expiry_mode === 'date' ? ' selected' : '') + '>有明确到期日</option>' +
          '<option value="longterm"' + (it.expiry_mode === 'longterm' ? ' selected' : '') + '>长期有效</option>' +
          '<option value="unknown"' + (it.expiry_mode === 'unknown' ? ' selected' : '') + '>暂不确定</option>' +
          '</select></div>' +
        '<div class="field"><label>过期日期</label>' +
          '<input type="date" id="iv_expiry" value="' + esc(it.expiry_date || '') + '"></div>' +
        '<div class="field"><label>提前提醒天数</label>' +
          '<input type="number" id="iv_warn" min="0" value="' + esc(it.warn_days || 0) + '"></div>' +
        '<div class="field"><label>存放位置</label><input id="iv_loc" value="' + esc(it.location || '') + '"></div>' +
        '<div class="field"><label>备注</label><textarea id="iv_note">' + esc(it.note || '') + '</textarea></div>';
    } else {
      detailBody =
        '<div class="field">分类：' + esc(it.category) + '　规格：' + esc(it.spec || '-') + '　单位：' + esc(it.unit) + '</div>' +
        '<div class="field">当前库存：<b>' + esc(it.quantity) + '</b> ' + esc(it.unit) + '</div>' +
        '<div class="field">过期：' + badge(e.level, e.label) + '　' + esc(it.expiry_date || '-') + '</div>' +
        '<div class="field">安全库存：' + esc(it.safety_stock || 0) + '　位置：' + esc(it.location || '-') + '</div>' +
        '<div class="field">备注：' + esc(it.note || '-') + '</div>';
    }
    openModal('物品详情 · ' + it.name,
      imgBlock + detailBody +
      '<hr style="border:none;border-top:1px solid var(--line);margin:14px 0">' +
      '<h3 style="font-size:14px;margin-bottom:8px">出入库流水</h3>' +
      '<table>' + logs + '</table>',
      isAdmin ? function () {
        var vName = (($('iv_name') || {}).value || '').trim();
        if (!vName) { showFormError('请填写名称', 'iv_name'); return false; }
        var vMode = ($('iv_mode') || {}).value;
        var vExpiry = ($('iv_expiry') || {}).value || '';
        if (vMode === 'date' && !vExpiry) { showFormError('请填写到期日期', 'iv_expiry'); return false; }
        var safety = readInteger('iv_safe', 0, '安全库存');
        var warn = readInteger('iv_warn', 0, '提前提醒天数');
        if (safety === null || warn === null) return false;
        var payload = {
          name: vName, category: ($('iv_cat') || {}).value, spec: ($('iv_spec') || {}).value,
          unit: (($('iv_unit') || {}).value || '个').trim() || '个',
          safety_stock: safety,
          expiry_mode: vMode, expiry_date: vExpiry,
          warn_days: warn,
          location: ($('iv_loc') || {}).value, note: ($('iv_note') || {}).value
        };
        return put('/api/inventory/' + it.id, payload)
          .then(function () { closeModal(); toast('档案已保存'); loadInventory(); })
          .catch(function (err) { toast(err.message); });
      } : null);
    var retry = state.pendingInvFile;
    state.invImageFile = retry && retry.id === id ? retry.file : null;
    if (state.invImageFile) state.pendingInvFile = null;
    if (state.invImageFile) {
      LexiuFiles.showSelection($('inv_preview'), state.invImageFile, { kind: 'inventory' });
      bindPreviewActions($('inv_preview'), $('inv_img'), 'invImageFile', ['inv_img']);
      showFormError(retry.message || '物品已保存，图片未成功，请重试图片上传。');
    }
  }).catch(function (e) { toast(e.message); });
}

function deleteInv(id) {
  var it = state.inventory.filter(function (x) { return x.id === id; })[0];
  if (!it) return;
  openModal('确认删除',
    '<p>要删除：<b>' + esc(it.name) + '</b></p>' +
    '<p class="hint">删除后列表里不再显示，当前、历史和待审图片文件也会清理；出入库流水会保留作为历史记录。' +
    '确定不再要了，请手输当前物品全名。</p>' +
    '<div class="field"><label>请手输物品全名确认</label><input id="delete_inv_name" autocomplete="off"></div>',
    function () {
      var typed = $('delete_inv_name').value;
      if (typed !== it.name) { showFormError('物品名称不一致，未删除', 'delete_inv_name'); return false; }
      return del('/api/inventory/' + id, { confirm_name: typed })
        .then(function () { closeModal(); toast('已删除'); loadInventory(); })
        .catch(function (e) { toast(e.message); });
    }, null, '确定删除');
}

function onInvImageFile(input) {
  selectedFile(input, 'inv_preview', 'inventory', 'invImageFile', ['inv_img']);
}
function uploadInvImage(id) {
  var file = state.invImageFile;
  if (!file) { showFormError('请先选择图片'); return false; }
  var stamp = $('modal')._stamp;
  var button = $('invImageSubmit');
  if (button.disabled) return false;
  button.disabled = true; button.textContent = '上传中…';
  var fd = new FormData();
  fd.append('file', file);
  // 走 api() 而不是直接 fetch：api() 里有"同一个请求还在路上就挡掉"的保护，
  // 直接 fetch 等于把这道保护绕过去了，连点两下就会传两遍。
  return api('/api/inventory/' + id + '/image', { method: 'POST', headers: SAFE_HEADER, body: fd })
    .then(function (result) {
      toast(result.status === 'pending' ? '图片已上传，等待管理员审核' : '图片已更新');
      if (currentModal(stamp)) {
        state.invImageFile = null;
        if ($('inv_img')) $('inv_img').value = '';
        if ($('inv_preview')) LexiuFiles.release($('inv_preview'));
        if (modalDirty()) {
          toast('图片已上传；档案修改尚未保存，请继续保存档案。关闭后重新打开可查看新图片。');
        } else { closeModal(); openInv(id); }
      }
    })
    .catch(function (e) { toast(e.message); })
    .then(function () {
      if (button.isConnected) { button.disabled = false; button.textContent = '确认上传图片'; }
    });
}

function removeInvImage(id) {
  if (!state.me || state.me.role !== 'admin') return;
  if (!confirm('确定移除这件物品的图片吗？当前图和所有历史、待审图片版本都会删除，无法恢复。')) return;
  del('/api/inventory/' + id + '/image')
    .then(function () { toast('已移除图片'); closeModal(); openInv(id); })
    .catch(function (e) { toast(e.message); });
}

/* ---------- 设置 ---------- */
function loadUsers() {
  var box = $('userList');
  var requestToken = {};
  state.userRequest = requestToken;
  renderListState(box, 'loading', '正在加载…');
  api('/api/me').then(function (me) {
    if (state.userRequest !== requestToken || state.view !== 'settings') return null;
    var el = $('versionTag');
    if (el && me.version) el.textContent = '当前版本 v' + me.version;
    state.me = Object.assign(state.me || {}, me);   // 记住「我是谁」，用来挡住删自己
    return api('/api/users');
  }).then(function (rows) {
    if (!rows || state.userRequest !== requestToken || state.view !== 'settings') return;
    var myId = state.me ? state.me.id : null;
    box.innerHTML = rows.length ? rows.map(function (u) {
      // 自己正在用的这个不给删：删完当下这个页面就登不出去了
      var del = (u.id === myId)
        ? '<span class="muted">本人</span>'
        : '<button type="button" class="btn danger" data-act="del-user" data-uid="' + u.id +
          '" data-uname="' + esc(u.username) + '">删除</button>';
      return '<tr><td data-label="账号">' + esc(u.username) + '</td>' +
        '<td data-label="姓名">' + esc(u.name) + '</td>' +
        '<td data-label="角色">' + (u.role === 'admin' ? '管理员' : '普通员工') + '</td>' +
        '<td data-label="最后登录">' + esc((u.last_login || '-').slice ? (u.last_login || '-').slice(0, 16) : u.last_login) + '</td>' +
        '<td data-label="操作">' + del + '</td></tr>';
    }).join('') : '<tr><td class="empty" colspan="5">暂无账号</td></tr>';
    // 账号名是管理员自己填的，里面可能带引号、尖括号一类符号。
    // 以前的做法是把名字拼进 onclick="deleteUser(1,'名字')"：
    // 浏览器会先把 HTML 里的 &quot; 这些写法还原成真正的引号**再**把它当代码执行，
    // 于是名字里带的那句话真被当成代码跑了一遍（审计 10/02 S-03）。
    // 现在名字只放进 data-* 属性（esc 已经把引号换成安全写法，出不了属性这个框），
    // 点击由这里统一接管。页面上不再有"把用户输入当代码跑"的口子。
    bindUserDelete();
  }).catch(function (e) {
    if (state.userRequest !== requestToken) return;
    renderListState(box, 'error', e.message || '账号列表加载失败', loadUsers);
    toast(e.message);
  });
}

function bindUserDelete() {
  var list = $('userList');
  if (!list) return;
  Array.prototype.forEach.call(
    list.querySelectorAll('[data-act="del-user"]'),
    function (b) {
      b.addEventListener('click', function () {
        deleteUser(b.getAttribute('data-uid'), b.getAttribute('data-uname'));
      });
    });
}

function deleteUser(uid, uname) {
  if (!confirm('确定要删掉账号「' + uname + '」吗？\n\n删掉后这个人马上就登不进来了；以后要是他再回来上班，用同一个账号名重新建一个就行。'))
    return;
  api('/api/users/' + uid, { method: 'DELETE', headers: SAFE_HEADER })
    .then(function () { toast('账号已删除'); loadUsers(); })
    .catch(function (e) { toast(e.message); });
}

function showUserForm() {
  openModal('新建账号',
    '<div class="field"><label>登录账号 *</label><input id="u_name"></div>' +
    '<div class="field"><label>姓名</label><input id="u_real"></div>' +
    '<div class="field"><label>角色</label><select id="u_role"><option value="staff">普通员工</option>' +
      '<option value="admin">管理员</option></select></div>' +
    '<div class="field"><label>初始密码（留空则自动生成）</label><input type="password" id="u_pwd" autocomplete="new-password"></div>',
    function () {
      var un = $('u_name').value.trim();
      if (!un) { showFormError('请填写账号', 'u_name'); return false; }
      var payload = { username: un, name: $('u_real').value, role: $('u_role').value };
      if ($('u_pwd').value) payload.password = $('u_pwd').value;
      return post('/api/users', payload)
        .then(function (d) {
          closeModal();
          prompt('账号已创建。初始密码是（请记下并告知本人）：', d.password);
          loadUsers();
        }).catch(function (e) { toast(e.message); });
    });
}

/* 改密码：用输入框而不是浏览器弹窗，并要求输两遍
   （之前用弹窗只输一次，容易多打空格导致自己都登不进去） */
function changePassword() {
  openModal('修改密码',
    '<div class="field"><label>当前密码</label><input type="password" id="p_cur" autocomplete="current-password"></div>' +
    '<div class="field"><label>新密码（至少 6 位）</label><input type="password" id="p_new" autocomplete="new-password"></div>' +
    '<div class="field"><label>再输一次新密码</label><input type="password" id="p_new2" autocomplete="new-password"></div>' +
    '<p class="hint">注意：密码前后不要带空格，也别开着中文输入法输。</p>',
    function () {
      var cur = $('p_cur').value, a = $('p_new').value, b = $('p_new2').value;
      if (!cur) { showFormError('请填写当前密码', 'p_cur'); return false; }
      if (a.length < 6) { showFormError('新密码至少 6 位', 'p_new'); return false; }
      if (a.length > 200) { showFormError('新密码不能超过 200 位', 'p_new'); return false; }
      if (a !== a.trim()) { showFormError('新密码前后有空格，请去掉', 'p_new'); return false; }
      if (a !== b) { showFormError('两次输入的新密码不一样', 'p_new2'); return false; }
      return post('/api/password', { current: cur, new: a })
        .then(function (r) {
          closeModal();
          // 密码改成功了，但记着初始密码的那个文件没删掉——得让人知道，
          // 否则明文密码会一直留在服务器上（审计 S-03）
          if (r && r.warn) {
            alert('密码已修改。\n\n但有一件事要处理：' + r.warn);
          } else {
            alert('密码已修改，所有已登录的页面都需要重新登录。');
          }
          location.href = '/';
        })
        .catch(function (e) { toast(e.message); });
    });
}

/* ---------- 弹窗 ---------- */
function modalProcessing() {
  var m = $('modal');
  return !!(m && !m.classList.contains('hidden') && (($('modalOk') || {})._busy || m._writes));
}
function formValues() {
  var values = {};
  Array.prototype.forEach.call($('modalBody').querySelectorAll('input,select,textarea'), function (el) {
    if (el.disabled || el.type === 'file' || el.dataset && el.dataset.exitIgnore) return;
    // 密码只记“是否填写”，不把密码值放进表单基准或任何缓存。
    values[el.id] = el.type === 'password' ? !!el.value :
      (el.type === 'checkbox' || el.type === 'radio' ? el.checked : el.value);
  });
  return values;
}
function modalDirty() {
  var m = $('modal');
  if (!m || m.classList.contains('hidden')) return false;
  if (['formFile', 'versionFile', 'invFile', 'invImageFile', 'drinkFile'].some(function (key) { return !!state[key]; })) return true;
  var current = formValues(), baseline = m._baseline || {}, keys = Object.keys(current);
  if (keys.length !== Object.keys(baseline).length) return true;
  // 分步表单会重排 DOM；只比较字段键和值，不将遍历顺序视为修改。
  return keys.some(function (key) {
    return !Object.prototype.hasOwnProperty.call(baseline, key) || current[key] !== baseline[key];
  });
}
function stocktakeDirty() {
  if (!$('stocktakePanel') || $('stocktakePanel').classList.contains('hidden')) return false;
  return (state.stocktake || []).some(function (r) {
    var input = $('st_' + r.id);
    return input && (String(input.value) !== String(r.quantity) || r.conflict || r.needsRecount);
  });
}
function hasUnsavedWork() { return modalDirty() || stocktakeDirty(); }
function showFormError(message, fieldId) {
  var m = $('modal'), feedback = $('modalFeedback');
  if (m && !m.classList.contains('hidden')) {
    if (!feedback) {
      feedback = document.createElement('p'); feedback.id = 'modalFeedback';
      feedback.className = 'form-feedback'; feedback.setAttribute('role', 'alert');
      $('modalBody').appendChild(feedback);
    }
    feedback.textContent = message; feedback.classList.remove('hidden');
    if (fieldId && $(fieldId)) {
      $(fieldId).setAttribute('aria-invalid', 'true');
      $(fieldId).setAttribute('aria-describedby', 'modalFeedback');
      $(fieldId).focus();
    }
  } else if ($('stocktakeFeedback') && state.view === 'inventory') {
    $('stocktakeFeedback').textContent = message;
  }
  toast(message);
}
function clearFormError() {
  var feedback = $('modalFeedback');
  if (feedback) feedback.textContent = '';
  Array.prototype.forEach.call($('modalBody').querySelectorAll('input,select,textarea'), function (el) {
    el.removeAttribute && el.removeAttribute('aria-invalid');
  });
}
function continueEditing() {
  var m = $('modal'), back = m._exitFocus;
  if ($('modalExitGuard')) $('modalExitGuard').remove();
  m._exitAction = null; m._exitFocus = null;
  if (back && document.body.contains(back)) back.focus();
}
function discardChanges() {
  var m = $('modal'), action = m._exitAction;
  continueEditing();
  state.userActionAllowed = true;
  try { if (action) action(); } finally { state.userActionAllowed = false; }
}
function requestUserExit(action, modalOnly) {
  if (modalProcessing()) { showFormError('正在处理，请等操作完成后再离开'); return false; }
  if (!(modalOnly ? modalDirty() : hasUnsavedWork()) || state.userActionAllowed) { action(); return true; }
  var m = $('modal');
  if (m.classList.contains('hidden')) {
    openModal('还有未保存内容', '<p>盘点实盘数尚未提交，离开会放弃本次填写。</p>', function () {
      closeModal(); clearStocktake(); action();
    }, [{ label: '继续填写', fn: closeModal }], '放弃并离开');
    $('modalCancel').textContent = '继续填写';
    return false;
  }
  if ($('modalExitGuard')) return false;
  m._exitAction = action; m._exitFocus = document.activeElement;
  var guard = document.createElement('section'); guard.id = 'modalExitGuard';
  guard.className = 'exit-guard'; guard.setAttribute('role', 'alert');
  guard.innerHTML = '<p>还有未保存内容，离开会放弃本次填写。</p>' +
    '<div class="row-actions"><button id="modalExitContinue" class="btn primary" type="button">继续填写</button>' +
    '<button id="modalExitDiscard" class="btn danger" type="button">放弃并离开</button></div>';
  $('modalBox').appendChild(guard);
  // 在原弹窗里确认；继续填写不替换 DOM，也不释放文件或预览。
  var buttons = guard.querySelectorAll('button');
  if (buttons[0]) { buttons[0].onclick = continueEditing; buttons[0].focus(); }
  if (buttons[1]) buttons[1].onclick = discardChanges;
  return false;
}
function userCloseModal() { return requestUserExit(closeModal, true); }
function guardedModalAction(fn) {
  return function () {
    var self = this, args = arguments;
    if (!state.userActionAllowed && (modalDirty() || modalProcessing())) {
      return requestUserExit(function () { closeModal(); fn.apply(self, args); }, true);
    }
    return fn.apply(self, args);
  };
}
function acceptModalResponse(reopen) {
  if (!modalDirty() && !modalProcessing()) return true;
  requestUserExit(function () { closeModal(); reopen(); }, true);
  return false;
}
function openModal(title, html, onSubmit, extraButtons, okText) {
  if (!state.userActionAllowed && (modalDirty() || modalProcessing())) {
    return requestUserExit(function () { closeModal(); openModal(title, html, onSubmit, extraButtons, okText); });
  }
  // 记住打开它之前焦点在哪儿，关的时候好还回去
  $('modal')._prevFocus = document.activeElement;
  $('modal')._prevScroll = window.scrollY || 0;
  $('modal')._prevBodyOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  $('modal')._stamp = ($('modal')._stamp || 0) + 1;
  state.activeFormToken = null;
  var stamp = $('modal')._stamp;
  $('modal')._writes = 0;
  $('modal')._exitAction = null;
  if ($('modalExitGuard')) $('modalExitGuard').remove();
  releaseFilePreviews();
  $('modalTitle').textContent = title;
  $('modalBody').innerHTML = html;
  $('modal')._baseline = formValues();
  var ok = $('modalOk'), cancel = $('modalCancel'), extra = $('modalExtra');
  ok.classList.toggle('hidden', !onSubmit);
  // 按钮文字每次都要重设：不然上一次改成"确定删除"，这次开别的弹窗还留着
  ok.textContent = okText || '保存';
  cancel.textContent = onSubmit ? '取消' : '关闭';
  extra.innerHTML = '';
  (extraButtons || []).forEach(function (b) {
    var el = document.createElement('button');
    el.className = b.cls || 'btn'; el.textContent = b.label;
    el.onclick = b.fn; extra.appendChild(el);
  });
  $('modal').classList.remove('hidden');
  // 打开之后：把焦点请进弹窗、标签跟控件对上号、键盘能操作
  _afterModalOpen();
  ok._busy = false;
  ok.disabled = false;
  ok.onclick = function () {
    if (!onSubmit) { closeModal(); return; }
    if (ok._busy) { return; }                 // 连点保护：处理中再点没反应
    clearFormError();
    var r = onSubmit();
    if (r === false) { return; }              // 明确返回 false：填得不对，弹窗留着
    // 提交函数把请求 promise 返回出来的话，这里就把按钮锁住、显示"处理中"，
    // 免得网络慢的时候看着没动静以为没点上。
    if (r && typeof r.then === 'function') {
      ok._busy = true; ok.disabled = true;
      var old = ok.textContent; ok.textContent = '处理中…';
      r.catch(function () { }).then(function () {
        if ($('modal')._stamp !== stamp) return;
        ok._busy = false; ok.disabled = false; ok.textContent = old;
      });
    }
  };
}
/* 弹窗对键盘/读屏的支持（审计 10/03 S-09）：
   以前打开弹窗后焦点还留在背景那个按钮上，按 Tab 直接跑到遮罩后面的内容里，
   读屏软件也念不出「这是个弹窗、这一格填的什么」。现在补三件事：
   1. 打开时焦点进弹窗、关闭时还给刚才那个按钮；2. Tab 只在弹窗里绕；
   3. Esc 关掉；每个可见标签都和它后面的控件用 for/id 绑在一起。 */
var FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),'                 + 'textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

function _visibleFocusable(root) {
  var list = root.querySelectorAll(FOCUSABLE);
  var out = [];
  for (var i = 0; i < list.length; i++) {
    // 藏起来的东西（比如手机拍照那个隐藏 input）不能进 Tab 顺序
    if (list[i].offsetParent === null) continue;
    out.push(list[i]);
  }
  return out;
}

function _linkModalLabels() {
  // 页面上的 <label> 都是挨着控件写的，没有 for/id。这里统一给它俩牵上线，
  // 读屏软件才会念出「资料名称，编辑框」而不是光秃秃一个「编辑框」。
  var labels = $('modalBody').querySelectorAll('label');
  for (var i = 0; i < labels.length; i++) {
    var lb = labels[i];
    if (lb.getAttribute('for')) continue;              // 已经有主儿了就别抢
    var box = lb.parentNode;
    if (!box) continue;
    var ctl = box.querySelector('input,select,textarea');
    if (!ctl || ctl.disabled || ctl.type === 'hidden') continue;
    if (ctl.offsetParent === null) continue;           // 看不见的控件不关联
    if (!ctl.id) ctl.id = 'mf_' + i + '_' + Math.random().toString(36).slice(2, 7);
    lb.setAttribute('for', ctl.id);
  }
}

function _modalKeys(ev) {
  var m = $('modal');
  if (m.classList.contains('hidden')) return;
  if (ev.key === 'Escape') {
    ev.preventDefault();
    if ($('modalExitGuard')) continueEditing(); else userCloseModal();
    return;
  }
  if (ev.key !== 'Tab') return;
  var list = _visibleFocusable(m);
  if (!list.length) return;
  var first = list[0], last = list[list.length - 1];
  var at = document.activeElement;
  // 焦点停在弹窗框子上（刚打开时就是这样）：Tab 进第一个，Shift+Tab 进最后一个
  if (at === $('modalBox')) {
    ev.preventDefault();
    (ev.shiftKey ? last : first).focus();
    return;
  }
  if (list.indexOf(at) === -1) { ev.preventDefault(); first.focus(); return; }
  if (ev.shiftKey && at === first) { ev.preventDefault(); last.focus(); }
  else if (!ev.shiftKey && at === last) { ev.preventDefault(); first.focus(); }
}

function _afterModalOpen() {
  var m = $('modal');
  if (m._prevFocus === undefined) { m._prevFocus = null; }
  if (!m._keysOn) {
    document.addEventListener('keydown', _modalKeys);
    m._keysOn = true;
  }
  _linkModalLabels();
  // 稍微等一下再挪焦点：内容刚塞进去，有些浏览器的输入框还没排好版。
  // 先进到弹窗这个框子本身而不是第一个输入框——不然手机上一打开就弹出键盘，
  // 把整个表单糊住；从框子 Tab 一步就能到第一个要填的地方。
  setTimeout(function () {
    if (m.classList.contains('hidden')) return;
    var box = $('modalBox');
    if (box) { try { box.focus(); return; } catch (e) { } }
    var first = _visibleFocusable($('modalBody'))[0] || _visibleFocusable(m)[0] || $('modalCancel');
    if (first) { try { first.focus(); } catch (e) { } }
  }, 0);
}
function closeModal() {
  var m = $('modal');
  if (!m) return;
  m._stamp = (m._stamp || 0) + 1;
  state.activeFormToken = null;
  m._baseline = null;
  m._writes = 0;
  m._exitAction = null;
  if ($('modalExitGuard')) $('modalExitGuard').remove();
  releaseFilePreviews();
  state.formFile = null;
  state.versionFile = null;
  state.invFile = null;
  state.invImageFile = null;
  state.drinkFile = null;
  state.singleStocktake = null;
  m.classList.add('hidden');
  if (m._keysOn) { document.removeEventListener('keydown', _modalKeys); m._keysOn = false; }
  // 焦点还给刚才那个按钮：不然键盘用户会被扔回页面最开头，白按半天
  var back = m._prevFocus;
  var scroll = Number(m._prevScroll || 0);
  document.body.style.overflow = m._prevBodyOverflow || '';
  m._prevBodyOverflow = '';
  m._prevScroll = 0;
  m._prevFocus = null;
  if (back && document.body.contains(back)) { try { back.focus(); } catch (e) { } }
  try { window.scrollTo(0, scroll); } catch (e) { }
}

/* ---------- 酒水单（仅管理员） ---------- */
function loadDrinks() {
  var box = $('drinkList');
  var requestToken = {};
  state.drinkRequest = requestToken;
  renderListState(box, 'loading', '正在加载…');
  api('/api/drinks').then(function (d) {
    if (state.drinkRequest !== requestToken || state.view !== 'drinks') return;
    var rows = d.pages || [];
    box.innerHTML = rows.length ? rows.map(function (p, i) {
      return '<tr>' +
        '<td data-label="图"><img src="' + esc(p.thumb_url || '') + '" alt="' + esc(p.title || '酒单图片') + '" style="width:52px;height:68px;' +
        'object-fit:contain;border-radius:6px;display:block"></td>' +
        '<td data-label="标题">' + esc(p.title || '（未命名）') + '</td>' +
        '<td data-label="上传时间">' + esc((p.uploaded_at || '').slice(0, 16)) + '</td>' +
        '<td data-label="操作"><div class="row-actions">' +
          '<button class="btn" onclick="replaceDrink(' + p.id + ')">换图</button>' +
          '<button class="btn" onclick="moveDrink(' + p.id + ',\'up\')">↑</button>' +
          '<button class="btn" onclick="moveDrink(' + p.id + ',\'down\')">↓</button>' +
          '<button class="btn danger" onclick="deleteDrink(' + p.id + ')">删除</button>' +
        '</div></td></tr>';
    }).join('') : '<tr><td class="empty">还没有酒单页面，点右上角「上传新的一页」</td></tr>';
  }).catch(function (e) {
    if (state.drinkRequest !== requestToken) return;
    renderListState(box, 'error', e.message || '酒水单加载失败', loadDrinks);
    toast(e.message);
  });
}

var drinkBusy = false;

function postDrinkForm(url, method) {
  if (!state.drinkFile) { showFormError('请先选择一张图片'); return false; }
  var file = state.drinkFile;
  var stamp = $('modal')._stamp;
  // 弹窗统一负责锁住提交按钮，api() 也会挡住相同请求。
  if (drinkBusy) { return false; }
  drinkBusy = true;
  var fd = new FormData();
  fd.append('file', file);
  fd.append('title', $('d_title').value);
  return api(url, { method: method, headers: SAFE_HEADER, body: fd })
    .then(function () {
      var active = currentModal(stamp);
      if (active) { state.drinkFile = null; closeModal(); loadDrinks(); }
      toast(active ? '已保存' : '此前酒单操作已保存');
    })
    .catch(function (e) { toast(e.message); })
    .then(function () {
      drinkBusy = false;
      return false;
    });
}

function showDrinkUpload() {
  state.drinkFile = null;
  openModal('上传新的一页酒单',
    '<div class="field file-picker"><label>选择图片 *（JPG / PNG）</label>' +
    '<input type="file" id="d_file" accept="image/jpeg,image/png" onchange="onDrinkFile(this)">' +
    '<div id="d_preview"></div></div>' +
    '<div class="field"><label>这一页的标题（会在客人公开页显示，可留空）</label>' +
    '<input id="d_title" placeholder="洋酒"></div>' +
    '<p class="hint">新的一页会排在最后，可以用 ↑ ↓ 调整顺序。</p>',
    function () { return postDrinkForm('/api/drink-pages', 'POST'); });
}

function replaceDrink(id) {
  var stamp = $('modal')._stamp;
  api('/api/drinks').then(function (d) {
    if ($('modal')._stamp !== stamp) return;
    if (!acceptModalResponse(function () { replaceDrink(id); })) return;
    var p = (d.pages || []).filter(function (x) { return x.id === id; })[0];
    if (!p) { toast('这一页已经不在了'); return; }
    state.drinkFile = null;
    openModal('替换这一页的图',
      LexiuFiles.renderSaved({ original_name: p.original_name || p.title || '酒单图片.jpg',
        web_url: p.url || p.thumb_url, file_size: p.file_size }, { imageOnly: true }) +
      '<div class="field file-picker"><label>选择新图片 *（JPG / PNG）</label>' +
      '<input type="file" id="d_file" accept="image/jpeg,image/png" onchange="onDrinkFile(this)">' +
      '<div id="d_preview"></div></div>' +
      '<div class="field"><label>标题（会在客人公开页显示）</label><input id="d_title" value="' + esc(p.title || '') + '"></div>' +
      '<p class="hint">传上来就直接替换，客人那边刷新就能看到新的。</p>',
      function () { return postDrinkForm('/api/drink-pages/' + id, 'PUT'); });
  }).catch(function (e) { toast(e.message); });
}
function onDrinkFile(input) {
  selectedFile(input, 'd_preview', 'drink', 'drinkFile', ['d_file']);
}

function moveDrink(id, dir) {
  if (drinkBusy) { return; }
  drinkBusy = true;
  post('/api/drink-pages/' + id + '/move', { dir: dir })
    .then(function () { loadDrinks(); })
    .catch(function (e) { toast(e.message); })
    .then(function () { drinkBusy = false; });
}

function deleteDrink(id) {
  api('/api/drinks').then(function (d) {
    var p = (d.pages || []).filter(function (x) { return x.id === id; })[0];
    if (!p) { toast('这一页已经不在了'); return; }
    if (!confirm('确定删除这一页「' + (p.title || '未命名') + '」？删掉后客人那边就看不到了。')) return;
    del('/api/drink-pages/' + id)
      .then(function () { toast('已删除'); loadDrinks(); })
      .catch(function (e) { toast(e.message); });
  }).catch(function (e) { toast(e.message); });
}

function editDrinkNote() {
  var stamp = $('modal')._stamp;
  api('/api/drinks').then(function (d) {
    if ($('modal')._stamp !== stamp) return;
    if (!acceptModalResponse(function () { editDrinkNote(); })) return;
    openModal('改酒水单底部的说明',
      '<div class="field"><label>说明文字</label><input id="d_note" value="' +
      esc(d.note || '') + '" placeholder="例如：以上价格含厢座服务费"></div>' +
      '<p class="hint">显示在客人页面最下面，最多 200 个字，留空就不显示。</p>',
      function () {
        return post('/api/drink-note', { note: $('d_note').value })
          .then(function () { closeModal(); toast('已保存'); })
          .catch(function (e) { toast(e.message); });
      });
  }).catch(function (e) { toast(e.message); });
}

/* ---------- 初始化 ---------- */
// 用户打开另一个操作前检查当前填写；程序保存成功后的 closeModal 可直接收尾。
showCertForm = guardedModalAction(showCertForm);
showHealthForm = guardedModalAction(showHealthForm);
showAssetForm = guardedModalAction(showAssetForm);
showInvForm = guardedModalAction(showInvForm);
showUserForm = guardedModalAction(showUserForm);
changePassword = guardedModalAction(changePassword);
showDrinkUpload = guardedModalAction(showDrinkUpload);
replaceDrink = guardedModalAction(replaceDrink);
editDrinkNote = guardedModalAction(editDrinkNote);
viewPhoto = guardedModalAction(viewPhoto);
openCert = guardedModalAction(openCert);
certEdit = guardedModalAction(certEdit);
askDeleteCert = guardedModalAction(askDeleteCert);
openInv = guardedModalAction(openInv);
deleteInv = guardedModalAction(deleteInv);
removeInvImage = guardedModalAction(removeInvImage);
invIn = guardedModalAction(invIn);
invOut = guardedModalAction(invOut);
invCount = guardedModalAction(invCount);
moveAsset = guardedModalAction(moveAsset);
review = guardedModalAction(review);
reviewOne = guardedModalAction(reviewOne);

function bindAppAccordion() {
  var triggers = document.querySelectorAll('.app-accordion-trigger');
  if (!triggers.length) return;
  function setOpen(trigger, open) {
    var panel = document.getElementById(trigger.getAttribute('aria-controls'));
    if (!panel) return;
    trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    trigger.setAttribute('data-open', open ? 'true' : 'false');
    panel.hidden = !open;
    panel.setAttribute('data-open', open ? 'true' : 'false');
  }
  triggers.forEach(function (trigger) {
    setOpen(trigger, false);
    trigger.addEventListener('click', function () {
      var open = trigger.getAttribute('aria-expanded') !== 'true';
      triggers.forEach(function (other) {
        if (other !== trigger) setOpen(other, false);
      });
      setOpen(trigger, open);
    });
  });
}

document.addEventListener('DOMContentLoaded', function () {
  bindLogin();
  if ($('loginForm')) return;
  bindAppAccordion();
  document.querySelectorAll('.mod-card[data-mod]').forEach(function (b) {
    b.onclick = function () { go(b.dataset.mod); };
  });
  // 退出：不管接口成不成功都跳回首页，避免出现"点了没反应"
  $('logoutBtn').onclick = function () {
    requestUserExit(function () {
      closeModal(); clearStocktake();
      post('/api/logout').catch(function () { }).then(function () { location.href = '/'; });
    });
  };
  var mobileLogout = $('mobileLogoutBtn');
  if (mobileLogout) mobileLogout.onclick = function () { $('logoutBtn').click(); };
  $('modalCancel').onclick = userCloseModal;
  $('modalClose').onclick = userCloseModal;
  $('modal').addEventListener('click', function (e) { if (e.target === $('modal')) userCloseModal(); });
  window.addEventListener('beforeunload', function (e) {
    if (!hasUnsavedWork() && !modalProcessing()) return;
    e.preventDefault(); e.returnValue = '';
  });

  api('/api/me').then(function (me) {
    state.me = me;
    $('meName').textContent = me.name + (me.role === 'admin' ? '（管理员）' : '');
    if ($('mobileMeName')) $('mobileMeName').textContent = me.name || '我的账号';
    if ($('mobileMeRole')) $('mobileMeRole').textContent = me.role === 'admin' ? '管理员账号' : '普通员工账号';
    if ($('mobileMeAvatar')) $('mobileMeAvatar').textContent = (me.name || '乐').charAt(0);
    document.querySelectorAll('.admin-only').forEach(function (el) {
      el.classList.toggle('hidden', me.role !== 'admin');
    });
    if ($('drinkUrl')) $('drinkUrl').textContent = location.origin + '/drinks';
    go(me.role === 'admin' && new URLSearchParams(location.search).get('view') === 'review' ? 'review' : 'dashboard');
  });
});
