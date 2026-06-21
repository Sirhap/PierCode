// #10 explicit trigger prefix (optional mode).
//
// When the user enables "explicit trigger mode" (storage flag explicitTriggerMode,
// default OFF), tool-fence detection for a turn only activates if the user's
// message carried a /piercode or @piercode prefix. Default OFF preserves the
// current full-scan behaviour exactly. This leaf is the pure detector; the gate
// itself lives in content/index.ts (scanText). Dependency-free so it stays in the
// classic-MV3 content bundle.

// Matches a /piercode or @piercode trigger token. Anchored to a token boundary
// (start-of-string or whitespace) so it isn't matched inside a URL/path/word
// (e.g. "x/piercode" or an email). The token may stand alone or be followed by
// more text ("/piercode read the file").
const TRIGGER_RE = /(^|\s)[/@]piercode\b/i;

/** True if `text` contains a /piercode or @piercode trigger token. */
export function messageHasPierCodeTrigger(text: string): boolean {
  if (!text) return false;
  return TRIGGER_RE.test(text);
}
