const statusEl = document.getElementById('status');
const params = new URLSearchParams(location.search);
const apiUrl = params.get('apiUrl');
const authToken = params.get('token');

function setStatus(text, done) {
  if (statusEl) statusEl.textContent = text;
  window.__PIERCODE_CONFIG_DONE__ = done;
}

if (apiUrl && authToken) {
  chrome.storage.local.set({ apiUrl, authToken }, () => {
    setStatus(`Configured: ${apiUrl}`, true);
  });
} else {
  setStatus('Missing params', 'error');
}
