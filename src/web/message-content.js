const { jsonForInlineScript } = require('./html-security');

const MESSAGE_CONTENT_CSS = '.voko-media-image-link{display:inline-flex;flex-direction:column;align-items:flex-start;gap:5px;max-width:100%;padding:4px;border:1px solid #d7dee8;border-radius:9px;background:#fff;text-decoration:none}.voko-media-image-preview{display:block;max-width:min(320px,100%);max-height:240px;border-radius:6px;object-fit:contain;background:#f2f4f7}.voko-media-caption{font-size:12px;color:#667085;font-weight:600}.voko-media-fallback{padding:12px;color:#8a929a;font-size:13px}.voko-file-card{display:flex;align-items:center;gap:10px;max-width:460px;padding:10px 12px;border:1px solid #d7dee8;border-radius:9px;background:#fff}.voko-file-icon{display:flex;align-items:center;justify-content:center;flex:0 0 38px;height:38px;border-radius:8px;background:#e8f0fe;font-size:20px}.voko-file-info{min-width:0;flex:1}.voko-file-name{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#26364a;font-size:14px}.voko-file-meta{display:block;color:#7b8794;font-size:12px}.voko-file-action{flex:0 0 auto;font-size:13px}.voko-resource-unavailable{flex:0 0 auto;color:#8a929a;font-size:12px}.voko-compose-row{display:flex;align-items:stretch;gap:10px;margin-top:3px}.voko-compose-row input[type="text"]{flex:1;min-width:0;max-width:none;margin:0}.voko-compose-row .voko-send-button{flex:0 0 auto;margin:0}.voko-send-button:disabled{background:#e1e4e8!important;border-color:#c7ccd1!important;color:#737b84!important;cursor:not-allowed;opacity:1!important}.voko-send-button:disabled .voko-spinner{border-color:rgba(74,84,96,.25);border-top-color:#5f6b7a}';

function createMessageRenderer(labels) {
  const text = Object.assign({
    image: '',
    openOriginal: '',
    file: '',
    video: '',
    openFile: '',
    openVideo: '',
    unavailable: '',
    unknownFile: '',
    expand: 'Expand full message',
    collapse: 'Collapse message',
  }, labels || {});

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function safeUrl(value) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return '';
    if (/^\/api\/uploads\/[A-Za-z0-9_-]+\/download(?:\?|$)/.test(raw)) return raw;
    if (/^\/api\/e2ee\/attachments\/[A-Za-z0-9_-]{8,128}\/download\?token=[A-Za-z0-9_-]{43}$/.test(raw)) return raw;
    try {
      const parsed = new URL(raw);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : '';
    } catch (_) {
      return '';
    }
  }

  function parseObject(content) {
    if (content && typeof content === 'object') return content;
    const raw = String(content == null ? '' : content).trim();
    if (!raw || raw[0] !== '{') return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  function urlFrom(payload, content) {
    if (payload) return payload.url || payload.fileUrl || payload.file_url || payload.src || '';
    return content;
  }

  function nameFromUrl(url) {
    if (!url) return '';
    try {
      const part = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
      return decodeURIComponent(part);
    } catch (_) {
      return '';
    }
  }

  function formatSize(value) {
    const size = Number(value);
    if (!Number.isFinite(size) || size < 0) return '';
    if (size < 1024) return size + ' B';
    if (size < 1024 * 1024) return (size / 1024).toFixed(size < 10240 ? 1 : 0) + ' KB';
    if (size < 1024 * 1024 * 1024) return (size / 1024 / 1024).toFixed(size < 10485760 ? 1 : 0) + ' MB';
    return (size / 1024 / 1024 / 1024).toFixed(1) + ' GB';
  }

  function normalize(contentType, content) {
    const type = Number(contentType);
    const payload = parseObject(content);
    const rawUrl = urlFrom(payload, content);
    const url = safeUrl(rawUrl);

    const attachment = payload && url && ['name', 'fileName', 'file_name', 'size', 'fileSize', 'file_size', 'type', 'mimeType', 'mime_type']
      .some((key) => Object.prototype.hasOwnProperty.call(payload, key));
    if (attachment) {
      const name = payload.name || payload.fileName || payload.file_name || nameFromUrl(url) || text.unknownFile;
      const size = payload.size ?? payload.fileSize ?? payload.file_size;
      const declaredType = payload.mimeType || payload.mime_type || payload.type;
      const mime = typeof declaredType === 'string' && declaredType.includes('/') ? declaredType : '';
      const imageName = /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(String(name));
      if ((mime && mime.toLowerCase().startsWith('image/')) || imageName) {
        return { kind: 'image', url, name: String(name) };
      }
      const extension = String(name).match(/\.([^.]+)$/);
      return {
        kind: 'file',
        url,
        name: String(name),
        size: formatSize(size),
        mime: String(mime || (extension ? extension[1].toUpperCase() : '')),
      };
    }

    if (type === 2) {
      return { kind: 'image', url };
    }

    if (type === 8 || type === 4) {
      const name = payload && (payload.name || payload.fileName || payload.file_name);
      const size = payload && (payload.size ?? payload.fileSize ?? payload.file_size);
      const mime = payload && (payload.type || payload.mimeType || payload.mime_type);
      return {
        kind: 'file',
        url,
        name: String(name || nameFromUrl(url) || text.unknownFile),
        size: formatSize(size),
        mime: String(mime || ''),
      };
    }

    if (type === 3) {
      return { kind: 'video', url };
    }

    return null;
  }

  function renderMedia(contentType, content) {
    const media = normalize(contentType, content);
    if (!media) return null;

    if (media.kind === 'image') {
      if (!media.url) {
        return '<div class="voko-file-card"><span class="voko-file-icon" aria-hidden="true">🖼️</span><span class="voko-file-info"><strong class="voko-file-name">' + esc(text.image) + '</strong></span><span class="voko-resource-unavailable">' + esc(text.unavailable) + '</span></div>';
      }
      const url = esc(media.url);
      return '<a class="voko-media-image-link" href="' + url + '" target="_blank" rel="noopener noreferrer" title="' + esc(text.openOriginal) + '"><img class="voko-media-image-preview" src="' + url + '" alt="' + esc(media.name || text.image) + '" loading="lazy" decoding="async" onerror="this.hidden=true;this.nextElementSibling.hidden=false"><span class="voko-media-fallback" hidden>' + esc(text.unavailable) + '</span><span class="voko-media-caption">' + esc(media.name || text.openOriginal) + '</span></a>';
    }

    const isVideo = media.kind === 'video';
    const icon = isVideo ? '🎬' : '📄';
    const name = isVideo ? text.video : media.name;
    const meta = !isVideo ? [media.size, media.mime].filter(Boolean).join(' · ') : '';
    const action = media.url
      ? '<a class="voko-file-action" href="' + esc(media.url) + '" target="_blank" rel="noopener noreferrer">' + esc(isVideo ? text.openVideo : text.openFile) + '</a>'
      : '<span class="voko-resource-unavailable">' + esc(text.unavailable) + '</span>';
    return '<div class="voko-file-card"><span class="voko-file-icon" aria-hidden="true">' + icon + '</span><span class="voko-file-info"><strong class="voko-file-name">' + esc(name) + '</strong>' + (meta ? '<small class="voko-file-meta">' + esc(meta) + '</small>' : '') + '</span>' + action + '</div>';
  }

  function render(contentType, content) {
    return renderExpandable(contentType, content);
  }

  function renderExpandable(contentType, content) {
    const media = renderMedia(contentType, content);
    if (media) return media;
    const raw = String(content == null ? '' : content);
    if (raw.length <= 500) return esc(raw).replace(/\n/g, '<br>');
    const shortHtml = esc(raw.substring(0, 500) + '…').replace(/\n/g, '<br>');
    const fullHtml = esc(raw).replace(/\n/g, '<br>');
    return '<span data-voko-expandable><span data-voko-message-preview>' + shortHtml + '</span><span data-voko-message-full hidden>' + fullHtml + '</span><button type="button" data-voko-expand-message aria-expanded="false" style="display:block;margin:5px 0 0;padding:2px 8px;min-width:auto;min-height:auto;font-size:13px;line-height:1.4">' + esc(text.expand) + '</button></span>';
  }

  return { normalize, renderMedia, render, renderExpandable };
}

function messageLabels(tFn) {
  const t = tFn || ((key) => key);
  return {
    image: t('web.message.image'),
    openOriginal: t('web.message.open_original'),
    file: t('web.message.file'),
    video: t('web.message.video'),
    openFile: t('web.message.open_file'),
    openVideo: t('web.message.open_video'),
    unavailable: t('web.message.unavailable'),
    unknownFile: t('web.message.unknown_file'),
    expand: t('web.conversation.expand'),
    collapse: t('web.conversation.collapse'),
  };
}

function messageRendererScript(tFn) {
  const labels = JSON.stringify(messageLabels(tFn)).replace(/</g, '\\u003c');
  return '<script>window.__vokoMessageRenderer=(' + createMessageRenderer.toString() + ')(' + labels + ');</script>' + messageExpandScript(tFn);
}

function messageExpandScript(tFn) {
  const t = tFn || ((key) => key);
  const labels = jsonForInlineScript({
    expand: t('web.conversation.expand'),
    collapse: t('web.conversation.collapse'),
  });
  return '<script>(function(){var labels=' + labels + ';window.__vokoExpandLabels=labels;document.addEventListener("click",function(event){var button=event.target.closest("[data-voko-expand-message]");if(!button)return;var box=button.closest("[data-voko-expandable]");if(!box)return;var preview=box.querySelector("[data-voko-message-preview]"),full=box.querySelector("[data-voko-message-full]"),isExpanded=button.getAttribute("aria-expanded")==="true",nextExpanded=!isExpanded;if(!preview||!full)return;preview.hidden=nextExpanded;full.hidden=!nextExpanded;button.setAttribute("aria-expanded",nextExpanded?"true":"false");button.textContent=nextExpanded?labels.collapse:labels.expand;});})();</script>';
}

module.exports = {
  MESSAGE_CONTENT_CSS,
  createMessageRenderer,
  messageLabels,
  messageRendererScript,
  messageExpandScript,
};
