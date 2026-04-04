(function () {
  try {
    if (sessionStorage.getItem('midterm.pendingAppRefresh') === '1') {
      document.documentElement.classList.add('midterm-app-refreshing');
    }
  } catch {
    // Ignore sessionStorage failures and continue with the normal shell.
  }
})();
