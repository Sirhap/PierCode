import { useEffect, useState, useCallback } from 'react'
import { type Glow, normalizeGlow, DEFAULT_GLOW, GLOW_STORAGE_KEY } from './glow'

// Reads the saved glow color, applies it to <html data-glow="...">, and returns
// a setter that persists + re-applies. theme.css keys all --glow off that attr.
export function useGlow(): [Glow, (g: Glow) => void] {
  const [glow, setGlowState] = useState<Glow>(DEFAULT_GLOW)

  useEffect(() => {
    chrome.storage.local.get([GLOW_STORAGE_KEY], (res) => {
      const g = normalizeGlow(res[GLOW_STORAGE_KEY])
      setGlowState(g)
      document.documentElement.setAttribute('data-glow', g)
    })
  }, [])

  const setGlow = useCallback((g: Glow) => {
    setGlowState(g)
    document.documentElement.setAttribute('data-glow', g)
    chrome.storage.local.set({ [GLOW_STORAGE_KEY]: g })
  }, [])

  return [glow, setGlow]
}
