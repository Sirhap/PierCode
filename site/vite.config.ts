import { defineConfig } from 'vite'

// Served at https://sirhap.github.io/PierCode/ — the GitHub Actions Pages
// workflow places this build at the artifact root and the Jekyll docs under
// /docs. base must match the project subpath so asset URLs resolve.
export default defineConfig({
  base: '/PierCode/',
  build: {
    target: 'es2020',
    outDir: 'dist',
    assetsInlineLimit: 4096,
  },
})
