package claudemcp

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func TestHandleToolsListExposesAskWebAI(t *testing.T) {
	server := NewServer(Config{})
	respBytes, ok := server.HandleMessage(context.Background(), []byte(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`))
	if !ok {
		t.Fatalf("expected tools/list response")
	}

	var resp map[string]interface{}
	if err := json.Unmarshal(respBytes, &resp); err != nil {
		t.Fatalf("response was not JSON: %v", err)
	}
	result := resp["result"].(map[string]interface{})
	tools := result["tools"].([]interface{})
	if len(tools) != 1 {
		t.Fatalf("expected exactly one MCP tool, got %d", len(tools))
	}
	tool := tools[0].(map[string]interface{})
	if tool["name"] != "ask_web_ai" {
		t.Fatalf("expected ask_web_ai tool, got %v", tool["name"])
	}
	schema := tool["inputSchema"].(map[string]interface{})
	required := schema["required"].([]interface{})
	if len(required) != 1 || required[0] != "prompt" {
		t.Fatalf("expected prompt to be the only required field, got %#v", required)
	}
}

func TestHandleToolsCallForwardsToPierCodeExec(t *testing.T) {
	var sawAuth bool
	var sawBody bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/exec" {
			t.Fatalf("expected /exec path, got %s", r.URL.Path)
		}
		sawAuth = r.Header.Get("Authorization") == "Bearer token-123"
		var body map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("invalid request JSON: %v", err)
		}
		sawBody = body["name"] == "ask_web_ai" &&
			strings.HasPrefix(body["call_id"].(string), "mcp_") &&
			body["args"].(map[string]interface{})["prompt"] == "ask Claude web"
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"name":"ask_web_ai","call_id":"mcp_1","status":"success","output":"Provider: Claude\n\nweb answer"}`))
	}))
	defer upstream.Close()

	server := NewServer(Config{APIURL: upstream.URL, Token: "token-123"})
	respBytes, ok := server.HandleMessage(context.Background(), []byte(`{"jsonrpc":"2.0","id":"call-1","method":"tools/call","params":{"name":"ask_web_ai","arguments":{"prompt":"ask Claude web"}}}`))
	if !ok {
		t.Fatalf("expected tools/call response")
	}
	if !sawAuth {
		t.Fatalf("expected bearer auth header to be forwarded")
	}
	if !sawBody {
		t.Fatalf("expected MCP arguments to be converted into PierCode /exec request")
	}

	var resp map[string]interface{}
	if err := json.Unmarshal(respBytes, &resp); err != nil {
		t.Fatalf("response was not JSON: %v", err)
	}
	result := resp["result"].(map[string]interface{})
	content := result["content"].([]interface{})
	first := content[0].(map[string]interface{})
	if first["type"] != "text" || first["text"] != "Provider: Claude\n\nweb answer" {
		t.Fatalf("unexpected tool content: %#v", first)
	}
	if result["isError"] == true {
		t.Fatalf("successful /exec response should not be marked as MCP error")
	}
}

func TestRunServicesPingWhileToolCallBlocks(t *testing.T) {
	var once sync.Once
	release := make(chan struct{})
	defer once.Do(func() { close(release) })

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-release // hold the tools/call open until the test releases it
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"success","output":"slow done"}`))
	}))
	defer upstream.Close()

	srv := NewServer(Config{APIURL: upstream.URL})
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	go func() { _ = srv.Run(context.Background(), inR, outW) }()
	defer inW.Close()

	// A slow tools/call followed immediately by a cheap ping. With sequential
	// handling the ping would be stuck behind the blocked /exec; concurrent
	// dispatch must answer the ping (id 2) first.
	_, _ = inW.Write([]byte(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ask_web_ai","arguments":{"prompt":"x"}}}` + "\n"))
	_, _ = inW.Write([]byte(`{"jsonrpc":"2.0","id":2,"method":"ping"}` + "\n"))

	scanner := bufio.NewScanner(outR)
	scanner.Buffer(make([]byte, 0, 64*1024), 1<<20)

	readID := func() string {
		if !scanner.Scan() {
			t.Fatalf("expected a JSON-RPC response, scan err=%v", scanner.Err())
		}
		var resp map[string]interface{}
		if err := json.Unmarshal(scanner.Bytes(), &resp); err != nil {
			t.Fatalf("response was not JSON: %v (%q)", err, scanner.Text())
		}
		return fmt.Sprint(resp["id"])
	}

	if id := readID(); id != "2" {
		t.Fatalf("expected ping (id 2) to be answered while tools/call blocks, got id=%s", id)
	}
	once.Do(func() { close(release) }) // let the blocked tools/call finish
	if id := readID(); id != "1" {
		t.Fatalf("expected tools/call (id 1) response after release, got id=%s", id)
	}
}

func TestHandleNotificationDoesNotRespond(t *testing.T) {
	server := NewServer(Config{})
	if _, ok := server.HandleMessage(context.Background(), []byte(`{"jsonrpc":"2.0","method":"notifications/initialized"}`)); ok {
		t.Fatalf("notifications must not produce JSON-RPC responses")
	}
}
