// dom-extract-config.ts — per-platform DOM selectors for extracting tool-call
// code blocks from rendered messages (Monaco / CodeMirror). Centralized so a
// platform class rename touches only this file.
export const DOM_EXTRACT = {
  qwenToolBlock: 'pre.qwen-markdown-code',
  chatzToolContainer: '.language-piercode-tool, .language-tool',
  codeMirrorContent: '.cm-content',
} as const
