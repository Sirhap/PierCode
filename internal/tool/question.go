package tool

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

type QuestionTool struct{}

func NewQuestionTool() *QuestionTool { return &QuestionTool{} }

func (t *QuestionTool) Name() string { return "question" }
func (t *QuestionTool) Description() string {
	return "Ask the user a blocking question and wait for input. Use this instead of plain prose when user input is required to continue safely: destructive/irreversible actions, credentials or external authority, materially different implementation choices, missing business requirements, paths, ports, account names, environment values, repeated tool failures, or ambiguous risk tradeoffs. Do not ask for codebase facts you can inspect with tools. Provide options when choices are clear."
}
func (t *QuestionTool) Parameters() interface{} {
	return map[string]string{
		"question":    "string (required) - the question to ask",
		"options":     "array (optional) - list of choices to present",
		"timeout_sec": "number (optional, default 300) - how long to wait for an answer",
	}
}

func (t *QuestionTool) Validate(args map[string]interface{}) error {
	if q, ok := args["question"].(string); !ok || q == "" {
		return fmt.Errorf("question is required")
	}
	return nil
}

// defaultQuestionTimeout is how long Execute blocks waiting for the user to
// answer before giving up. 5 minutes is short enough to free the HTTP slot
// but long enough that the user can step away briefly.
const defaultQuestionTimeout = 5 * time.Minute

func (t *QuestionTool) Execute(ctx *Context) *Result {
	result := &Result{StartTime: time.Now()}
	defer func() { result.EndTime = time.Now() }()

	question, _ := ctx.Args["question"].(string)
	options, _ := ctx.Args["options"].([]interface{})
	callID, _ := ctx.Args["call_id"].(string)
	if strings.TrimSpace(callID) == "" {
		result.Status = "error"
		result.Error = "question tool requires call_id (executor injects it from the request)"
		return result
	}

	timeout := defaultQuestionTimeout
	switch v := ctx.Args["timeout_sec"].(type) {
	case float64:
		if v > 0 {
			timeout = time.Duration(v * float64(time.Second))
		}
	case int:
		if v > 0 {
			timeout = time.Duration(v) * time.Second
		}
	}

	// Build a human-readable preview that goes back in result.Output so the
	// AI sees both the question and the answer in the transcript.
	var preview strings.Builder
	preview.WriteString("Q: ")
	preview.WriteString(question)
	if len(options) > 0 {
		preview.WriteString("\n选项：")
		for i, opt := range options {
			fmt.Fprintf(&preview, "\n  %d. %v", i+1, opt)
		}
	}

	answerCh, cleanup := PendingQuestions.Register(callID)
	defer cleanup()

	if ctx.Client.Broadcast != nil || (ctx.Client.BroadcastToClient != nil && ctx.Client.SourceClientID != "") {
		payload := map[string]interface{}{
			"type":      "question_ask",
			"call_id":   callID,
			"client_id": ctx.Client.SourceClientID,
			"question":  question,
			"options":   options,
		}
		if data, err := json.Marshal(payload); err == nil {
			if ctx.Client.SourceClientID != "" && ctx.Client.BroadcastToClient != nil {
				ctx.Client.BroadcastToClient(ctx.Client.SourceClientID, data)
			} else {
				ctx.Client.Broadcast(data)
			}
		}
	}

	parent := ctx.Context
	if parent == nil {
		parent = context.Background()
	}

	select {
	case answer := <-answerCh:
		if reason, canceled := parsePendingQuestionCancel(answer); canceled {
			if reason == "" {
				reason = "canceled"
			}
			result.Status = "error"
			result.Error = "question canceled: " + reason
			result.Output = preview.String() + "\n\n[用户取消回答]"
			return result
		}
		result.Status = "success"
		result.Output = preview.String() + "\n\nA: " + answer
		return result
	case <-time.After(timeout):
		// Tell clients to dismiss the prompt UI.
		t.broadcastCancel(ctx, callID, "timeout")
		result.Status = "error"
		result.Error = fmt.Sprintf("no answer received within %s", timeout)
		result.Output = preview.String() + "\n\n[超时未收到回答]"
		return result
	case <-parent.Done():
		t.broadcastCancel(ctx, callID, "canceled")
		result.Status = "error"
		result.Error = parent.Err().Error()
		result.Output = preview.String() + "\n\n[请求被取消]"
		return result
	}
}

func (t *QuestionTool) broadcastCancel(ctx *Context, callID, reason string) {
	if ctx.Client.Broadcast == nil && (ctx.Client.BroadcastToClient == nil || ctx.Client.SourceClientID == "") {
		return
	}
	payload := map[string]interface{}{
		"type":      "question_cancel",
		"call_id":   callID,
		"client_id": ctx.Client.SourceClientID,
		"reason":    reason,
	}
	if data, err := json.Marshal(payload); err == nil {
		if ctx.Client.SourceClientID != "" && ctx.Client.BroadcastToClient != nil {
			ctx.Client.BroadcastToClient(ctx.Client.SourceClientID, data)
		} else {
			ctx.Client.Broadcast(data)
		}
	}
}
