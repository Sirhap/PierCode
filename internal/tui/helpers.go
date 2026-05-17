package tui

import (
	"regexp"
	"strings"

	"github.com/mattn/go-runewidth"
)

// ansiSeq matches anything that looks like a terminal escape sequence so we
// can strip it before rendering AI output. We treat ALL of:
//   - CSI: \x1b[ ... letter        (colors, cursor moves, clears)
//   - OSC: \x1b] ... BEL or ST     (hyperlinks, terminal title)
//   - Other ESC + single byte      (charset switches, RIS \x1bc, etc.)
//
// Note: we deliberately do NOT match a generic "control byte" class here.
// Earlier versions did, then tried to swap \n / \r / \t in and out via
// placeholders to preserve them — but the placeholders themselves used
// control bytes which were eaten by the same regex. Newlines, tabs and
// carriage returns are load-bearing in our markdown / wrap pipeline, so we
// just leave non-ESC control bytes untouched. The remaining attack surface
// (e.g. raw \x07 bell) is acceptable; the dangerous payloads are all
// ESC-prefixed.
var ansiSeq = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]`)

// stripANSI removes terminal escape sequences from s. Newlines, carriage
// returns, and tabs are preserved.
func stripANSI(s string) string {
	if s == "" {
		return s
	}
	return ansiSeq.ReplaceAllString(s, "")
}

// stringDisplayWidth returns the column count that s occupies when rendered
// to a terminal — handles East Asian wide chars (CJK), emoji, ZWJ sequences.
// runewidth ships with lipgloss as an indirect dep so this costs nothing.
func stringDisplayWidth(s string) int {
	return runewidth.StringWidth(s)
}

// wrapByDisplayWidth splits s into lines whose terminal display width does not
// exceed `width`. Replaces the old rune-count-based wrapString which counted a
// CJK char as 1 column and produced double-width overflows that broke the
// layout (status strip and dividers misaligned).
//
// We don't break inside an ANSI sequence because we strip ANSI before this
// runs; we don't break inside a grapheme cluster because runewidth treats ZWJ
// emoji clusters as a single unit when used via TruncateByCondition. For our
// scope (markdown bodies, command output) the simple greedy split below is
// good enough.
func wrapByDisplayWidth(s string, width int) []string {
	if width <= 0 {
		return []string{s}
	}
	if s == "" {
		return []string{""}
	}
	var lines []string
	var cur strings.Builder
	curWidth := 0
	for _, r := range s {
		w := runewidth.RuneWidth(r)
		// A single wide rune that already exceeds width: emit it on its own
		// line rather than enter an infinite loop.
		if w > width {
			if cur.Len() > 0 {
				lines = append(lines, cur.String())
				cur.Reset()
				curWidth = 0
			}
			lines = append(lines, string(r))
			continue
		}
		if curWidth+w > width {
			lines = append(lines, cur.String())
			cur.Reset()
			curWidth = 0
		}
		cur.WriteRune(r)
		curWidth += w
	}
	if cur.Len() > 0 || len(lines) == 0 {
		lines = append(lines, cur.String())
	}
	return lines
}

// truncateToDisplayWidth shortens s so it fits in `maxWidth` terminal columns,
// appending "…" when truncated. CJK-aware — counts wide chars as 2.
func truncateToDisplayWidth(s string, maxWidth int) string {
	if maxWidth <= 0 {
		return ""
	}
	if stringDisplayWidth(s) <= maxWidth {
		return s
	}
	if maxWidth <= 1 {
		// no room for ellipsis — best-effort hard truncate
		return runewidth.Truncate(s, maxWidth, "")
	}
	return runewidth.Truncate(s, maxWidth, "…")
}

// containsCJK reports whether s contains any East Asian wide character. Used
// by Enter handling to decide if a "soft" Enter should be treated as IME
// candidate confirmation rather than a real submit.
func containsCJK(s string) bool {
	for _, r := range s {
		if runewidth.RuneWidth(r) > 1 {
			return true
		}
	}
	return false
}
