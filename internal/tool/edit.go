package tool

import (
	"bytes"
	"errors"
	"fmt"
	"math"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/sirhap/piercode/internal/types"
)

type EditTool struct {
	config *types.Config
}

func NewEditTool(config *types.Config) *EditTool {
	return &EditTool{config: config}
}

func (t *EditTool) Name() string { return "edit" }
func (t *EditTool) Description() string {
	return `Performs exact string replacements in files.

Usage:
- You must use ` + "`read_file`" + ` at least once in the conversation before editing a file. Read first so you match the real content.
- When editing text from read_file output, preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The prefix format is ` + "`<lineno>\\t`" + ` (line number + tab). Everything after the tab is the actual file content to match. Never include any part of the line number prefix in old_string or new_string.
- ALWAYS prefer editing existing files. Do NOT create new files unless required.
- Only use emojis if the user explicitly requests it.
- The edit FAILS if old_string is not unique in the file. Either provide a larger string with more surrounding context to make it unique, or set replace_all to change every instance.
- Use the smallest old_string that is clearly unique — usually 2-4 adjacent lines is enough. Avoid 10+ lines of context when less uniquely identifies the target.
- Use replace_all for renaming a variable or string across the whole file.`
}
func (t *EditTool) Parameters() interface{} {
	return map[string]string{
		"path":        "string (required) - file path",
		"old_string":  "string (required) - text to replace",
		"new_string":  "string (required) - replacement text",
		"replace_all": "bool (optional) - replace all occurrences (default false)",
	}
}

func (t *EditTool) Validate(args map[string]interface{}) error {
	if p, ok := args["path"].(string); !ok || p == "" {
		return errors.New("path is required")
	}
	if _, ok := args["old_string"].(string); !ok {
		return errors.New("old_string is required")
	}
	if _, ok := args["new_string"].(string); !ok {
		return errors.New("new_string is required")
	}
	return nil
}

func (t *EditTool) Execute(ctx *Context) *Result {
	result := &Result{StartTime: time.Now()}
	path, _ := ctx.Args["path"].(string)
	oldStr, _ := ctx.Args["old_string"].(string)
	newStr, _ := ctx.Args["new_string"].(string)
	replaceAll, _ := ctx.Args["replace_all"].(bool)

	safePath, err := ctx.ResolvePath(path)
	if err != nil {
		result.Status = "error"
		result.Error = err.Error()
		return result
	}

	rawContent, err := os.ReadFile(safePath)
	if err != nil {
		result.Status = "error"
		result.Error = err.Error()
		return result
	}

	// Preserve the file's original line endings. Earlier we'd detect "any \r\n
	// in the file" and rewrite every \n to \r\n on save — that silently broke
	// files with mixed endings (e.g. a CRLF file with one stray LF). New
	// strategy: do CRLF→LF normalization only on the search/replace path
	// (matching is tolerant), then splice the new region back into the
	// *original raw bytes* so any line that wasn't part of the edit keeps
	// whatever ending it had on disk.
	originalContent := string(rawContent)
	content := normalizeLineEndings(originalContent)

	replaced, count, err := replace(content, oldStr, newStr, replaceAll)
	if err != nil {
		result.Status = "error"
		result.Error = err.Error()
		return result
	}

	// If the original file was pure-LF, the normalized content is identical
	// to the raw bytes, so we can write `replaced` directly. If it had any
	// CRLFs, recompute the new full content by splicing newStr into the raw
	// bytes at the same logical position. We do this by re-running the
	// replacement against the original (un-normalized) content where
	// possible; if the original used CRLF, oldStr likely came from the AI in
	// LF form, so we also try the CRLF-converted variant before giving up.
	var outBytes []byte
	if !bytes.Contains(rawContent, []byte("\r\n")) {
		outBytes = []byte(replaced)
	} else {
		// Try LF-form first (some editors author CRLF files with LF lines mixed in).
		newRaw, rawCount, ok := spliceOnRaw(originalContent, oldStr, newStr, replaceAll)
		if !ok {
			// Try the CRLF-form of oldStr/newStr against the raw content.
			oldCRLF := strings.ReplaceAll(strings.ReplaceAll(oldStr, "\r\n", "\n"), "\n", "\r\n")
			newCRLF := strings.ReplaceAll(strings.ReplaceAll(newStr, "\r\n", "\n"), "\n", "\r\n")
			newRaw, rawCount, ok = spliceOnRaw(originalContent, oldCRLF, newCRLF, replaceAll)
		}
		if ok {
			outBytes = []byte(newRaw)
			// Report the count from the run we actually wrote, not the
			// LF-normalized run above.
			count = rawCount
		} else {
			// Fall back to the LF-normalized result. Mixed-ending files will
			// be normalized to LF here — that's worse than perfect but still
			// honest, and this branch only fires when neither LF nor CRLF
			// forms of oldStr matched the raw bytes.
			outBytes = []byte(replaced)
		}
	}

	// Snapshot the prior state before writing so `undo` can restore it.
	_ = snapshotPaths(ctx.EffectiveRootDir(), "edit", safePath)
	if err := os.WriteFile(safePath, outBytes, 0644); err != nil {
		result.Status = "error"
		result.Error = err.Error()
		return result
	}

	result.Status = "success"
	if replaceAll && count > 1 {
		result.Output = fmt.Sprintf("已替换 %d 处 '%s' → '%s'", count, oldStr, newStr)
	} else {
		result.Output = fmt.Sprintf("已替换 '%s' → '%s'", oldStr, newStr)
	}
	result.EndTime = time.Now()
	return result
}

// ── 常量 ──────────────────────────────────────────────────────────────────────

// Block/context anchor matchers compare trimmed lines via Levenshtein similarity.
// Earlier defaults (0.5 / 0.3) were aggressive enough to silently replace the
// wrong block in large files. Tightened to mirror Claude Code's preference for
// failing loudly over guessing — the AI can retry with more surrounding context.
const singleCandidateSimilarityThreshold = 0.85
const multipleCandidatesSimilarityThreshold = 0.95
const contextAwareSimilarityThreshold = 0.85

// ── 辅助函数 ──────────────────────────────────────────────────────────────────

func normalizeLineEndings(s string) string {
	return strings.ReplaceAll(s, "\r\n", "\n")
}

// spliceOnRaw tries to replace oldStr with newStr in raw without any line-ending
// normalization. Returns the new content, the number of replacements made, and
// true if oldStr was found. Used to preserve the original file's mixed/CRLF
// endings when the AI sent the edit in matching form.
func spliceOnRaw(raw, oldStr, newStr string, replaceAll bool) (string, int, bool) {
	if oldStr == "" {
		return raw, 0, false
	}
	if !strings.Contains(raw, oldStr) {
		return raw, 0, false
	}
	if replaceAll {
		count := strings.Count(raw, oldStr)
		return strings.ReplaceAll(raw, oldStr, newStr), count, true
	}
	// Single replace: only if exactly one match — otherwise refuse so the
	// caller falls back to the smarter Replacer cascade.
	if strings.Count(raw, oldStr) != 1 {
		return raw, 0, false
	}
	return strings.Replace(raw, oldStr, newStr, 1), 1, true
}

func levenshtein(a, b string) int {
	if a == "" {
		return len(b)
	}
	if b == "" {
		return len(a)
	}
	matrix := make([][]int, len(a)+1)
	for i := range matrix {
		matrix[i] = make([]int, len(b)+1)
		matrix[i][0] = i
	}
	for j := 0; j <= len(b); j++ {
		matrix[0][j] = j
	}
	for i := 1; i <= len(a); i++ {
		for j := 1; j <= len(b); j++ {
			cost := 1
			if a[i-1] == b[j-1] {
				cost = 0
			}
			matrix[i][j] = min3(matrix[i-1][j]+1, matrix[i][j-1]+1, matrix[i-1][j-1]+cost)
		}
	}
	return matrix[len(a)][len(b)]
}

func min3(a, b, c int) int {
	if a < b {
		if a < c {
			return a
		}
		return c
	}
	if b < c {
		return b
	}
	return c
}

// ── Replacer 类型 ─────────────────────────────────────────────────────────────

// Replacer 返回在 content 中找到的候选匹配串列表。
type Replacer func(content, find string) []string

// ── 1. SimpleReplacer ─────────────────────────────────────────────────────────

func SimpleReplacer(content, find string) []string {
	return []string{find}
}

// ── 2. LineTrimmedReplacer ────────────────────────────────────────────────────

func LineTrimmedReplacer(content, find string) []string {
	originalLines := strings.Split(content, "\n")
	searchLines := strings.Split(find, "\n")

	// pop trailing empty line (find ends with \n)
	if len(searchLines) > 0 && searchLines[len(searchLines)-1] == "" {
		searchLines = searchLines[:len(searchLines)-1]
	}
	if len(searchLines) == 0 {
		return nil
	}

	var results []string
	for i := 0; i <= len(originalLines)-len(searchLines); i++ {
		matches := true
		for j := 0; j < len(searchLines); j++ {
			if strings.TrimSpace(originalLines[i+j]) != strings.TrimSpace(searchLines[j]) {
				matches = false
				break
			}
		}
		if !matches {
			continue
		}
		// 计算字节偏移
		matchStart := 0
		for k := 0; k < i; k++ {
			matchStart += len(originalLines[k]) + 1 // +1 for \n
		}
		matchEnd := matchStart
		for k := 0; k < len(searchLines); k++ {
			matchEnd += len(originalLines[i+k])
			if k < len(searchLines)-1 {
				matchEnd += 1 // \n between lines, not after last
			}
		}
		results = append(results, content[matchStart:matchEnd])
	}
	return results
}

// ── 3. BlockAnchorReplacer ────────────────────────────────────────────────────

type anchorCandidate struct {
	startLine, endLine int
}

func BlockAnchorReplacer(content, find string) []string {
	originalLines := strings.Split(content, "\n")
	searchLines := strings.Split(find, "\n")

	if len(searchLines) < 3 {
		return nil
	}
	if searchLines[len(searchLines)-1] == "" {
		searchLines = searchLines[:len(searchLines)-1]
	}
	if len(searchLines) < 3 {
		return nil
	}

	firstLineSearch := strings.TrimSpace(searchLines[0])
	lastLineSearch := strings.TrimSpace(searchLines[len(searchLines)-1])
	searchBlockSize := len(searchLines)

	// 收集所有候选
	var candidates []anchorCandidate
	for i := 0; i < len(originalLines); i++ {
		if strings.TrimSpace(originalLines[i]) != firstLineSearch {
			continue
		}
		for j := i + 2; j < len(originalLines); j++ {
			if strings.TrimSpace(originalLines[j]) == lastLineSearch {
				candidates = append(candidates, anchorCandidate{i, j})
				break
			}
		}
	}
	if len(candidates) == 0 {
		return nil
	}

	blockToSubstring := func(startLine, endLine int) string {
		matchStart := 0
		for k := 0; k < startLine; k++ {
			matchStart += len(originalLines[k]) + 1
		}
		matchEnd := matchStart
		for k := startLine; k <= endLine; k++ {
			matchEnd += len(originalLines[k])
			if k < endLine {
				matchEnd += 1
			}
		}
		return content[matchStart:matchEnd]
	}

	if len(candidates) == 1 {
		c := candidates[0]
		actualBlockSize := c.endLine - c.startLine + 1
		linesToCheck := searchBlockSize - 2
		if actualBlockSize-2 < linesToCheck {
			linesToCheck = actualBlockSize - 2
		}

		similarity := 0.0
		if linesToCheck > 0 {
			for j := 1; j < searchBlockSize-1 && j < actualBlockSize-1; j++ {
				origLine := strings.TrimSpace(originalLines[c.startLine+j])
				srchLine := strings.TrimSpace(searchLines[j])
				maxLen := math.Max(float64(len(origLine)), float64(len(srchLine)))
				if maxLen == 0 {
					continue
				}
				dist := levenshtein(origLine, srchLine)
				similarity += (1 - float64(dist)/maxLen) / float64(linesToCheck)
				if similarity >= singleCandidateSimilarityThreshold {
					break
				}
			}
		} else {
			similarity = 1.0
		}

		if similarity >= singleCandidateSimilarityThreshold {
			return []string{blockToSubstring(c.startLine, c.endLine)}
		}
		return nil
	}

	// 多候选：取相似度最高的
	bestIdx := -1
	maxSimilarity := -1.0
	for i, c := range candidates {
		actualBlockSize := c.endLine - c.startLine + 1
		linesToCheck := searchBlockSize - 2
		if actualBlockSize-2 < linesToCheck {
			linesToCheck = actualBlockSize - 2
		}

		similarity := 0.0
		if linesToCheck > 0 {
			for j := 1; j < searchBlockSize-1 && j < actualBlockSize-1; j++ {
				origLine := strings.TrimSpace(originalLines[c.startLine+j])
				srchLine := strings.TrimSpace(searchLines[j])
				maxLen := math.Max(float64(len(origLine)), float64(len(srchLine)))
				if maxLen == 0 {
					continue
				}
				dist := levenshtein(origLine, srchLine)
				similarity += 1 - float64(dist)/maxLen
			}
			similarity /= float64(linesToCheck)
		} else {
			similarity = 1.0
		}

		if similarity > maxSimilarity {
			maxSimilarity = similarity
			bestIdx = i
		}
	}

	if maxSimilarity >= multipleCandidatesSimilarityThreshold && bestIdx >= 0 {
		c := candidates[bestIdx]
		return []string{blockToSubstring(c.startLine, c.endLine)}
	}
	return nil
}

// ── 4. WhitespaceNormalizedReplacer ──────────────────────────────────────────

var wsRegexp = regexp.MustCompile(`\s+`)

func normalizeWhitespace(s string) string {
	return wsRegexp.ReplaceAllString(strings.TrimSpace(s), " ")
}

func WhitespaceNormalizedReplacer(content, find string) []string {
	normalizedFind := normalizeWhitespace(find)
	lines := strings.Split(content, "\n")
	var results []string

	// 阶段一：单行匹配
	for _, line := range lines {
		normalizedLine := normalizeWhitespace(line)
		if normalizedLine == normalizedFind {
			results = append(results, line)
		} else if strings.Contains(normalizedLine, normalizedFind) {
			// 构造正则：每个词做 QuoteMeta，用 \s+ 连接
			words := wsRegexp.Split(strings.TrimSpace(find), -1)
			if len(words) > 0 {
				quoted := make([]string, len(words))
				for i, w := range words {
					quoted[i] = regexp.QuoteMeta(w)
				}
				pattern := strings.Join(quoted, `\s+`)
				re, err := regexp.Compile(pattern)
				if err == nil {
					if m := re.FindString(line); m != "" {
						results = append(results, m)
					}
				}
			}
		}
	}

	// 阶段二：多行匹配（仅当 find 含换行）
	findLines := strings.Split(find, "\n")
	if len(findLines) > 1 {
		for i := 0; i <= len(lines)-len(findLines); i++ {
			block := strings.Join(lines[i:i+len(findLines)], "\n")
			if normalizeWhitespace(block) == normalizedFind {
				results = append(results, block)
			}
		}
	}
	return results
}

// ── 5. IndentationFlexibleReplacer ────────────────────────────────────────────

func removeIndentation(text string) string {
	lines := strings.Split(text, "\n")
	minIndent := -1
	for _, l := range lines {
		if strings.TrimSpace(l) == "" {
			continue
		}
		n := len(l) - len(strings.TrimLeft(l, " \t"))
		if minIndent < 0 || n < minIndent {
			minIndent = n
		}
	}
	if minIndent <= 0 {
		return text
	}
	out := make([]string, len(lines))
	for i, l := range lines {
		if strings.TrimSpace(l) == "" {
			out[i] = l
		} else {
			out[i] = l[minIndent:]
		}
	}
	return strings.Join(out, "\n")
}

func IndentationFlexibleReplacer(content, find string) []string {
	normalizedFind := removeIndentation(find)
	contentLines := strings.Split(content, "\n")
	findLines := strings.Split(find, "\n")

	var results []string
	for i := 0; i <= len(contentLines)-len(findLines); i++ {
		block := strings.Join(contentLines[i:i+len(findLines)], "\n")
		if removeIndentation(block) == normalizedFind {
			results = append(results, block)
		}
	}
	return results
}

// ── 6. EscapeNormalizedReplacer ───────────────────────────────────────────────

var escapeRegexp = regexp.MustCompile(`\\(n|t|r|'|"|` + "`" + `|\\|\n|\$)`)

func unescapeString(s string) string {
	return escapeRegexp.ReplaceAllStringFunc(s, func(match string) string {
		if len(match) < 2 {
			return match
		}
		switch match[1] {
		case 'n':
			return "\n"
		case 't':
			return "\t"
		case 'r':
			return "\r"
		case '\'':
			return "'"
		case '"':
			return "\""
		case '`':
			return "`"
		case '\\':
			return "\\"
		case '\n':
			return "\n"
		case '$':
			return "$"
		default:
			return match
		}
	})
}

func EscapeNormalizedReplacer(content, find string) []string {
	unescapedFind := unescapeString(find)
	var results []string

	// 步骤一：直接包含
	if strings.Contains(content, unescapedFind) {
		results = append(results, unescapedFind)
	}

	// 步骤二：滑动窗口，对每个 block 做 unescape 后比较
	lines := strings.Split(content, "\n")
	findLines := strings.Split(unescapedFind, "\n")
	for i := 0; i <= len(lines)-len(findLines); i++ {
		block := strings.Join(lines[i:i+len(findLines)], "\n")
		if unescapeString(block) == unescapedFind {
			results = append(results, block)
		}
	}
	return results
}

// ── 7. TrimmedBoundaryReplacer ────────────────────────────────────────────────

func TrimmedBoundaryReplacer(content, find string) []string {
	trimmedFind := strings.TrimSpace(find)
	if trimmedFind == find {
		return nil // 已经是 trimmed，无意义
	}

	var results []string

	// 步骤一：直接包含
	if strings.Contains(content, trimmedFind) {
		results = append(results, trimmedFind)
	}

	// 步骤二：滑动窗口
	lines := strings.Split(content, "\n")
	findLines := strings.Split(find, "\n")
	for i := 0; i <= len(lines)-len(findLines); i++ {
		block := strings.Join(lines[i:i+len(findLines)], "\n")
		if strings.TrimSpace(block) == trimmedFind {
			results = append(results, block)
		}
	}
	return results
}

// ── 8. TabNewlineReplacer ─────────────────────────────────────────────────────
// 处理 AI 模型将换行符误写为 \t 的情况：
// 若 find 不含真正的 \n 但含 \t，则把每个 \t 替换为 \n\t 后再尝试匹配。

func TabNewlineReplacer(content, find string) []string {
	// 已有真正换行符，不需要此替换器
	if strings.Contains(find, "\n") {
		return nil
	}
	if !strings.Contains(find, "\t") {
		return nil
	}
	fixed := strings.ReplaceAll(find, "\t", "\n\t")
	// 用 SimpleReplacer 逻辑：直接返回 fixed，由外层检查是否存在
	return []string{fixed}
}

// ── PunctuationNormalizedReplacer ─────────────────────────────────────────────
// 处理"智能标点"不一致：浏览器 AI 页常把直引号/单引号/连字符自动转成
// 弯引号 “ ” ‘ ’、长破折号 — 或省略号 …，导致 old_string 与磁盘上的 ASCII
// 文本无法逐字匹配。把 find 与 content 各 block 都归一到 ASCII 后比较；命中后
// 返回的是 content 的原始 block（保留磁盘上的实际字符），由外层 strings.Index 定位。
//
// 移植自 Claude Code 的 normalizeQuotes（扩展到破折号/省略号）。

var punctuationReplacements = strings.NewReplacer(
	"‘", "'", // ‘ left single quote
	"’", "'", // ’ right single quote / apostrophe
	"“", "\"", // “ left double quote
	"”", "\"", // ” right double quote
	"–", "-", // – en dash
	"—", "-", // — em dash
	"…", "...", // … ellipsis
	" ", " ", // non-breaking space
)

func normalizePunctuation(s string) string {
	return punctuationReplacements.Replace(s)
}

func PunctuationNormalizedReplacer(content, find string) []string {
	normFind := normalizePunctuation(find)
	// No smart punctuation involved on either side → nothing this replacer adds.
	if normFind == find && normalizePunctuation(content) == content {
		return nil
	}

	var results []string

	// Whole-string: a content block whose normalized form equals the
	// normalized find. Slide a window the same number of lines as find.
	lines := strings.Split(content, "\n")
	findLines := strings.Split(find, "\n")
	for i := 0; i+len(findLines) <= len(lines); i++ {
		block := strings.Join(lines[i:i+len(findLines)], "\n")
		if normalizePunctuation(block) == normFind {
			results = append(results, block)
		}
	}
	return results
}

// ── ContextAwareReplacer ──────────────────────────────────────────────────────

func ContextAwareReplacer(content, find string) []string {
	findLines := strings.Split(find, "\n")
	if len(findLines) < 3 {
		return nil
	}
	if findLines[len(findLines)-1] == "" {
		findLines = findLines[:len(findLines)-1]
	}
	if len(findLines) < 3 {
		return nil
	}

	firstLine := strings.TrimSpace(findLines[0])
	lastLine := strings.TrimSpace(findLines[len(findLines)-1])
	contentLines := strings.Split(content, "\n")

	for i := 0; i < len(contentLines); i++ {
		if strings.TrimSpace(contentLines[i]) != firstLine {
			continue
		}
		for j := i + 2; j < len(contentLines); j++ {
			if strings.TrimSpace(contentLines[j]) != lastLine {
				continue
			}
			blockLines := contentLines[i : j+1]
			if len(blockLines) != len(findLines) {
				break
			}
			// 统计中间行相似度
			matchingLines := 0
			totalNonEmpty := 0
			for k := 1; k < len(blockLines)-1; k++ {
				bl := strings.TrimSpace(blockLines[k])
				fl := strings.TrimSpace(findLines[k])
				if bl != "" || fl != "" {
					totalNonEmpty++
					if bl == fl {
						matchingLines++
					}
				}
			}
			if totalNonEmpty == 0 || float64(matchingLines)/float64(totalNonEmpty) >= contextAwareSimilarityThreshold {
				return []string{strings.Join(blockLines, "\n")}
			}
			break
		}
	}
	return nil
}

// ── replace 主函数 ─────────────────────────────────────────────────────────────

type replacementSpan struct {
	start int
	end   int
}

func collectReplacementSpans(content string, searches []string) []replacementSpan {
	seen := make(map[replacementSpan]struct{})
	for _, search := range searches {
		if search == "" {
			continue
		}
		offset := 0
		for offset <= len(content) {
			idx := strings.Index(content[offset:], search)
			if idx == -1 {
				break
			}
			start := offset + idx
			span := replacementSpan{start: start, end: start + len(search)}
			seen[span] = struct{}{}
			offset = span.end
		}
	}

	spans := make([]replacementSpan, 0, len(seen))
	for span := range seen {
		spans = append(spans, span)
	}
	sort.Slice(spans, func(i, j int) bool {
		if spans[i].start != spans[j].start {
			return spans[i].start < spans[j].start
		}
		return spans[i].end > spans[j].end
	})

	filtered := spans[:0]
	lastEnd := -1
	for _, span := range spans {
		if span.start < lastEnd {
			continue
		}
		filtered = append(filtered, span)
		lastEnd = span.end
	}
	return filtered
}

func applyReplacementSpans(content string, spans []replacementSpan, newString string) string {
	var b strings.Builder
	b.Grow(len(content) + len(spans)*len(newString))
	cursor := 0
	for _, span := range spans {
		b.WriteString(content[cursor:span.start])
		b.WriteString(newString)
		cursor = span.end
	}
	b.WriteString(content[cursor:])
	return b.String()
}

func replace(content, oldString, newString string, replaceAll bool) (string, int, error) {
	if oldString == newString {
		return "", 0, errors.New("No changes to apply: oldString and newString are identical.")
	}

	notFound := true

	for _, replacer := range []Replacer{
		SimpleReplacer,
		PunctuationNormalizedReplacer,
		LineTrimmedReplacer,
		BlockAnchorReplacer,
		WhitespaceNormalizedReplacer,
		IndentationFlexibleReplacer,
		EscapeNormalizedReplacer,
		TrimmedBoundaryReplacer,
		TabNewlineReplacer,
		ContextAwareReplacer,
	} {
		searches := replacer(content, oldString)
		if replaceAll {
			spans := collectReplacementSpans(content, searches)
			if len(spans) > 0 {
				return applyReplacementSpans(content, spans, newString), len(spans), nil
			}
			continue
		}
		for _, search := range searches {
			index := strings.Index(content, search)
			if index == -1 {
				continue
			}
			notFound = false
			lastIndex := strings.LastIndex(content, search)
			if index != lastIndex {
				continue // 出现多次，跳过这个候选
			}
			return content[:index] + newString + content[index+len(search):], 1, nil
		}
	}

	if notFound {
		return "", 0, errors.New("Could not find old_string in the file. It must match exactly, including whitespace, indentation, and line endings.")
	}
	return "", 0, errors.New("Found multiple matches for old_string. Provide more surrounding context to make the match unique, or set replace_all=true to replace every occurrence.")
}
