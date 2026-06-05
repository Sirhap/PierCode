# PierCode Landing Page — Design Spec

**Date:** 2026-06-05
**Status:** Approved, ready for implementation planning

## Goal

Replace the current Jekyll-rendered text home page at the project's GitHub Pages
site with a polished, high-tech animated landing page. Keep the existing Jekyll
documentation pages (index/development/FAQ/test-plan) reachable under `/docs/*`,
and preserve all current SEO (meta, Open Graph, JSON-LD, sitemap).

## Non-Goals

- No redesign of the documentation content pages (they keep their Jekyll layout).
- No custom domain (stays on `sirhap.github.io/PierCode/`, per prior decision).
- No backend; the landing page is fully static.

## Visual Direction

- **Style:** "A+C" — neon grid deep-space background + live-terminal aesthetic.
- **Palette:** Catppuccin Mocha, matching the existing Chrome extension UI.
  - Base `#1e1e2e` / deeper `#11111b` / `#0b0b14`
  - Text `#cdd6f4`
  - Accent blue `#89b4fa`
  - Accent green (glow) `#a6e3a1`
  - Muted `#313244` / `#6c7086`
  - Red (sparingly) `#f38ba8`
- **Hero layout:** split — left column copy + CTAs, right column a live terminal
  panel that types/streams real PierCode tool calls
  (`grep`, `edit`, `exec_cmd`, `read_file`, `browser_*`).

## Tech Stack

- **Vite + TypeScript** (build tooling).
- **Three.js** — animated background: particle/line grid, subtle 3D parallax in
  the hero. Lazy-loaded; degrade to a static CSS grid on mobile / reduced-motion.
- **GSAP + ScrollTrigger** — scroll-driven reveals, section transitions, parallax,
  the hero terminal typing sequence.
- No UI framework needed (vanilla TS + GSAP); keep the bundle lean.

## Page Structure (single-page scroll)

1. **Hero** — split copy + live terminal. Headline, subhead, two CTAs
   (Get Started → docs/GitHub, GitHub ★). Neon grid background.
2. **How it works** — 4 steps with animated connectors:
   AI prints a `piercode-tool` block → extension detects it → localhost Go
   server executes in the sandbox → result returned to the AI page.
3. **Features** — glowing card grid: `read_file`, `write_file`, `edit`,
   `apply_patch`, `exec_cmd`, `glob`, `grep`, plus ~25 `browser_*` tools.
4. **Supported platforms** — logo wall: ChatGPT, Claude, Gemini, Google AI
   Studio, Qwen, Kimi, Chat Z, Mimo.
5. **Security** — three points: binds `127.0.0.1`, per-launch token auth,
   working-directory sandbox via real-path resolution.
6. **Quick Start** — 3-step code blocks (install, run server, load extension).
7. **Footer** — GitHub, docs, license.

## Performance & Accessibility

- Three.js (~150KB) lazy-loaded after first paint; never block hero text.
- Respect `prefers-reduced-motion`: disable 3D/particles, keep static grid.
- Mobile: drop the 3D layer, single-column stack, keep the terminal as a static
  styled block.
- Target Lighthouse perf ≥ 80 on mobile despite the animation layer.

## SEO (must not regress)

The landing page is hand-authored HTML, so it owns its `<head>`:

- `<title>`, meta description, meta keywords (carry over current values).
- Open Graph + Twitter card tags.
- Canonical URL `https://sirhap.github.io/PierCode/`.
- `SoftwareApplication` JSON-LD (same as the current Jekyll head/layout).
- The combined sitemap must list the landing page plus the existing
  `/docs/*` pages.

## Deployment Architecture

GitHub Pages can serve from only one source. Switching to a Vite build means the
existing Jekyll docs no longer build automatically, so the workflow must build
both and merge them into one artifact.

- New `site/` directory holds the Vite project (source committed; `dist/` not).
- `.github/workflows/pages.yml`:
  1. Build the Vite landing page → output to artifact root `/`.
  2. Build the Jekyll docs (`docs/`) → output to artifact `/docs/`.
  3. Merge both into a single Pages artifact and deploy.
- Repo **Settings → Pages → Source = GitHub Actions** (manual, one-time, by the
  repo owner).
- The combined artifact's root is the landing page; `/docs/*` are the Jekyll
  pages; `sitemap.xml` covers both.

### Risks / Notes

- If the workflow forgets to build Jekyll, `/docs/*` and the docs sitemap break.
  The workflow must explicitly run the Jekyll build and place it under `/docs/`.
- Three.js bundle size — mitigated by lazy load + mobile degrade.
- The old root `docs/index.md` (Jekyll home) becomes redundant once the landing
  page owns `/`. Decide during implementation whether to keep it reachable at a
  `/docs/` path or drop it (the FAQ/dev pages remain regardless).

## Open Implementation Questions (resolve in plan)

- Exact merge mechanism for the two build outputs in the Actions workflow.
- Where the canonical SEO values live (shared snippet vs duplicated).
- Whether to keep `docs/index.md` as a `/docs/` landing or remove it.
