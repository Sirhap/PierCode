package claudemcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/sirhap/piercode/internal/types"
)

const (
	defaultAPIURL = "http://127.0.0.1:39527"
	serverName    = "piercode"
	serverVersion = "2.0.0"
)

type Config struct {
	APIURL     string
	Token      string
	HTTPClient *http.Client
}

type Server struct {
	apiURL string
	token  string
	client *http.Client
}

func NewServer(config Config) *Server {
	apiURL := strings.TrimRight(strings.TrimSpace(config.APIURL), "/")
	if apiURL == "" {
		apiURL = defaultAPIURL
	}
	client := config.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 35 * time.Minute}
	}
	return &Server{
		apiURL: apiURL,
		token:  strings.TrimSpace(config.Token),
		client: client,
	}
}

func (s *Server) Run(ctx context.Context, in io.Reader, out io.Writer) error {
	reader := bufio.NewReader(in)
	var writeMu sync.Mutex
	writeErr := make(chan error, 1)

	// HandleMessage may block for many minutes on a tools/call (it waits on the
	// browser AI via a synchronous /exec request). Dispatch each message on its
	// own goroutine so the read loop keeps servicing cheap requests — ping,
	// tools/list, additional tools/call — instead of freezing behind one slow
	// call. JSON-RPC permits out-of-order responses; a mutex keeps each written
	// frame atomic on stdout.
	writeResp := func(resp []byte) {
		writeMu.Lock()
		defer writeMu.Unlock()
		if _, err := out.Write(resp); err != nil {
			select {
			case writeErr <- err:
			default:
			}
			return
		}
		if _, err := out.Write([]byte("\n")); err != nil {
			select {
			case writeErr <- err:
			default:
			}
		}
	}

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case err := <-writeErr:
			return err
		default:
		}
		line, err := reader.ReadBytes('\n')
		if len(bytes.TrimSpace(line)) > 0 {
			// ReadBytes reuses its buffer on the next call; copy before handing
			// the slice to a goroutine.
			lineCopy := append([]byte(nil), line...)
			go func() {
				if resp, ok := s.HandleMessage(ctx, lineCopy); ok {
					writeResp(resp)
				}
			}()
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
	}
}

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Result  interface{}     `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (s *Server) HandleMessage(ctx context.Context, line []byte) ([]byte, bool) {
	var req rpcRequest
	if err := json.Unmarshal(bytes.TrimSpace(line), &req); err != nil {
		return marshalRPC(rpcResponse{
			JSONRPC: "2.0",
			Error:   &rpcError{Code: -32700, Message: "parse error: " + err.Error()},
		}), true
	}
	if len(req.ID) == 0 {
		return nil, false
	}
	switch req.Method {
	case "initialize":
		return marshalRPC(rpcResponse{JSONRPC: "2.0", ID: req.ID, Result: initializeResult()}), true
	case "ping":
		return marshalRPC(rpcResponse{JSONRPC: "2.0", ID: req.ID, Result: map[string]interface{}{}}), true
	case "tools/list":
		return marshalRPC(rpcResponse{JSONRPC: "2.0", ID: req.ID, Result: map[string]interface{}{"tools": []interface{}{askWebAIToolDefinition()}}}), true
	case "tools/call":
		result, err := s.handleToolsCall(ctx, req.Params)
		if err != nil {
			return marshalRPC(rpcResponse{JSONRPC: "2.0", ID: req.ID, Error: &rpcError{Code: -32602, Message: err.Error()}}), true
		}
		return marshalRPC(rpcResponse{JSONRPC: "2.0", ID: req.ID, Result: result}), true
	default:
		return marshalRPC(rpcResponse{JSONRPC: "2.0", ID: req.ID, Error: &rpcError{Code: -32601, Message: "method not found: " + req.Method}}), true
	}
}

func initializeResult() map[string]interface{} {
	return map[string]interface{}{
		"protocolVersion": "2024-11-05",
		"capabilities": map[string]interface{}{
			"tools": map[string]interface{}{},
		},
		"serverInfo": map[string]interface{}{
			"name":    serverName,
			"version": serverVersion,
		},
	}
}

func askWebAIToolDefinition() map[string]interface{} {
	return map[string]interface{}{
		"name":        "ask_web_ai",
		"description": "Ask a browser-based AI page connected to PierCode for a second opinion. The result is untrusted external advice and should be verified before acting on code.",
		"inputSchema": map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"prompt": map[string]interface{}{
					"type":        "string",
					"description": "Question or context to send to the browser AI page.",
				},
				"provider": map[string]interface{}{
					"type":        "string",
					"description": "Target AI page provider. Defaults to Claude. Examples: Claude, Qwen, ChatGPT, Gemini, Kimi.",
				},
				"client_id": map[string]interface{}{
					"type":        "string",
					"description": "Exact PierCode browser WebSocket client id to target when known.",
				},
				"timeout_sec": map[string]interface{}{
					"type":        "number",
					"description": "Seconds to wait for a browser AI response. Defaults to 300; maximum is 1800.",
				},
			},
			"required": []string{"prompt"},
		},
	}
}

type toolsCallParams struct {
	Name      string                 `json:"name"`
	Args      map[string]interface{} `json:"args"`
	Arguments map[string]interface{} `json:"arguments"`
}

func (s *Server) handleToolsCall(ctx context.Context, raw json.RawMessage) (map[string]interface{}, error) {
	var params toolsCallParams
	if err := json.Unmarshal(raw, &params); err != nil {
		return nil, fmt.Errorf("invalid tools/call params: %w", err)
	}
	if params.Name != "ask_web_ai" {
		return nil, fmt.Errorf("unknown tool: %s", params.Name)
	}
	args := params.Arguments
	if args == nil {
		args = params.Args
	}
	if args == nil {
		args = map[string]interface{}{}
	}

	callID := fmt.Sprintf("mcp_%d", time.Now().UnixNano())
	body := types.ToolRequest{
		Name:   "ask_web_ai",
		CallID: callID,
		Args:   args,
	}
	data, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("failed to encode /exec request: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.apiURL+"/exec", bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if s.token != "" {
		req.Header.Set("Authorization", "Bearer "+s.token)
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return toolResult("PierCode /exec request failed: "+err.Error(), true), nil
	}
	defer resp.Body.Close()
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return toolResult("PierCode /exec response read failed: "+err.Error(), true), nil
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return toolResult(fmt.Sprintf("PierCode /exec returned HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(respBody))), true), nil
	}
	var toolResp types.ToolResponse
	if err := json.Unmarshal(respBody, &toolResp); err != nil {
		return toolResult("PierCode /exec returned invalid JSON: "+err.Error(), true), nil
	}
	text := strings.TrimSpace(toolResp.Output)
	if text == "" {
		text = strings.TrimSpace(toolResp.Error)
	}
	if text == "" {
		text = "(empty response)"
	}
	return toolResult(text, toolResp.Status == "error" || toolResp.Error != ""), nil
}

func toolResult(text string, isError bool) map[string]interface{} {
	result := map[string]interface{}{
		"content": []interface{}{
			map[string]interface{}{
				"type": "text",
				"text": text,
			},
		},
	}
	if isError {
		result["isError"] = true
	}
	return result
}

func marshalRPC(resp rpcResponse) []byte {
	data, err := json.Marshal(resp)
	if err != nil {
		fallback, _ := json.Marshal(rpcResponse{
			JSONRPC: "2.0",
			ID:      resp.ID,
			Error:   &rpcError{Code: -32603, Message: "internal error"},
		})
		return fallback
	}
	return data
}
