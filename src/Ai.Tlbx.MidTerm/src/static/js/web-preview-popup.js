(function () {
  var params = new URLSearchParams(window.location.search);
  var sessionId = params.get('session') || '';
  var previewName = params.get('preview') || 'default';
  var routeKey = params.get('routeKey') || '';
  var previewId = params.get('previewId') || '';
  var previewToken = params.get('previewToken') || '';
  var previewOrigin = params.get('origin') || window.location.origin;
  var initialViewportWidth = parseInt(params.get('viewportWidth') || '0', 10) || 0;
  var initialViewportHeight = parseInt(params.get('viewportHeight') || '0', 10) || 0;
  var sandboxEnabled = params.get('sandbox') === '1';
  var sandboxBaseFlags = [
    'allow-scripts',
    'allow-forms',
    'allow-popups',
    'allow-modals',
    'allow-downloads',
  ];
  var previewContext =
    previewId && previewToken
      ? {
          sessionId: sessionId,
          previewName: previewName,
          routeKey: routeKey,
          previewId: previewId,
          previewToken: previewToken,
        }
      : null;
  var channelName = sessionId
    ? 'midterm-web-preview-' + sessionId + '-' + previewName
    : 'midterm-web-preview';
  var channel = new BroadcastChannel(channelName);
  var previewHost = document.getElementById('preview-host');
  var frame = document.getElementById('preview-frame');
  var urlDisplay = document.getElementById('url-display');
  var currentUrl = null;

  function syncThemeFromOpener() {
    if (!window.opener || window.opener.closed) {
      return;
    }

    try {
      document.documentElement.style.cssText = window.opener.document.documentElement.style.cssText;
    } catch (_) {}
  }

  function getProxyPrefix() {
    return '/webpreview/' + encodeURIComponent(routeKey);
  }

  function buildProxyUrl(targetUrl) {
    var parsed = new URL(targetUrl);
    var path = parsed.pathname || '/';
    var prefix = getProxyPrefix();
    var proxyUrl = new URL(path === '/' ? prefix + '/' : prefix + path, previewOrigin);
    proxyUrl.search = parsed.search;
    proxyUrl.hash = parsed.hash;
    return proxyUrl.toString();
  }

  function getSandboxFlags() {
    var flags = sandboxBaseFlags.slice();
    try {
      if (new URL(previewOrigin, window.location.origin).origin !== window.location.origin) {
        flags.push('allow-same-origin');
      }
    } catch (_) {}
    return flags.join(' ');
  }

  function setCurrentUrl(url) {
    currentUrl = url;
    urlDisplay.textContent = url || '';
  }

  function resetViewport() {
    if (!frame || !previewHost) {
      return;
    }

    previewHost.classList.remove('viewport-constrained');
    frame.style.flex = '';
    frame.style.alignSelf = '';
    frame.style.width = '';
    frame.style.height = '';
    frame.style.maxWidth = '';
    frame.style.maxHeight = '';
  }

  function syncPopupViewportSize(targetWidth, targetHeight, attempt) {
    if (!frame || attempt > 4) {
      return;
    }

    var widthDelta = Math.round(targetWidth - frame.clientWidth);
    var heightDelta = Math.round(targetHeight - frame.clientHeight);
    if (Math.abs(widthDelta) <= 1 && Math.abs(heightDelta) <= 1) {
      return;
    }

    try {
      window.resizeBy(widthDelta, heightDelta);
    } catch (_) {
      return;
    }

    window.setTimeout(function () {
      syncPopupViewportSize(targetWidth, targetHeight, attempt + 1);
    }, 40);
  }

  function applyViewport(width, height) {
    if (!frame || !previewHost) {
      return;
    }

    if (width <= 0 && height <= 0) {
      resetViewport();
      return;
    }

    var targetWidth = width > 0 ? width : Math.max(frame.clientWidth, 1);
    var targetHeight = height > 0 ? height : Math.max(frame.clientHeight, 1);

    previewHost.classList.add('viewport-constrained');
    frame.style.flex = 'none';
    frame.style.alignSelf = 'center';
    frame.style.width = targetWidth + 'px';
    frame.style.height = targetHeight + 'px';
    frame.style.maxWidth = targetWidth + 'px';
    frame.style.maxHeight = targetHeight + 'px';

    window.requestAnimationFrame(function () {
      syncPopupViewportSize(targetWidth, targetHeight, 0);
    });
  }

  function decodeIframeNavigationUrl(iframeUrl, targetOrigin) {
    var parsed = new URL(iframeUrl, window.location.origin);
    var prefix = getProxyPrefix();

    if (parsed.pathname === prefix + '/_ext') {
      return parsed.searchParams.get('u');
    }

    var path = parsed.pathname;
    if (path.indexOf(prefix + '/') === 0) {
      path = path.substring(prefix.length);
    } else if (path === prefix) {
      path = '/';
    } else {
      return parsed.toString();
    }

    var baseOrigin = targetOrigin;
    if (!baseOrigin && currentUrl) {
      baseOrigin = new URL(currentUrl).origin;
    }

    if (!baseOrigin) {
      return null;
    }

    return baseOrigin + path + parsed.search + parsed.hash;
  }

  function matchesPreviewMessage(data) {
    return (
      !!previewContext &&
      data.previewId === previewContext.previewId &&
      data.previewToken === previewContext.previewToken
    );
  }

  function postCookieBridgeResponse(target, message) {
    if (!target) return;
    target.postMessage(message, '*');
  }

  function handleCookieBridgeRequest(event, data) {
    if (!routeKey) {
      postCookieBridgeResponse(event.source, {
        type: 'mt-cookie-response',
        requestId: data.requestId,
        previewId: data.previewId,
        previewToken: data.previewToken,
        sessionId: data.sessionId,
        previewName: data.previewName,
        error: 'No preview route',
      });
      return;
    }

    var target = event.source;
    var url = new URL(getProxyPrefix() + '/_cookies', window.location.origin);
    var upstreamUrl =
      typeof data.upstreamUrl === 'string' && data.upstreamUrl ? data.upstreamUrl : currentUrl;
    if (upstreamUrl) {
      url.searchParams.set('u', upstreamUrl);
    }

    var responseMessage = {
      type: 'mt-cookie-response',
      requestId: data.requestId,
      previewId: data.previewId,
      previewToken: data.previewToken,
      sessionId: data.sessionId,
      previewName: data.previewName,
    };

    var request =
      data.action === 'set'
        ? fetch(url.toString(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ raw: typeof data.raw === 'string' ? data.raw : '' }),
          })
        : fetch(url.toString(), { method: 'GET' });

    request
      .then(function (response) {
        if (!response.ok) {
          responseMessage.error = 'Cookie bridge failed: ' + response.status;
          postCookieBridgeResponse(target, responseMessage);
          return null;
        }
        return response.json();
      })
      .then(function (json) {
        if (!json) return;
        responseMessage.header = typeof json.header === 'string' ? json.header : '';
        postCookieBridgeResponse(target, responseMessage);
      })
      .catch(function (error) {
        responseMessage.error = String(error);
        postCookieBridgeResponse(target, responseMessage);
      });
  }

  function loadFrame(url) {
    if (!url || !routeKey) {
      frame.removeAttribute('sandbox');
      frame.name = '';
      frame.src = 'about:blank';
      return;
    }

    setCurrentUrl(url);
    try {
      if (sandboxEnabled) {
        frame.setAttribute('sandbox', getSandboxFlags());
      } else {
        frame.removeAttribute('sandbox');
      }
      frame.name = previewContext ? JSON.stringify(previewContext) : '';
      frame.src = buildProxyUrl(url);
    } catch (_) {
      frame.removeAttribute('sandbox');
      frame.name = '';
      frame.src = 'about:blank';
    }
  }

  var initialUrl = params.get('url');
  syncThemeFromOpener();
  if (initialViewportWidth > 0 || initialViewportHeight > 0) {
    applyViewport(initialViewportWidth, initialViewportHeight);
  }
  if (initialUrl) {
    loadFrame(initialUrl);
  }

  channel.onmessage = function (e) {
    if (e.data.type === 'set-url') {
      loadFrame(e.data.url);
    } else if (e.data.type === 'refresh') {
      loadFrame(currentUrl);
    } else if (e.data.type === 'viewport') {
      applyViewport(Number(e.data.width) || 0, Number(e.data.height) || 0);
    }
  };

  window.addEventListener('message', function (e) {
    if (e.source !== frame.contentWindow || !e.data || typeof e.data.type !== 'string') return;

    if (e.data.type === 'mt-navigation') {
      if (typeof e.data.url !== 'string' || !matchesPreviewMessage(e.data)) return;

      try {
        var displayUrl =
          typeof e.data.upstreamUrl === 'string' && e.data.upstreamUrl
            ? e.data.upstreamUrl
            : decodeIframeNavigationUrl(
                e.data.url,
                typeof e.data.targetOrigin === 'string' ? e.data.targetOrigin : '',
              );
        if (!displayUrl) return;
        setCurrentUrl(displayUrl);
        channel.postMessage({
          type: 'navigation',
          sessionId: sessionId,
          previewName: previewName,
          url: displayUrl,
        });
      } catch (_) {}
      return;
    }

    if (e.data.type === 'mt-cookie-request' && matchesPreviewMessage(e.data)) {
      handleCookieBridgeRequest(e, e.data);
    }
  });

  document.getElementById('refresh-btn').addEventListener('click', function (e) {
    var mode = e.shiftKey || e.ctrlKey || e.altKey ? 'hard' : 'soft';
    if (currentUrl) {
      fetch('/api/webpreview/target', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: sessionId,
          previewName: previewName,
          url: currentUrl,
        }),
      }).catch(function () {});
    }
    fetch('/api/webpreview/reload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: sessionId,
        previewName: previewName,
        mode: mode,
      }),
    }).catch(function () {});
    loadFrame(currentUrl);
  });

  document.getElementById('dock-back-btn').addEventListener('click', function () {
    channel.postMessage({
      type: 'dock-back',
      sessionId: sessionId,
      previewName: previewName,
    });
    window.close();
  });

  window.addEventListener('beforeunload', function () {
    channel.postMessage({
      type: 'popup-closed',
      sessionId: sessionId,
      previewName: previewName,
    });
  });

  window.addEventListener('focus', syncThemeFromOpener);
})();
