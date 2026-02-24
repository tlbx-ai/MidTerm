(function () {
  var params = new URLSearchParams(window.location.search);
  var sessionId = params.get('session') || '';
  var channelName = sessionId ? 'midterm-web-preview-' + sessionId : 'midterm-web-preview';
  var channel = new BroadcastChannel(channelName);
  var frame = document.getElementById('preview-frame');
  var urlDisplay = document.getElementById('url-display');

  // Get URL from query parameter
  var initialUrl = params.get('url');
  if (initialUrl) {
    urlDisplay.textContent = initialUrl;
    frame.src = '/webpreview/';
  }

  // Listen for messages from parent
  channel.onmessage = function (e) {
    if (e.data.type === 'set-url') {
      urlDisplay.textContent = e.data.url;
      frame.src = '/webpreview/';
    } else if (e.data.type === 'refresh') {
      frame.src = '/webpreview/?' + Date.now();
    }
  };

  // Refresh button
  document.getElementById('refresh-btn').addEventListener('click', function (e) {
    var mode = (e.shiftKey || e.ctrlKey || e.altKey) ? 'hard' : 'soft';
    fetch('/api/webpreview/reload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: mode })
    }).catch(function () {});
    frame.src = '/webpreview/?' + Date.now();
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
