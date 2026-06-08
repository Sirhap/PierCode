export type CompletionMode = 'skills' | 'files' | 'agents'

export interface CompletionMatch {
  mode: CompletionMode
  token: string  // exact trailing token incl. trigger, e.g. "@@rev"
  query: string  // text after the trigger
}

/**
 * Classify the trailing trigger of an input string.
 * Order matters: @@ (agents) is tested BEFORE @ (files), because the @files
 * regex would otherwise swallow @@x as @x.
 */
export function classifyCompletion(text: string): CompletionMatch | null {
  const slash = text.match(/(?:^|\s)(\/([\w-]*))$/)
  if (slash) return { mode: 'skills', token: slash[1], query: slash[2] }

  const atAt = text.match(/(@@([\w-]*))$/)
  if (atAt) return { mode: 'agents', token: atAt[1], query: atAt[2] }

  const at = text.match(/(@([^\s@]*))$/)
  if (at) return { mode: 'files', token: at[1], query: at[2] }

  return null
}
