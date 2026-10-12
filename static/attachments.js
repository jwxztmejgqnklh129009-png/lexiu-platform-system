(function (root) {
  'use strict';
  var liveUrls = new WeakMap();
  var IMAGE = /\.(jpe?g|png)$/i;
  var CERT = /\.(jpe?g|png|pdf|docx?|xlsx?)$/i;
  var MAX_IMAGE = 15 * 1024 * 1024;
  // 请求体还有 multipart 边界和字段，不能承诺恰好 20 MiB 的文件可上传。
  var MAX_DOCUMENT = 20 * 1024 * 1024 - 64 * 1024;

  function escapeHTML(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function formatSize(bytes) {
    var n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return +(n / 1024).toFixed(1) + ' KB';
    return +(n / (1024 * 1024)).toFixed(1) + ' MB';
  }
  function fileType(name) {
    var ext = String(name || '').split('.').pop().toLowerCase();
    if (['jpg', 'jpeg', 'png'].indexOf(ext) !== -1) return '图片';
    if (ext === 'pdf') return 'PDF';
    if (ext === 'doc' || ext === 'docx') return 'Word';
    if (ext === 'xls' || ext === 'xlsx') return 'Excel';
    return '文件';
  }
  function validate(file, kind) {
    if (!file) return { ok: false, error: '请先选择文件' };
    if (!Number.isFinite(file.size) || file.size <= 0) return { ok: false, error: '不能上传空文件' };
    var name = String(file.name || '');
    var imageOnly = kind === 'image' || kind === 'inventory' || kind === 'drink';
    var health = kind === 'health';
    if (!(imageOnly ? IMAGE : health ? /\.(jpe?g|png|pdf)$/i : CERT).test(name)) {
      return { ok: false, error: imageOnly ? '只支持 JPG、PNG 图片' :
        health ? '只支持 JPG、PNG、PDF 文件' : '只支持 JPG、PNG、PDF、Word、Excel 文件' };
    }
    var isImage = IMAGE.test(name);
    if (isImage && file.size > MAX_IMAGE) return { ok: false, error: '图片不能超过 15 MB' };
    if (!isImage && file.size > MAX_DOCUMENT) return { ok: false, error: '文件接近或超过请求上限，请选择小于 19.9 MB 的文件' };
    return { ok: true, type: fileType(name), image: isImage };
  }
  function safeURL(url) {
    var value = String(url || '');
    return value.charAt(0) === '/' && value.charAt(1) !== '/' ? escapeHTML(value) : '';
  }
  function release(container) {
    if (!container) return;
    var old = liveUrls.get(container);
    if (old) { root.URL.revokeObjectURL(old); liveUrls.delete(container); }
    container.innerHTML = '';
  }
  function showSelection(container, file, options) {
    options = options || {};
    var check = validate(file, options.kind || 'certificate');
    if (!check.ok || !container) return check;
    release(container);
    var media;
    if (check.image) {
      var url = root.URL.createObjectURL(file);
      liveUrls.set(container, url);
      media = '<img class="file-preview-media" src="' + escapeHTML(url) + '" alt="本次选择的图片预览">';
    } else {
      media = '<div class="file-cover" aria-label="' + escapeHTML(check.type) + ' 文件封面">' +
        '<span>' + escapeHTML(check.type) + '</span></div>';
    }
    container.innerHTML = '<div class="file-preview"><div class="file-preview-visual">' + media + '</div>' +
      '<div class="file-preview-meta"><strong class="file-name">' + escapeHTML(file.name) +
      '</strong><span class="file-size">' + escapeHTML(check.type) + ' · ' + formatSize(file.size) +
      '</span><span>尚未提交</span></div>' +
      '<div class="file-preview-actions"><button type="button" class="btn" data-file-act="reselect">重新选择</button>' +
      '<button type="button" class="btn" data-file-act="clear">取消本次文件</button></div></div>';
    return check;
  }
  function renderSaved(file, options) {
    options = options || {};
    if (!file || !file.original_name) return '<div class="no-photo">尚未上传附件</div>';
    var imgUrl = safeURL(file.web_url || file.thumb_url);
    var type = options.imageOnly && imgUrl ? '图片' : fileType(file.original_name);
    var picture = type === '图片';
    var rawUrl = safeURL(file.raw_url);
    var media = picture && imgUrl
      ? '<a class="file-image-trigger" href="' + imgUrl + '" target="_blank" rel="noopener" aria-label="查看' + escapeHTML(file.original_name) + '大图"><img class="file-preview-media" src="' + imgUrl + '" alt="' + escapeHTML(file.original_name) + '"></a>'
      : '<div class="file-cover"><span>' + escapeHTML(type) + '</span></div>';
    var open = rawUrl ? '<a class="btn" href="' + rawUrl + '">查看原文件</a>' :
      '<span class="muted">原文件不可打开</span>';
    if (options.imageOnly) open = imgUrl ? '<a class="btn" href="' + imgUrl + '" target="_blank" rel="noopener">查看大图</a>' : '';
    return '<div class="file-preview file-saved"><div class="file-preview-visual">' + media + '</div>' +
      '<div class="file-preview-meta"><strong class="file-name">' + escapeHTML(file.original_name) +
      '</strong><span class="file-size">' + escapeHTML(type) +
      (Number.isFinite(file.file_size == null ? file.size : file.file_size)
        ? ' · ' + formatSize(file.file_size == null ? file.size : file.file_size) : '') +
      '</span></div><div class="file-preview-actions">' + open + '</div></div>';
  }
  if (!root._lexiuFileKeyboardBound) {
    root._lexiuFileKeyboardBound = true;
    document.addEventListener('keydown', function (event) {
      var trigger = event.target && event.target.closest ? event.target.closest('.file-image-trigger') : null;
      if (!trigger || (event.key !== 'Enter' && event.key !== ' ')) return;
      event.preventDefault(); trigger.click();
    });
  }
  root.LexiuFiles = {
    escapeHTML: escapeHTML, formatSize: formatSize, fileType: fileType,
    validate: validate, showSelection: showSelection, renderSaved: renderSaved, release: release
  };
})(window);
