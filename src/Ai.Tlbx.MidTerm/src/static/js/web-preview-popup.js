(function () {
  var params = new URLSearchParams(window.location.search);
  var sessionId = params.get('session') || '';
  var channelName = sessionId ? 'midterm-web-preview-' + sessionId : 'midterm-web-preview';
  var channel = new BroadcastChannel(channelName);
  var frame = document.getElementById('preview-frame');
  var urlDisplay = document.getElementById('url-display');
  var currentUrl = null;

  function buildProxyUrl(targetUrl) {
    var parsed = new URL(targetUrl);
    var path = parsed.pathname || '/';
    var proxyUrl = new URL(path === '/' ? '/webpreview/' : '/webpreview' + path, window.location.origin);
    proxyUrl.search = parsed.search;
    proxyUrl.hash = parsed.hash;
    return proxyUrl.pathname + proxyUrl.search + proxyUrl.hash;
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

  function loadFrame(url) {
    if (!url) {
      frame.src = 'about:blank';
      return;
    }

    setCurrentUrl(url);
    try {
      frame.src = buildProxyUrl(url);
    } catch (_) {
      frame.src = 'about:blank';
    }
  }

  // Get URL from query parameter
  var initialUrl = params.get('url');
  if (initialUrl) {
    loadFrame(initialUrl);
  }

  // Listen for messages from parent
  channel.onmessage = function (e) {
    if (e.data.type === 'set-url') {
      loadFrame(e.data.url);
    } else if (e.data.type === 'refresh') {
      loadFrame(currentUrl);
    }
  };

  window.addEventListener('message', function (e) {
    if (e.source !== frame.contentWindow) return;
    if (!e.data || e.data.type !== 'mt-navigation' || typeof e.data.url !== 'string') return;

    try {
      var displayUrl = decodeIframeNavigationUrl(
        e.data.url,
        typeof e.data.targetOrigin === 'string' ? e.data.targetOrigin : ''
      );
      if (!displayUrl) return;
      setCurrentUrl(displayUrl);
      channel.postMessage({ type: 'navigation', sessionId: sessionId, url: displayUrl });
    } catch (_) {
    }
  });

  // Refresh button
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

  // Dock back button
  document.getElementById('dock-back-btn').addEventListener('click', function () {
    channel.postMessage({ type: 'dock-back', sessionId: sessionId });
    window.close();
  });

  // Notify parent on close
  window.addEventListener('beforeunload', function () {
    channel.postMessage({ type: 'popup-closed', sessionId: sessionId });
  });
})();
