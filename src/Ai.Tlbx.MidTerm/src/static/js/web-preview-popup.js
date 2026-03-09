(function () {
  var params = new URLSearchParams(window.location.search);
  var sessionId = params.get('session') || '';
  var previewId = params.get('previewId') || '';
  var previewToken = params.get('previewToken') || '';
  var previewOrigin = params.get('origin') || window.location.origin;
  var sandboxEnabled = params.get('sandbox') === '1';
  var sandboxBaseFlags = [
    'allow-scripts',
    'allow-forms',
    'allow-popups',
    'allow-modals',
    'allow-downloads'
  ];
  var previewContext = previewId && previewToken
    ? { sessionId: sessionId, previewId: previewId, previewToken: previewToken }
    : null;
  var channelName = sessionId ? 'midterm-web-preview-' + sessionId : 'midterm-web-preview';
  var channel = new BroadcastChannel(channelName);
  var frame = document.getElementById('preview-frame');
  var urlDisplay = document.getElementById('url-display');
  var currentUrl = null;

  function buildProxyUrl(targetUrl) {
    var parsed = new URL(targetUrl);
    var path = parsed.pathname || '/';
    var proxyUrl = new URL(path === '/' ? '/webpreview/' : '/webpreview' + path, previewOrigin);
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
    } catch (_) {
    }
    return flags.join(' ');
  }

  function setCurrentUrl(url) {
    currentUrl = url;
    urlDisplay.textContent = url || '';
  }

  function decodeIframeNavigationUrl(iframeUrl, targetOrigin) {
    var parsed = new URL(iframeUrl, window.location.origin);
    if (parsed.pathname === '/webpreview/_ext') {
      return parsed.searchParams.get('u');
    }

    var path = parsed.pathname;
    if (path.indexOf('/webpreview/') === 0) {
      path = path.substring('/webpreview'.length);
    } else if (path === '/webpreview') {
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
    return !!previewContext
      && data.previewId === previewContext.previewId
      && data.previewToken === previewContext.previewToken;
  }

  function postCookieBridgeResponse(target, message) {
    if (!target) return;
    target.postMessage(message, '*');
  }

  function handleCookieBridgeRequest(event, data) {
    var target = event.source;
    var url = new URL('/webpreview/_cookies', window.location.origin);
    var upstreamUrl = typeof data.upstreamUrl === 'string' && data.upstreamUrl
      ? data.upstreamUrl
      : currentUrl;
    if (upstreamUrl) {
      url.searchParams.set('u', upstreamUrl);
    }

    var responseMessage = {
      type: 'mt-cookie-response',
      requestId: data.requestId,
      previewId: data.previewId,
      previewToken: data.previewToken,
      sessionId: data.sessionId
    };

    var request = data.action === 'set'
      ? fetch(url.toString(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ raw: typeof data.raw === 'string' ? data.raw : '' })
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
    if (!url) {
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
  if (initialUrl) {
    loadFrame(initialUrl);
  }

  channel.onmessage = function (e) {
    if (e.data.type === 'set-url') {
      loadFrame(e.data.url);
    } else if (e.data.type === 'refresh') {
      loadFrame(currentUrl);
    }
  };

  window.addEventListener('message', function (e) {
    if (e.source !== frame.contentWindow || !e.data || typeof e.data.type !== 'string') return;

    if (e.data.type === 'mt-navigation') {
      if (typeof e.data.url !== 'string' || !matchesPreviewMessage(e.data)) return;

      try {
        var displayUrl = typeof e.data.upstreamUrl === 'string' && e.data.upstreamUrl
          ? e.data.upstreamUrl
          : decodeIframeNavigationUrl(
              e.data.url,
              typeof e.data.targetOrigin === 'string' ? e.data.targetOrigin : ''
            );
        if (!displayUrl) return;
        setCurrentUrl(displayUrl);
        channel.postMessage({ type: 'navigation', sessionId: sessionId, url: displayUrl });
      } catch (_) {
      }
      return;
    }

    if (e.data.type === 'mt-cookie-request' && matchesPreviewMessage(e.data)) {
      handleCookieBridgeRequest(e, e.data);
    }
  });

  document.getElementById('refresh-btn').addEventListener('click', function (e) {
    var mode = (e.shiftKey || e.ctrlKey || e.altKey) ? 'hard' : 'soft';
    if (currentUrl) {
      fetch('/api/webpreview/target', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: currentUrl })
      }).catch(function () {});
    }
    fetch('/api/webpreview/reload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: mode })
    }).catch(function () {});
    loadFrame(currentUrl);
  });

  document.getElementById('dock-back-btn').addEventListener('click', function () {
    channel.postMessage({ type: 'dock-back', sessionId: sessionId });
    window.close();
  });

  window.addEventListener('beforeunload', function () {
    channel.postMessage({ type: 'popup-closed', sessionId: sessionId });
  });
})();
