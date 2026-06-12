// 右下角 toast（extracted from content/index.ts）。Content-bundle leaf。

import { T_PANEL, T_GLOW, T_GLOW_SOFT, T_FONT } from './terminal-theme';

export function showToast(msg: string, durationMs = 3000): void {
  if (!document.body) return;
  const toast = document.createElement('div');
  toast.style.cssText = `position:fixed;bottom:170px;right:20px;z-index:2147483647;background:${T_PANEL};color:${T_GLOW};border:1px solid ${T_GLOW};border-radius:10px;padding:10px 16px;font-size:13px;box-shadow:0 0 0 1px ${T_GLOW_SOFT},0 4px 16px rgba(0,0,0,0.5);font-family:${T_FONT}`;
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), durationMs);
}
