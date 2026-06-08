/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import { copyFileSync, mkdirSync, existsSync } from 'fs'

export default defineConfig({
  // forks pool (vitest default) intermittently bypasses `vi.mock('js-tiktoken')`
  // for token-meter.ts's lazy `await import('js-tiktoken')`, letting the real
  // tokenizer load and breaking deterministic token-count assertions. threads
  // pool (worker_threads) applies the mock reliably for dynamic imports.
  test: {
    pool: 'threads',
  },
  plugins: [
    react(),
    {
      // Classic MV3 content scripts cannot contain ESM `import`/`export`.
      // content/token-meter.ts lazily `import()`s js-tiktoken, which makes Vite
      // wrap it with the preload helper. Once a SECOND entry (sidebar) also
      // import()s js-tiktoken, Rollup hoists that helper into a shared chunk and
      // emits `import { _ } from "./assets/preload-helper…"` at the top of the
      // classic content.js — breaking it (content-build.test.ts guards this).
      // modulePreload:false already neuters the helper's <link> behaviour, so we
      // can safely inline a passthrough into content.js and drop the static
      // import. The dynamic import() itself (which the browser executes as a
      // module) still resolves the tiktoken chunk at runtime.
      name: 'inline-content-preload-helper',
      generateBundle(_options, bundle) {
        const importRe = /import\s*\{\s*_\s+as\s+(\w+)\s*\}\s*from\s*["']\.\/assets\/preload-helper[^"']*["'];?/
        for (const [fileName, chunk] of Object.entries(bundle)) {
          if (chunk.type !== 'chunk') continue
          if (fileName !== 'content.js' && fileName !== 'injected.js' && fileName !== 'page-bridge.js') continue
          const m = chunk.code.match(importRe)
          if (!m) continue
          const binding = m[1]
          // Passthrough: __vitePreload(fn, deps) → fn(). Deps are no-ops with
          // modulePreload:false, so we ignore them.
          const inlined = `const ${binding}=(o)=>Promise.resolve().then(()=>o());`
          chunk.code = chunk.code.replace(importRe, inlined)
        }
      }
    },
    {
      name: 'copy-files',
      closeBundle() {
        mkdirSync('dist', { recursive: true })
        copyFileSync('public/manifest.json', 'dist/manifest.json')
        if (existsSync('dist/src/popup/index.html')) {
          copyFileSync('dist/src/popup/index.html', 'dist/popup.html')
        }
        if (existsSync('dist/src/sidebar/index.html')) {
          copyFileSync('dist/src/sidebar/index.html', 'dist/sidebar.html')
        }
      }
    }
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Disable Vite's modulePreload helper. With two entries lazily
    // import()-ing js-tiktoken (content/token-meter via token-hud, and
    // sidebar/token-count), Rollup would otherwise hoist a shared
    // preload-helper chunk and emit a static `import ... from` into the
    // classic content.js — which MV3 content scripts can't have
    // (content-build.test.ts guards this). The preload <link> is useless for
    // an extension bundle anyway.
    modulePreload: false,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'src/popup/index.html'),
        sidebar: resolve(__dirname, 'src/sidebar/index.html'),
        content: resolve(__dirname, 'src/content/index.ts'),
        injected: resolve(__dirname, 'src/injected/index.ts'),
        pageBridge: resolve(__dirname, 'src/page-bridge/index.ts'),
        background: resolve(__dirname, 'src/background/index.ts')
      },
      output: {
        entryFileNames: chunk => chunk.name === 'pageBridge' ? 'page-bridge.js' : '[name].js'
      }
    }
  }
})
