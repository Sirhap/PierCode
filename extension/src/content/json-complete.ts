// isBalancedJson reports whether a JSON-ish string has balanced top-level braces
// (string-aware). Replaces the over-eager endsWith('}') streaming-completeness
// check, which false-negatives on trailing whitespace and false-positives on a
// `}` that sits inside a string value.
export function isBalancedJson(s: string): boolean {
  const t = s.trim()
  if (!t.startsWith('{')) return false
  let depth = 0, inStr = false, esc = false, sawClose = false
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; continue }
    if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) sawClose = true }
  }
  return depth === 0 && sawClose && !inStr
}
