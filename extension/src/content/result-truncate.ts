// maybeTruncate caps a sub-agent result before injecting into the chat input.
// Over-long text overflows Monaco editors (a known truncation bug), so cap at
// MAX and append a marker.
const MAX = 8000

export function maybeTruncate(text: string): string {
  if (text.length <= MAX) return text
  return text.slice(0, MAX) + '\n\n…（结果已截断，完整内容见子 agent 日志）'
}
