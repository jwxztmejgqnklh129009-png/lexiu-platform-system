(function () {
  'use strict';
  var FIRE_SOURCE_MAX_PIXELS = 60000000;
  function split(items) {
    var parts = [], current = [], pixels = 0;
    items.forEach(function (item) {
      var size = item.width * item.height;
      if (!Number.isInteger(item.width) || !Number.isInteger(item.height) || item.width <= 0 || item.height <= 0 || size > FIRE_SOURCE_MAX_PIXELS) throw new Error('照片 #' + item.id + ' 的尺寸无效，请刷新核对');
      if (current.length && (current.length === 12 || pixels + size > 45000000)) { parts.push(current); current = []; pixels = 0; }
      current.push(item); pixels += size;
    });
    if (current.length) parts.push(current);
    return parts;
  }
  async function waitImage(img) {
    if (!img.complete) await new Promise(function (resolve, reject) {
      var timer;
      function clean() { clearTimeout(timer); img.removeEventListener('load', loaded); img.removeEventListener('error', failed); }
      function loaded() { clean(); resolve(); }
      function failed() { clean(); reject(new Error('原件加载失败')); }
      img.addEventListener('load', loaded); img.addEventListener('error', failed);
      timer = setTimeout(function () { clean(); reject(new Error('原件加载超时')); }, 60000);
    });
    if (!img.naturalWidth || !img.naturalHeight) throw new Error('原件缺失或不能显示');
    if (typeof img.decode === 'function') await img.decode();
    if (!img.naturalWidth || !img.naturalHeight) throw new Error('原件解码失败');
  }
  window.FirePrintModel = { split: split, waitImage: waitImage };
  document.addEventListener('DOMContentLoaded', function () {
    var sheets = document.getElementById('firePrintSheets'); if (!sheets) return;
    function $(id) { return document.getElementById(id); }
    function el(tag, cls, text) { var node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; }
    var manifest, parts = [], revision = 0, ready = false, checking = false;
    function disable(message) { ready = false; $('firePrintButton').disabled = true; $('firePrintStatus').textContent = message; }
    async function request(url, options) {
      options = Object.assign({ credentials: 'same-origin', cache: 'no-store' }, options || {});
      var controller = (typeof AbortController === 'function' && !options.signal) ? new AbortController() : null;
      var timer = controller ? setTimeout(function () { controller.abort(); }, 30000) : null;
      if (controller) options.signal = controller.signal;
      var response;
      try { response = await fetch(url, options); }
      catch (error) {
        if (error && error.name === 'AbortError') throw new Error('请求超时，请重新加载并核对');
        throw new Error('网络连接失败，请重新加载并核对');
      }
      finally { if (timer) clearTimeout(timer); }
      var data = {};
      try { data = await response.json(); }
      catch (parseError) { data = { error: response.status === 413 ? '请求内容过大，请重新加载' : '服务器返回了无法识别的结果，请重新加载' }; }
      if (!response.ok) { var e = new Error(data.error || '请求失败 ' + response.status); e.status = response.status; throw e; }
      return data;
    }
    async function check() {
      return request('/api/fire/print-check', { method: 'POST', credentials: 'same-origin', headers: { 'X-Requested-With': 'lexiu', 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: manifest.scope, snapshot_hash: manifest.snapshot_hash }) });
    }
    function release() {
      sheets.querySelectorAll('img').forEach(function (img) { img.removeAttribute('src'); });
      sheets.replaceChildren();
    }
    function describe(part, index) {
      var ranges = [];
      part.forEach(function (item) {
        var last = ranges[ranges.length - 1];
        if (!last || last.code !== item.directory_code) ranges.push({ code: item.directory_code, name: item.directory_name, first: item.number, last: item.number });
        else last.last = item.number;
      });
      return '第 ' + (index + 1) + '／' + parts.length + ' 册 · ' + part.length + ' 页 · ' + ranges.map(function (r) { return r.code + ' ' + r.name + ' 第 ' + r.first + (r.last !== r.first ? '–' + r.last : '') + ' 张'; }).join('；');
    }
    function install(data) {
      manifest = data; parts = split(data.items); $('firePrintPart').replaceChildren();
      parts.forEach(function (part, i) { var option = el('option', '', '第 ' + (i + 1) + ' 册（' + part.length + ' 页）'); option.value = String(i); $('firePrintPart').append(option); });
      $('firePrintSummary').textContent = '共 ' + data.total_pages + ' 页，分为 ' + parts.length + ' 册。按目录和当前页序打印；请逐册保存或打印。';
      $('firePrintPart').disabled = !parts.length;
    }
    async function loadPart(index) {
      var mine = ++revision; disable('正在加载当前册原件并核对页序…'); release();
      if (!parts.length) { $('firePartSummary').textContent = ''; disable('当前范围没有已生效照片，无需打印。'); return; }
      var part = parts[index]; $('firePartSummary').textContent = describe(part, index);
      var tasks = part.map(function (item) {
        var sheet = el('article', 'fire-sheet'), img = el('img');
        img.alt = item.directory_code + ' 第 ' + item.number + ' 张原件';
        sheet.append(el('h2', '', item.directory_code + ' ' + item.directory_name), img, el('p', 'fire-page-number', '第 ' + item.number + ' 张／共 ' + item.total + ' 张'));
        sheets.append(sheet); img.src = item.url;
        return waitImage(img).catch(function (e) { throw new Error(item.directory_code + ' 第 ' + item.number + ' 张：' + e.message); });
      });
      try {
        await Promise.all(tasks); if (mine !== revision) return;
        await check(); if (mine !== revision) return;
        ready = true; $('firePrintButton').disabled = false; $('firePrintStatus').textContent = '当前册全部原件已加载、解码且页序核对通过。请检查四角和字迹后主动打印。';
      } catch (e) { if (mine === revision) disable(e.message + '。产品打印入口已停用，请重新加载并核对；不会跳过此页。'); }
    }
    $('firePrintPart').onchange = function () { loadPart(Number(this.value)); };
    $('firePrintRetry').onclick = async function () {
      var scope = manifest.scope, mine = ++revision; disable('正在重新获取授权清单…'); release();
      $('firePrintRetry').disabled = true; $('firePrintPart').disabled = true;
      try { var data = await request('/api/fire/print-manifest?scope=' + encodeURIComponent(scope)); if (mine === revision) { install(data); await loadPart(0); } }
      catch (e) { if (mine === revision) disable('刷新失败：' + e.message + '。请确认登录与原件，再重新加载。'); }
      finally { $('firePrintRetry').disabled = false; }
    };
    $('firePrintButton').onclick = async function () {
      if (!ready || checking) return;
      var mine = revision; checking = true; disable('打印前再次核对授权照片与页序…');
      try {
        await check(); if (mine !== revision) return;
        ready = true; $('firePrintButton').disabled = false; $('firePrintStatus').textContent = '核对通过。打印当前册后，请选择下一册继续。'; window.print();
      } catch (e) { if (mine === revision) disable(e.message + '。请重新加载并核对后打印。'); }
      finally { checking = false; }
    };
    try { install(JSON.parse($('firePrintManifest').textContent)); loadPart(0); }
    catch (e) { disable('打印清单无效：' + e.message + '。请刷新页面。'); }
  });
}());
