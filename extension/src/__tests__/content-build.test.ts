import { describe, expect, it } from 'vitest';

declare const require: any;

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const extensionRoot = path.resolve(new URL('../..', import.meta.url).pathname);

describe('content script build output', () => {
  it('keeps manifest content.js loadable as a classic MV3 content script', () => {
    execFileSync('npm', ['run', 'build'], {
      cwd: extensionRoot,
      encoding: 'utf8',
      stdio: 'pipe',
    });

    const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'dist', 'manifest.json'), 'utf8'));
    const contentScript = fs.readFileSync(path.join(extensionRoot, 'dist', 'content.js'), 'utf8');

    expect(manifest.content_scripts?.[0]?.js).toContain('content.js');
    expect(manifest.content_scripts?.[0]?.type).toBeUndefined();
    expect(contentScript).not.toMatch(/(?:^|[;\n])\s*import(?:\s|[{*(])/);
    expect(contentScript).not.toMatch(/\bfrom\s*["'][^"']+["']/);
  });
});
