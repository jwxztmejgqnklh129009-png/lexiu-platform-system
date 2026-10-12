(function () {
  'use strict';
  function blank(replacesId) {
    return { key: crypto.randomUUID(), batch_token: null, batch_index: null,
      file: null, preview_url: null, phase: 'empty', error: '', replaces_id: replacesId || null };
  }
  function ensureInitial(s) {
    if (!s.saved.length && !s.drafts.length) s.drafts.push(blank());
    return s;
  }
  function addBlank(s) {
    if (s.drafts.some(function (d) { return d.phase === 'empty'; })) return { ok: false, error: '请先填入当前空框的照片' };
    s.drafts.push(blank()); return { ok: true };
  }
  function selectFiles(s, files, key, replacesId) {
    files = Array.from(files || []);
    if (!files.length) return { ok: true };
    var position = key ? s.drafts.findIndex(function (d) { return d.key === key; }) : -1;
    if (position >= 0 && (s.drafts[position].attempted || s.drafts[position].phase === 'sending' || s.drafts[position].batch_token)) {
      return { ok: false, error: '该选择已提交过，请保留原图准确重试；重新选图需移除后另加' };
    }
    if (position < 0 && !replacesId) position = s.drafts.findIndex(function (d) { return d.phase === 'empty' && !d.replaces_id; });
    files.forEach(function (file, index) {
      var d = blank(replacesId); d.file = file; d.phase = 'selected'; d.preview_url = URL.createObjectURL(file);
      if (index === 0 && position >= 0) {
        if (s.drafts[position].preview_url) URL.revokeObjectURL(s.drafts[position].preview_url);
        d.replaces_id = s.drafts[position].replaces_id;
        s.drafts[position] = d;
      } else s.drafts.push(d);
    });
    return { ok: true };
  }
  function moveDraft(s, key, delta) {
    var i = s.drafts.findIndex(function (d) { return d.key === key; });
    var j = i + delta;
    if (i < 0 || j < 0 || j >= s.drafts.length || Math.abs(delta) !== 1) return { ok: false };
    if ([s.drafts[i], s.drafts[j]].some(function (d) { return d.attempted || d.batch_token || d.phase === 'sending' || d.replaces_id; })) return { ok: false, error: '已发送批次的页序已固定，重试不能重排' };
    var d = s.drafts[i]; s.drafts[i] = s.drafts[j]; s.drafts[j] = d; return { ok: true };
  }
  function removeDraft(s, key) {
    var i = s.drafts.findIndex(function (d) { return d.key === key; });
    if (i < 0 || s.drafts[i].phase === 'sending') return { ok: false };
    if (s.drafts[i].preview_url) URL.revokeObjectURL(s.drafts[i].preview_url);
    s.drafts.splice(i, 1); return { ok: true };
  }
  function prepareBatch(s) {
    var fresh = s.drafts.filter(function (d) { return d.file && !d.replaces_id && !d.batch_token; });
    if (fresh.length) {
      var batch = crypto.randomUUID();
      fresh.forEach(function (d, i) { d.batch_token = batch; d.batch_index = i + 1; });
    }
  }
  var FIRE_SOURCE_MAX_PIXELS = 60 * 1000 * 1000;
  function imagePixelError(width, height) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return '无法读取照片尺寸，请换一张 JPG／PNG 重试';
    return width * height > FIRE_SOURCE_MAX_PIXELS ? '照片像素超过 6000 万，请先裁剪或降低分辨率后重试' : '';
  }
  function readImageSize(file) {
    if (file && Number.isFinite(file.width) && Number.isFinite(file.height)) {
      return Promise.resolve({ width: file.width, height: file.height });
    }
    if (typeof createImageBitmap === 'function') {
      return createImageBitmap(file).then(function (bitmap) {
        var size = { width: bitmap.width, height: bitmap.height };
        if (bitmap.close) bitmap.close();
        return size;
      });
    }
    return new Promise(function (resolve, reject) {
      if (typeof Image === 'undefined' || !URL.createObjectURL) return reject(new Error('无法读取照片尺寸'));
      var image = new Image(), url = URL.createObjectURL(file);
      image.onload = function () { URL.revokeObjectURL(url); resolve({ width: image.naturalWidth, height: image.naturalHeight }); };
      image.onerror = function () { URL.revokeObjectURL(url); reject(new Error('无法读取照片尺寸')); };
      image.src = url;
    });
  }
  async function request(url, options) {
    options = Object.assign({ credentials: 'same-origin' }, options || {});
    var controller = (typeof AbortController === 'function' && !options.signal) ? new AbortController() : null;
    var timeout = Number(options.timeoutMs || 30000);
    if (controller) options.signal = controller.signal;
    var timer = controller ? setTimeout(function () { controller.abort(); }, timeout) : null;
    var response;
    try { response = await fetch(url, options); }
    catch (error) {
      if (error && error.name === 'AbortError') throw new Error('请求超时，请检查网络后刷新核对，再重试未成功照片');
      throw new Error('网络连接失败，请检查网络后刷新核对，再重试未成功照片');
    }
    finally { if (timer) clearTimeout(timer); }
    var data = {};
    try { data = await response.json(); }
    catch (parseError) {
      if (!response.ok) data = { error: response.status === 413 ? '上传内容过大，请压缩照片后重试' : '服务器返回了无法识别的结果，请刷新核对后重试' };
    }
    if (!response.ok) {
      var error = new Error(data.error || ('请求失败 ' + response.status));
      error.status = response.status; error.data = data; throw error;
    }
    return data;
  }
  async function sendQueue(s, code, progress, reconcile) {
    if (s.uploading) return { success: 0, failed: 0, errors: [] };
    s.uploading = true;
    prepareBatch(s);
    var queue = s.drafts.filter(function (d) { return d.file && (d.phase === 'selected' || d.phase === 'failed'); });
    var result = { success: 0, failed: 0, errors: [] };
    try {
    for (var i = 0; i < queue.length; i++) {
      var d = queue[i]; d.attempted = true; d.phase = 'sending'; d.error = '';
      if (progress) progress(i, queue.length, d);
      try {
        var form = new FormData(); form.set('file', d.file); form.set('client_token', d.key);
        if (!d.replaces_id) { form.set('batch_token', d.batch_token); form.set('batch_index', String(d.batch_index)); }
        var url = d.replaces_id ? '/api/fire/photos/' + d.replaces_id + '/replacement' : '/api/fire/directories/' + encodeURIComponent(code) + '/photos';
        var data = await request(url, { method: 'POST', credentials: 'same-origin', headers: { 'X-Requested-With': 'lexiu' }, body: form });
        if (!data.photo || !data.photo.id) throw new Error('响应未确认照片记录，请保留此选择并准确重试');
        if (data.photo.status === 'approved' && d.replaces_id) s.saved = s.saved.filter(function (p) { return p.id !== d.replaces_id; });
        if (!s.saved.some(function (p) { return p.id === data.photo.id; })) s.saved.push(data.photo);
        URL.revokeObjectURL(d.preview_url); s.drafts.splice(s.drafts.indexOf(d), 1); result.success++;
      } catch (error) {
        d.phase = 'failed'; d.error = error.message; result.failed++; result.errors.push(error);
        if (reconcile && (!error.status || error.status === 409)) {
          try { await reconcile(); }
          catch (refreshError) { d.error += '；列表核对失败：' + refreshError.message; }
        }
      }
      if (progress) progress(i + 1, queue.length, d);
      if ((i + 1) % 10 === 0 && i + 1 < queue.length) await new Promise(function (resolve) { setTimeout(resolve, 0); });
    }
    return result;
    } finally {
      queue.forEach(function (d) { if (d.phase === 'sending') { d.phase = 'failed'; d.error = '处理已中断，请刷新核对后准确重试'; } });
      s.uploading = false;
    }
  }
  window.FireBookModel = { ensureInitial: ensureInitial, addBlank: addBlank, selectFiles: selectFiles,
    moveDraft: moveDraft, removeDraft: removeDraft, prepareBatch: prepareBatch, sendQueue: sendQueue,
    imagePixelError: imagePixelError, readImageSize: readImageSize };

  document.addEventListener('DOMContentLoaded', function () {
    if (!document.getElementById('firePhotos')) return;
    var s = { saved: [], drafts: [] }, code = null, name = '', me, directories = [], requests = [], baseIds = [], targetIds = [], busy = true, picker, zoomTrigger = null;
    function $(id) { return document.getElementById(id); }
    function el(tag, cls, text) { var node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; }
    function status(text) {
      $('fireStatus').textContent = text;
      if ($('fireCatalogStatus')) $('fireCatalogStatus').textContent = text;
    }
    function changedOrder() { return JSON.stringify(baseIds) !== JSON.stringify(targetIds); }
    function unfinished() { return s.drafts.some(function (d) { return d.file; }) || changedOrder(); }
    function button(text, action, disabled) {
      var b = el('button', '', text); b.type = 'button'; b.disabled = busy || !!disabled; b.onclick = action; return b;
    }
    function preview(url, label) {
      var box = el('div', 'fire-paper'), title = el('div', 'fire-paper-title', code + ' ' + name), img = el('img');
      img.src = url; img.alt = label; img.loading = 'lazy'; img.tabIndex = 0; img.setAttribute('role', 'button'); img.setAttribute('aria-label', label + '，打开大图');
      box.append(title, img, el('div', 'fire-paper-footer', label));
      img.onclick = function () { zoomTrigger = img; $('fireZoomImage').src = url; $('fireZoom').showModal(); setTimeout(function () { $('fireZoomClose').focus(); }, 0); };
      img.onkeydown = function (event) { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); img.click(); } };
      return box;
    }
    function choose(mode, key, replacesId) {
      if (busy) return;
      picker = { key: key, replacesId: replacesId };
      var input = $(mode === 'camera' ? 'fireCamera' : 'fireUpload');
      input.multiple = mode !== 'camera' && !key && !replacesId;
      if (key) { var d = s.drafts.find(function (x) { return x.key === key; }); input.multiple = mode !== 'camera' && d && d.phase === 'empty'; }
      input.value = ''; input.click();
    }
    function renderDirectories() {
      var groupContainer = $('fireDirectoryGroups');
      groupContainer.replaceChildren();
      var query = (($('fireDirectorySearch') && $('fireDirectorySearch').value) || '').trim().toLowerCase();
      var visible = directories.filter(function (directory) {
        return !query || (directory.code + ' ' + directory.name).toLowerCase().indexOf(query) >= 0;
      });
      var completed = directories.filter(function (directory) { return directory.approved_count > 0; }).length;
      var total = directories.length || 40;
      var progressValue = $('fireCatalogProgressValue');
      var progressBar = $('fireCatalogProgressBar');
      var progressTrack = $('fireCatalogProgressTrack');
      if (progressValue) progressValue.textContent = completed + '/' + total;
      if (progressBar) progressBar.style.width = (total ? Math.min(100, completed * 100 / total) : 0) + '%';
      if (progressTrack) progressTrack.setAttribute('aria-valuenow', completed);
      var aItems = visible.filter(function (directory) { return directory.code.charAt(0) === 'A'; });
      var bItems = visible.filter(function (directory) { return directory.code.charAt(0) === 'B'; });
      $('fireCatalogSectionTitle').textContent = query ? '搜索结果' : '固定目录（A01 - A18）';
      $('fireCatalogSectionCount').textContent = '共 ' + (query ? visible.length : aItems.length) + ' 项';
      [['A', '固定目录（A01 - A18）', aItems], ['B', '固定目录（B01 - B22）', bItems]].forEach(function (group) {
        if (!group[2].length) return;
        var section = el('section', 'fire-directory-group fire-directory-group-' + group[0].toLowerCase());
        var title = el('div', 'fire-directory-group-heading');
        title.append(el('h2', '', group[1]), el('span', '', '共 ' + group[2].length + ' 项'));
        var list = el('div', 'fire-directory-list'); list.setAttribute('role', 'list');
        group[2].forEach(function (directory) {
          var b = button('', function () { openDirectory(directory.code); }); b.className = 'fire-directory-row' + (directory.code === code ? ' on' : '');
          b.setAttribute('aria-current', directory.code === code ? 'page' : 'false');
          var stateParts = [];
          if (directory.approved_count) stateParts.push(directory.approved_count + ' 张已生效');
          if (directory.pending_count) stateParts.push((me && me.role === 'staff' ? '我的待审 ' : '待审核 ') + directory.pending_count + ' 张');
          var state = stateParts.length ? stateParts.join(' · ') : '未上传';
          b.append(el('span', 'fire-directory-marker', ''), el('strong', '', directory.code), el('span', 'fire-directory-name', directory.name), el('span', 'fire-directory-state', state), el('span', 'fire-directory-arrow', '›'));
          list.append(b);
        });
        section.append(title, list); groupContainer.append(section);
      });
      if (!visible.length) groupContainer.append(el('p', 'fire-empty-catalog', '没有匹配的目录，请换一个编号或名称'));
    }
    function showCatalog() {
      $('fireCatalogView').classList.remove('hidden');
      $('fireDetailView').classList.add('hidden');
      setTimeout(function () { if ($('fireDirectorySearch')) $('fireDirectorySearch').focus(); }, 0);
    }
    function showDetail() {
      $('fireCatalogView').classList.add('hidden');
      $('fireDetailView').classList.remove('hidden');
      setTimeout(function () { if ($('fireDirectoryTitle')) $('fireDirectoryTitle').focus(); }, 0);
    }
    function render() {
      $('fireDirectoryTitle').textContent = code + ' ' + name;
      $('fireDirectoryCount').textContent = baseIds.length + ' 张已生效 · ' + s.saved.filter(function (p) { return p.status === 'pending'; }).length + ' 张可见待审';
      $('firePrintCurrent').href = '/fire/print?scope=' + encodeURIComponent(code);
      $('fireAddBlank').disabled = busy; $('fireRefresh').disabled = busy;
      $('fireSubmit').disabled = busy || !s.drafts.some(function (d) { return d.file; });
      $('fireSubmit').textContent = s.drafts.some(function (d) { return d.phase === 'failed'; }) ? '提交／重试未成功照片' : '提交照片';
      $('fireSaveOrder').disabled = busy || !changedOrder();
      var container = $('firePhotos'); container.replaceChildren();
      var ordered = targetIds.map(function (id) { return s.saved.find(function (p) { return p.id === id; }); }).filter(Boolean);
      ordered.forEach(function (p, i) {
        var card = el('article', 'fire-card'); card.append(preview(p.web_url, '第 ' + (i + 1) + ' 张／共 ' + ordered.length + ' 张'));
        card.append(el('p', 'fire-state approved', '已生效 · 照片 #' + p.id), el('p', 'fire-meta', p.uploaded_by + ' · ' + p.uploaded_at));
        var actions = el('div', 'fire-card-actions');
        actions.append(button('上移', function () { var id = targetIds[i - 1]; targetIds[i - 1] = p.id; targetIds[i] = id; render(); }, i === 0),
          button('下移', function () { var id = targetIds[i + 1]; targetIds[i + 1] = p.id; targetIds[i] = id; render(); }, i === ordered.length - 1),
          button('申请更换' + (me.role === 'admin' ? '（直接生效）' : ''), function () { choose('upload', null, p.id); }, s.drafts.some(function (d) { return d.replaces_id === p.id; })));
        if (me.role === 'admin') actions.append(button('删除此照片', function () { deletePhoto(p); }));
        card.append(actions); container.append(card);
      });
      s.saved.filter(function (p) { return p.status === 'pending' || p.status === 'rejected'; }).forEach(function (p) {
        var card = el('article', 'fire-card');
        if (p.web_url) card.append(preview(p.web_url, p.replaces_photo_id ? '更换照片待审：原照片 #' + p.replaces_photo_id : '新增照片待审'));
        card.append(el('p', 'fire-state', (p.status === 'pending' ? '待管理员确认' : '已退回') + ' · 照片 #' + p.id), el('p', 'fire-meta', p.uploaded_by + ' · ' + p.uploaded_at));
        if (p.reject_reason) card.append(el('p', 'fire-error', '退回原因：' + p.reject_reason));
        if (me.role === 'admin') card.append(button('删除此照片', function () { deletePhoto(p); }));
        container.append(card);
      });
      s.drafts.forEach(function (d, i) {
        var card = el('article', 'fire-card fire-draft');
        if (d.file) card.append(preview(d.preview_url, d.replaces_id ? '更换预览：原照片 #' + d.replaces_id : '本次选图第 ' + (i + 1) + ' 张'));
        else {
          var empty = el('div', 'fire-empty'); empty.append(el('p', '', '第 ' + (baseIds.length + i + 1) + ' 张'), button('拍照', function () { choose('camera', d.key); }), button('上传', function () { choose('upload', d.key); })); card.append(empty);
        }
        card.append(el('p', 'fire-state', d.phase === 'sending' ? '正在提交' : (d.phase === 'failed' ? '提交未成功 · 保留选择可重试' : '待提交')));
        if (d.file) card.append(el('p', 'fire-meta', d.file.name));
        if (d.error) card.append(el('p', 'fire-error', d.error));
        var controls = el('div', 'fire-card-actions');
        if (d.file) controls.append(button('重选', function () { choose('upload', d.key, d.replaces_id); }, !!d.batch_token || d.phase === 'failed'),
          button('上移', function () { moveDraft(s, d.key, -1); render(); }, i === 0 || !!d.batch_token || !!d.replaces_id),
          button('下移', function () { moveDraft(s, d.key, 1); render(); }, i === s.drafts.length - 1 || !!d.batch_token || !!d.replaces_id));
        controls.append(button('移除本地选择', function () {
          if (d.phase === 'failed' && !window.confirm('只移除本地选择。网络中断时服务器可能已保存，请先刷新核对；此操作不会删除服务器照片。继续移除？')) return;
          removeDraft(s, d.key); ensureInitial(s); render();
        }));
        card.append(controls); container.append(card);
      });
      $('fireRequests').replaceChildren();
      requests.forEach(function (r) {
        var box = el('div', 'fire-request'); box.append(el('strong', '', '页序申请 #' + r.id + ' · ' + ({ pending: '待管理员确认', approved: '已通过', rejected: '已退回' }[r.status] || r.status)),
          el('p', '', '提交时原序：' + r.base_photo_ids.join(' → ')), el('p', '', '申请顺序：' + r.photo_ids.join(' → ')));
        if (r.conflict && r.status === 'pending') box.append(el('p', 'fire-error', '当前照片或页序已变化，需要重新确认，不能覆盖后续操作。'));
        if (r.reject_reason) box.append(el('p', 'fire-error', '退回原因：' + r.reject_reason));
        $('fireRequests').append(box);
      });
    }
    async function refreshPhotos() {
      if (!code) return;
      var data = await request('/api/fire/directories/' + encodeURIComponent(code) + '/photos');
      s.saved = data.photos; baseIds = data.current_photo_ids.slice(); targetIds = baseIds.slice(); requests = data.order_requests; name = data.directory.name;
      ensureInitial(s); render();
    }
    async function loadDirectories() {
      directories = (await request('/api/fire/directories')).items;
      renderDirectories();
    }
    async function refresh() {
      await refreshPhotos();
      await loadDirectories();
    }
    async function openDirectory(next) {
      if (busy || next === code) return;
      if (unfinished() && !window.confirm('切换目录会丢失未完成的本地选择或页序调整，服务器照片不会删除。继续？')) return;
      s.drafts.slice().forEach(function (d) { removeDraft(s, d.key); }); s.saved = []; code = next;
      baseIds = []; targetIds = []; requests = []; name = (directories.find(function (d) { return d.code === next; }) || {}).name || '';
      busy = true; showDetail(); status('正在加载目录…'); renderDirectories(); render();
      try { await refreshPhotos(); await loadDirectories(); status(''); } catch (e) { status(e.message); }
      finally { busy = false; renderDirectories(); render(); }
    }
    function leaveDirectory() {
      if (busy) return;
      if (unfinished() && !window.confirm('返回固定目录会丢失未完成的本地选择或页序调整，服务器照片不会删除。继续？')) return;
      s.drafts.slice().forEach(function (d) { removeDraft(s, d.key); });
      s.saved = []; code = null; name = ''; requests = []; baseIds = []; targetIds = [];
      showCatalog(); renderDirectories(); status('');
    }
    async function deletePhoto(p) {
      if (busy || !window.confirm('确认删除 ' + code + ' 的照片 #' + p.id + '？只删除此照片，关联待审更换会退回；保留其他照片和历史记录。')) return;
      busy = true; render();
      try { await request('/api/fire/photos/' + p.id, { method: 'DELETE', credentials: 'same-origin', headers: { 'X-Requested-With': 'lexiu', 'Content-Type': 'application/json' }, body: '{}' }); await refresh(); status('照片 #' + p.id + ' 已删除'); }
      catch (e) {
        if (e.data && e.data.deleted === true) {
          var message = '照片 #' + p.id + ' 的记录已删除，但文件清理失败：' + e.message + '。请联系管理员处理文件清理。';
          try { await refresh(); } catch (refreshError) { message += ' 列表刷新失败：' + refreshError.message + '；当前页面可能仍显示旧照片，请重新刷新。'; }
          status(message);
        }
        else status(e.message);
      } finally { busy = false; render(); }
    }
    ['fireCamera', 'fireUpload'].forEach(function (id) {
      $(id).onchange = async function () {
        if (busy || !picker) return;
        var files = Array.from(this.files || []), accepted = [], errors = [];
        for (var index = 0; index < files.length; index++) {
          var f = files[index];
          if (!/\.(jpe?g|png)$/i.test(f.name) || (f.type && f.type !== 'image/jpeg' && f.type !== 'image/png')) errors.push(f.name + '：仅接收 JPEG／PNG；HEIC 请先转换');
          else if (!f.size || f.size > 15 * 1024 * 1024) errors.push(f.name + '：图片为空或超过 15MB');
          else {
            try {
              var dimensions = await readImageSize(f), pixelError = imagePixelError(dimensions.width, dimensions.height);
              if (pixelError) errors.push(f.name + '：' + pixelError); else accepted.push(f);
            } catch (error) { errors.push(f.name + '：无法读取照片尺寸，请换一张重试'); }
          }
        }
        var result = selectFiles(s, accepted, picker.key, picker.replacesId); render(); status(errors.join('；') || (result.ok ? (accepted.length ? '已选图，仅在本地待提交。请确认完整纸张与页序。' : '') : result.error));
      };
    });
    if ($('fireDirectorySearch')) $('fireDirectorySearch').oninput = renderDirectories;
    $('fireBackCatalog').onclick = leaveDirectory;
    $('fireAddBlank').onclick = function () { var result = addBlank(s); render(); if (!result.ok) status(result.error); };
    $('fireRefresh').onclick = async function () {
      if (changedOrder() && !window.confirm('刷新会放弃尚未提交的页序调整。继续？')) return;
      busy = true; render(); try { await refresh(); status('已刷新；失败选择继续保留，重试使用原令牌核对，不能仅凭文件名判断已保存。'); } catch (e) { status(e.message); } finally { busy = false; render(); }
    };
    $('fireSubmit').onclick = async function () {
      if (busy || !window.confirm('已确认纸张四边、字迹、签字/盖章完整，并确认本次选图顺序？提交后同批页序固定，失败只重试未成功照片。')) return;
      busy = true; prepareBatch(s); render();
      var result;
      try { result = await sendQueue(s, code, function (done, total) { status('已处理 ' + done + '/' + total + ' 张 · 每批 10 张自动继续'); render(); }, refresh); }
      catch (e) { busy = false; render(); status('处理已中断：' + e.message + '；选择已保留，请刷新核对后重试。'); return; }
      var message = '本次确认保存 ' + result.success + ' 张，未成功 ' + result.failed + ' 张。' + (me.role === 'staff' ? '成功照片待管理员确认。' : '成功照片已生效。');
      if (result.failed) message += '失败选择已保留，请准确重试；网络结果不确定不能按文件名猜成功。';
      try { await refresh(); } catch (e) { message += ' 列表刷新失败：' + e.message; }
      busy = false; render(); renderDirectories(); status(message);
    };
    $('fireSaveOrder').onclick = async function () {
      if (busy || !changedOrder()) return;
      busy = true; render();
      try {
        var result = await request('/api/fire/directories/' + code + '/order', { method: 'POST', credentials: 'same-origin', headers: { 'X-Requested-With': 'lexiu', 'Content-Type': 'application/json' }, body: JSON.stringify({ base_photo_ids: baseIds, photo_ids: targetIds }) });
        await refresh(); status(result.status === 'pending' ? '页序申请待管理员确认；正式照片仍按原序。' : '页序已生效');
      } catch (e) {
        if (e.status === 409) {
          var message = e.message + '；未自动覆盖或重发。';
          try { await refresh(); message += ' 列表已重新核对，请重新确认。'; }
          catch (refreshError) { message += ' 列表刷新失败：' + refreshError.message + '；请重新刷新后确认。'; }
          status(message);
        } else status(e.message);
      }
      finally { busy = false; render(); }
    };
    function closeFireZoom() {
      $('fireZoom').close(); $('fireZoomImage').removeAttribute('src');
      if (zoomTrigger && document.body.contains(zoomTrigger)) zoomTrigger.focus();
      zoomTrigger = null;
    }
    $('fireZoomClose').onclick = closeFireZoom;
    $('fireZoom').addEventListener('close', function () {
      $('fireZoomImage').removeAttribute('src');
      if (zoomTrigger && document.body.contains(zoomTrigger)) zoomTrigger.focus();
      zoomTrigger = null;
    });
    window.addEventListener('beforeunload', function (e) { if (unfinished() || busy) { e.preventDefault(); e.returnValue = ''; } });
    request('/api/me').then(async function (value) {
      me = value; $('fireMe').textContent = me.name + (me.role === 'admin' ? '（管理员）' : '（员工）'); $('fireReviewLink').hidden = me.role !== 'admin';
      $('fireRoleHint').textContent = me.role === 'admin' ? '管理员上传、更换与页序调整直接生效；删除请确认准确对象。' : '添加、更换与页序申请待管理员确认。审核前保留原有效照片和页序，自己的待审图不参与打印。';
      busy = true; showCatalog(); await loadDirectories(); busy = false; renderDirectories();
    }).catch(function (e) { busy = false; status('加载失败：' + e.message + '。请返回工作台确认登录后重试。'); });
  });
}());
