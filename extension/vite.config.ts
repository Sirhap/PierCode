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
      name: 'copy-files',
      closeBundle() {
        mkdirSync('dist', { recursive: true })
        copyFileSync('public/manifest.json', 'dist/manifest.json')
        if (existsSync('dist/src/popup/index.html')) {
          copyFileSync('dist/src/popup/index.html', 'dist/popup.html')
        }
        if (existsSync('dist/src/hub/index.html')) {
          copyFileSync('dist/src/hub/index.html', 'dist/hub.html')
        }
      }
    }
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'src/popup/index.html'),
        hub: resolve(__dirname, 'src/hub/index.html'),
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
