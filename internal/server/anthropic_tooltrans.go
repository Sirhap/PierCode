package server

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// tool_use translation for the Anthropic-API impersonation.
//
// Claude Code sends tool definitions and expects the "model" to answer with
// structured tool_use blocks. A browser AI page only emits chat text, so we:
//  1. append a protocol preamble telling the page to emit a fenced JSON block
//     when it wants to call a tool, and
//  2. parse that block back out of the page's reply and re-encode it as an
//     Anthropic tool_use block.
//
// The fence tag is deliberately unusual (`piercode-call`) so it does not
// collide with ordinary code blocks the page might produce.

const toolCallFence = "piercode-call"

type anthropicToolDef struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"input_schema"`
}

type parsedToolCall struct {
	Name  string                 `json:"tool"`
	Input map[string]interface{} `json:"input"`
}

// buildToolProtocolPreamble produces the instruction appended to the prompt so
// the browser AI knows it is acting as a tool-using API backend. It lists the
// available tool names (the full schemas already arrive via the flattened
// system/messages content) and pins the exact output contract.
func buildToolProtocolPreamble(tools []anthropicToolDef) string {
	if len(tools) == 0 {
		return ""
	}
	names := make([]string, 0, len(tools))
	for _, t := range tools {
		if n := strings.TrimSpace(t.Name); n != "" {
			names = append(names, n)
		}
	}

	var b strings.Builder
	b.WriteString("\n\n---\n")
	b.WriteString("You are operating as the model behind a tool-using API. ")
	b.WriteString("The available tools are: ")
	b.WriteString(strings.Join(names, ", "))
	b.WriteString(".\n\n")
	b.WriteString("When you want to call a tool, output ONLY a single fenced code block, ")
	b.WriteString("with no prose before or after it:\n\n")
	b.WriteString("```")
	b.WriteString(toolCallFence)
	b.WriteString("\n")
	b.WriteString(`{"tool": "<ToolName>", "input": { ...arguments matching that tool's input schema... }}`)
	b.WriteString("\n```\n\n")
	b.WriteString("Rules:\n")
	b.WriteString("- Use the EXACT tool name and the EXACT argument field names from the tool's input schema.\n")
	b.WriteString("- To call several tools at once, emit several such blocks back to back.\n")
	b.WriteString("- If you do NOT need a tool, just answer normally in plain text with no fenced block.\n")
	b.WriteString("- Never wrap the tool call in any other code fence; use exactly ```")
	b.WriteString(toolCallFence)
	b.WriteString("```.\n")
	return b.String()
}

var toolCallFenceRe = regexp.MustCompile("(?s)```" + toolCallFence + "\\s*\\n(.*?)```")

// parseToolCalls extracts tool calls from the browser AI's reply.
//
// Two modes, tried in order:
//  1. Strict: one or more ```piercode-call fenced JSON blocks.
//  2. Lenient: no fence, but the reply IS (or contains) a bare
//     {"tool":...,"input":...} object — recovered via balanced-brace scan.
//
// leadingText is any prose the page wrote before the first tool call (Anthropic
// allows a text block to precede tool_use). found is false when no tool call
// could be parsed, signalling the caller to fall back to a plain text response.
func parseToolCalls(text string) (calls []parsedToolCall, leadingText string, found bool) {
	matches := toolCallFenceRe.FindAllStringSubmatchIndex(text, -1)
	if len(matches) > 0 {
		firstStart := matches[0][0]
		leadingText = strings.TrimSpace(text[:firstStart])
		for _, m := range matches {
			body := text[m[2]:m[3]]
			if call, ok := decodeToolCall(body); ok {
				calls = append(calls, call)
			}
		}
		if len(calls) > 0 {
			return calls, leadingText, true
		}
	}

	// Lenient fallback: scan for a bare {"tool":...} object.
	if call, lead, ok := recoverBareToolCall(text); ok {
		return []parsedToolCall{call}, lead, true
	}

	return nil, "", false
}

func decodeToolCall(body string) (parsedToolCall, bool) {
	body = strings.TrimSpace(body)
	var call parsedToolCall
	if err := json.Unmarshal([]byte(body), &call); err != nil {
		return parsedToolCall{}, false
	}
	if strings.TrimSpace(call.Name) == "" {
		return parsedToolCall{}, false
	}
	if call.Input == nil {
		call.Input = map[string]interface{}{}
	}
	return call, true
}

// recoverBareToolCall finds the first balanced {...} substring that decodes to
// a tool call with a non-empty "tool" field.
func recoverBareToolCall(text string) (parsedToolCall, string, bool) {
	idx := strings.Index(text, "{")
	for idx >= 0 {
		end := matchingBrace(text, idx)
		if end > idx {
			if call, ok := decodeToolCall(text[idx : end+1]); ok {
				return call, strings.TrimSpace(text[:idx]), true
			}
		}
		next := strings.Index(text[idx+1:], "{")
		if next < 0 {
			break
		}
		idx = idx + 1 + next
	}
	return parsedToolCall{}, "", false
}

// matchingBrace returns the index of the brace that closes the one at start,
// respecting JSON string literals and escapes. Returns -1 if unbalanced.
func matchingBrace(s string, start int) int {
	depth := 0
	inStr := false
	escaped := false
	for i := start; i < len(s); i++ {
		c := s[i]
		if inStr {
			if escaped {
				escaped = false
			} else if c == '\\' {
				escaped = true
			} else if c == '"' {
				inStr = false
			}
			continue
		}
		switch c {
		case '"':
			inStr = true
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return i
			}
		}
	}
	return -1
}

// toolUseID derives a stable-ish tool_use id from the message id and index.
func toolUseID(msgID string, index int) string {
	return fmt.Sprintf("toolu_%s_%d", strings.TrimPrefix(msgID, "msg_"), index)
}
