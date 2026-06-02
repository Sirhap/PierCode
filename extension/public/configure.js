const statusEl = document.getElementById('status');
const params = new URLSearchParams(location.search);
const apiUrl = params.get('apiUrl');
const authToken = params.get('token');
const qwenMaxContextTokens = Number(params.get('qwenMaxContextTokens') || '');
const qwenMaxSummaryTokens = Number(params.get('qwenMaxSummaryTokens') || '');
const qwenCompressionEnabled = params.get('qwenCompressionEnabled');
const qwenE2EBridgeEnabled = params.get('qwenE2EBridgeEnabled');
const reloadExtension = params.get('reloadExtension') === 'true';

function setStatus(text, done) {
  if (statusEl) statusEl.textContent = text;
  window.__PIERCODE_CONFIG_DONE__ = done;
}

if (apiUrl && authToken) {
  const values = { apiUrl, authToken };
  const qwenCompressionConfig = {};
  let hasQwenCompressionConfig = false;
  if (qwenCompressionEnabled !== null) {
    qwenCompressionConfig.enabled = qwenCompressionEnabled !== 'false';
    hasQwenCompressionConfig = true;
  }
  if (Number.isFinite(qwenMaxContextTokens) && qwenMaxContextTokens > 0) {
    qwenCompressionConfig.maxContextTokens = qwenMaxContextTokens;
    qwenCompressionConfig.maxSummaryTokens = Number.isFinite(qwenMaxSummaryTokens) && qwenMaxSummaryTokens > 0
      ? qwenMaxSummaryTokens
      : 65536;
    hasQwenCompressionConfig = true;
  } else if (Number.isFinite(qwenMaxSummaryTokens) && qwenMaxSummaryTokens > 0) {
    qwenCompressionConfig.maxSummaryTokens = qwenMaxSummaryTokens;
    hasQwenCompressionConfig = true;
  }
  if (hasQwenCompressionConfig) {
    values.qwenCompressionConfig = qwenCompressionConfig;
  }
  if (qwenE2EBridgeEnabled !== null) {
    values.qwenE2EBridgeEnabled = qwenE2EBridgeEnabled === 'true';
  }
  chrome.storage.local.set(values, () => {
    setStatus(`Configured: ${apiUrl}${reloadExtension ? ' (reloading)' : ''}`, true);
    if (reloadExtension) {
      setTimeout(() => chrome.runtime.reload(), 50);
    }
  });
} else {
  setStatus('Missing params', 'error');
}
