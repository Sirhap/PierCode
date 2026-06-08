// Pure command model + fuzzy filter for the Cmd+K palette. No React/chrome so
// it's unit-testable. App.tsx builds the concrete Command[] (with closures over
// its handlers) and passes them to CommandPalette.

export interface Command {
  id: string
  title: string
  hint?: string
  run: () => void
}

// Case-insensitive: substring on title OR hint, else subsequence on title+hint.
export function fuzzyFilter(cmds: Command[], query: string): Command[] {
  const q = query.trim().toLowerCase()
  if (!q) return cmds
  return cmds.filter(c => {
    const hay = `${c.title} ${c.hint || ''}`.toLowerCase()
    if (hay.includes(q)) return true
    // subsequence
    let i = 0
    for (const ch of hay) { if (ch === q[i]) i++; if (i === q.length) return true }
    return false
  })
}
