package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/sirhap/piercode/internal/tool"
)

func TestFlattenResponsesRequest(t *testing.T) {
	req := responsesRequest{
		Instructions: "be terse",
		Input: json.RawMessage(`[
			{"type":"message","role":"developer","content":[{"type":"input_text","text":"dev note"}]},
			{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]},
			{"type":"function_call","name":"Read","arguments":"{\"file_path\":\"go.mod\"}","call_id":"c1"},
			{"type":"function_call_output","call_id":"c1","output":"module x"}
		]`),
	}
	got, err := flattenResponsesRequest(req)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"System:\nbe terse",
		"dev note",
		"User:\nhello",
		"[called tool Read with {\"file_path\":\"go.mod\"}]",
		"Tool result:\nmodule x",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("flattened prompt missing %q\n---\n%s", want, got)
		}
	}
}

func TestFlattenResponsesRequestBareStringInput(t *testing.T) {
	req := responsesRequest{Input: json.RawMessage(`"just a string"`)}
	got, err := flattenResponsesRequest(req)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, "User:\njust a string") {
		t.Fatalf("bare string input not handled: %q", got)
	}
}

func TestResponsesToolsToSharedSkipsEmptyNames(t *testing.T) {
	tools := []responsesToolDef{
		{Type: "function", Name: "exec_command", Description: "run"},
		{Type: "function", Name: ""}, // codex sometimes emits a null-name tool
	}
	got := responsesToolsToShared(tools)
	if len(got) != 1 || got[0].Name != "exec_command" {
		t.Fatalf("expected only named tools, got %+v", got)
	}
}

func postResponses(t *testing.T, s *Server, body map[string]interface{}) *httptest.ResponseRecorder {
	t.Helper()
	raw, _ := json.Marshal(body)
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/responses", bytes.NewReader(raw))
	req.Header.Set("Authorization", "Bearer testtoken")
	req.Header.Set("Content-Type", "application/json")
	s.router.ServeHTTP(w, req)
	return w
}

// stubResponsesWebAI mirrors stubWebAI but local to this file.
func stubResponsesWebAI(s *Server, reply string) {
	s.executor.SetWebAIClientPicker(func(string) string { return "stub" })
	s.executor.SetClientBroadcaster(func(_ string, payload []byte) bool {
		var msg struct {
			QueryID string `json:"query_id"`
		}
		_ = json.Unmarshal(payload, &msg)
		go tool.PendingWebAIQueries.Deliver(msg.QueryID, tool.WebAIQueryResult{Text: reply})
		return true
	})
}

func TestHandleResponsesText(t *testing.T) {
	s := testServer(t)
	stubResponsesWebAI(s, "browser AI says hi")

	w := postResponses(t, s, map[string]interface{}{
		"model": "gpt-test",
		"input": []map[string]interface{}{
			{"type": "message", "role": "user", "content": []map[string]interface{}{{"type": "input_text", "text": "ping"}}},
		},
	})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", w.Code, w.Body.String())
	}
	var resp struct {
		Object string `json:"object"`
		Status string `json:"status"`
		Output []struct {
			Type    string `json:"type"`
			Role    string `json:"role"`
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		} `json:"output"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Object != "response" || resp.Status != "completed" {
		t.Fatalf("bad envelope: %+v", resp)
	}
	if len(resp.Output) != 1 || resp.Output[0].Type != "message" {
		t.Fatalf("expected one message item, got %+v", resp.Output)
	}
	if len(resp.Output[0].Content) != 1 || resp.Output[0].Content[0].Text != "browser AI says hi" {
		t.Fatalf("reply text wrong: %+v", resp.Output[0].Content)
	}
}

func TestHandleResponsesFunctionCall(t *testing.T) {
	s := testServer(t)
	reply := "I'll read it.\n```" + toolCallFence + "\n{\"tool\":\"Read\",\"input\":{\"file_path\":\"go.mod\"}}\n```"
	stubResponsesWebAI(s, reply)

	w := postResponses(t, s, map[string]interface{}{
		"model": "gpt-test",
		"tools": []map[string]interface{}{
			{"type": "function", "name": "Read", "description": "read a file"},
		},
		"input": []map[string]interface{}{
			{"type": "message", "role": "user", "content": []map[string]interface{}{{"type": "input_text", "text": "read go.mod"}}},
		},
	})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", w.Code, w.Body.String())
	}
	var resp struct {
		Output []struct {
			Type      string `json:"type"`
			Name      string `json:"name"`
			Arguments string `json:"arguments"`
			CallID    string `json:"call_id"`
		} `json:"output"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	var fc *struct {
		Type      string `json:"type"`
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
		CallID    string `json:"call_id"`
	}
	for i := range resp.Output {
		if resp.Output[i].Type == "function_call" {
			fc = &resp.Output[i]
		}
	}
	if fc == nil || fc.Name != "Read" || fc.CallID == "" {
		t.Fatalf("expected function_call for Read, got %+v", resp.Output)
	}
	var args map[string]interface{}
	if err := json.Unmarshal([]byte(fc.Arguments), &args); err != nil {
		t.Fatalf("arguments not JSON string: %q", fc.Arguments)
	}
	if args["file_path"] != "go.mod" {
		t.Fatalf("arguments missing file_path: %v", args)
	}
}

func TestHandleResponsesStreamingText(t *testing.T) {
	s := testServer(t)
	stubResponsesWebAI(s, "plain streamed answer")

	w := postResponses(t, s, map[string]interface{}{
		"model":  "gpt-test",
		"stream": true,
		"input": []map[string]interface{}{
			{"type": "message", "role": "user", "content": []map[string]interface{}{{"type": "input_text", "text": "hi"}}},
		},
	})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", w.Code, w.Body.String())
	}
	if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Fatalf("content-type = %q, want SSE", ct)
	}
	body := w.Body.String()
	for _, want := range []string{
		"event: response.created",
		"event: response.output_item.added",
		"event: response.output_text.delta",
		"plain streamed answer",
		"event: response.output_item.done",
		"event: response.completed",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("stream missing %q:\n%s", want, body)
		}
	}
}

func TestHandleResponsesStreamingFunctionCall(t *testing.T) {
	s := testServer(t)
	reply := "```" + toolCallFence + "\n{\"tool\":\"Read\",\"input\":{\"file_path\":\"go.mod\"}}\n```"
	stubResponsesWebAI(s, reply)

	w := postResponses(t, s, map[string]interface{}{
		"model":  "gpt-test",
		"stream": true,
		"tools":  []map[string]interface{}{{"type": "function", "name": "Read"}},
		"input": []map[string]interface{}{
			{"type": "message", "role": "user", "content": []map[string]interface{}{{"type": "input_text", "text": "read go.mod"}}},
		},
	})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", w.Code, w.Body.String())
	}
	body := w.Body.String()
	for _, want := range []string{
		"event: response.function_call_arguments.delta",
		`"name":"Read"`,
		"go.mod",
		"event: response.completed",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("stream missing %q:\n%s", want, body)
		}
	}
}

func TestHandleResponsesNoBrowserClient(t *testing.T) {
	s := testServer(t)
	w := postResponses(t, s, map[string]interface{}{
		"input": []map[string]interface{}{
			{"type": "message", "role": "user", "content": []map[string]interface{}{{"type": "input_text", "text": "hi"}}},
		},
	})
	if w.Code != http.StatusBadGateway {
		t.Fatalf("expected 502 when no browser AI, got %d: %s", w.Code, w.Body.String())
	}
}
