package tui

import (
	"strings"

	"github.com/charmbracelet/lipgloss"
)

func renderMarkdownLines(markdown string, width int, prefix string) []string {
	width = maxInt(8, width)
	var lines []string
	inCode := false
	codeLang := ""

	for _, raw := range strings.Split(strings.ReplaceAll(markdown, "\r\n", "\n"), "\n") {
		line := strings.TrimRight(raw, "\r")
		trimmed := strings.TrimSpace(line)

		if strings.HasPrefix(trimmed, "```") {
			if !inCode {
				inCode = true
				codeLang = strings.TrimSpace(strings.TrimPrefix(trimmed, "```"))
				label := "code"
				if codeLang != "" {
					label += " " + codeLang
				}
				lines = append(lines, prefix+lipgloss.NewStyle().Foreground(colorMuted).Render("``` "+label))
			} else {
				inCode = false
				codeLang = ""
				lines = append(lines, prefix+lipgloss.NewStyle().Foreground(colorMuted).Render("```"))
			}
			continue
		}

		if inCode {
			codeWidth := maxInt(8, width-2)
			for _, wrapped := range wrapString(line, codeWidth) {
				lines = append(lines, prefix+lipgloss.NewStyle().Foreground(colorCyan).Render("│ "+wrapped))
			}
			continue
		}

		if trimmed == "" {
			lines = append(lines, "")
			continue
		}

		if isMarkdownRule(trimmed) {
			lines = append(lines, prefix+ruleStyle.Render(strings.Repeat("─", maxInt(8, minInt(width, 48)))))
			continue
		}

		if heading, ok := markdownHeading(trimmed); ok {
			for _, wrapped := range wrapString(heading, width) {
				lines = append(lines, prefix+lipgloss.NewStyle().Foreground(colorAccent).Bold(true).Render(wrapped))
			}
			continue
		}

		if quote, ok := markdownQuote(trimmed); ok {
			for _, wrapped := range wrapString(quote, maxInt(8, width-2)) {
				lines = append(lines, prefix+lipgloss.NewStyle().Foreground(colorMuted).Render("│ "+wrapped))
			}
			continue
		}

		if item, ok := markdownListItem(trimmed); ok {
			itemWidth := maxInt(8, width-2)
			wrapped := wrapString(item, itemWidth)
			for i, part := range wrapped {
				if i == 0 {
					lines = append(lines, prefix+lipgloss.NewStyle().Foreground(colorText).Render("• "+part))
				} else {
					lines = append(lines, prefix+lipgloss.NewStyle().Foreground(colorText).Render("  "+part))
				}
			}
			continue
		}

		for _, wrapped := range wrapTextWithInlineCode(line, width) {
			lines = append(lines, prefix+wrapped)
		}
	}

	return lines
}

func markdownHeading(line string) (string, bool) {
	if !strings.HasPrefix(line, "#") {
		return "", false
	}
	count := 0
	for _, r := range line {
		if r != '#' {
			break
		}
		count++
	}
	if count == 0 || count > 6 || len(line) <= count || line[count] != ' ' {
		return "", false
	}
	return strings.TrimSpace(line[count:]), true
}

func markdownQuote(line string) (string, bool) {
	if !strings.HasPrefix(line, ">") {
		return "", false
	}
	return strings.TrimSpace(strings.TrimLeft(line, ">")), true
}

func markdownListItem(line string) (string, bool) {
	for _, marker := range []string{"- ", "* ", "+ "} {
		if strings.HasPrefix(line, marker) {
			return strings.TrimSpace(strings.TrimPrefix(line, marker)), true
		}
	}
	dot := strings.Index(line, ". ")
	if dot <= 0 || dot > 3 {
		return "", false
	}
	for _, r := range line[:dot] {
		if r < '0' || r > '9' {
			return "", false
		}
	}
	return strings.TrimSpace(line[dot+2:]), true
}

func isMarkdownRule(line string) bool {
	if len(line) < 3 {
		return false
	}
	first := line[0]
	if first != '-' && first != '*' && first != '_' {
		return false
	}
	for i := 0; i < len(line); i++ {
		if line[i] != first && line[i] != ' ' {
			return false
		}
	}
	return true
}

func wrapTextWithInlineCode(line string, width int) []string {
	style := lipgloss.NewStyle().Foreground(colorText)
	return styleWrap(line, width, style)
}

func styleWrap(line string, width int, style lipgloss.Style) []string {
	wrapped := wrapString(line, width)
	for i := range wrapped {
		wrapped[i] = style.Render(wrapped[i])
	}
	return wrapped
}
