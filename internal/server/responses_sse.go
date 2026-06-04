package server

// OpenAI Responses API streaming (SSE) for the impersonation handler.
//
// Codex consumes named SSE events. The captured (and codex-accepted) sequences:
//
//   message turn:
//     response.created
//     response.output_item.added        (message, empty content)
//     response.content_part.added       (output_text)
//     response.output_text.delta        (delta) ...
//     response.output_text.done
//     response.content_part.done
//     response.output_item.done         (message, full content)
//     response.completed
//
//   function_call turn (per call):
//     response.output_item.added        (function_call, empty arguments)
//     response.function_call_arguments.delta
//     response.function_call_arguments.done
//     response.output_item.done         (function_call, full arguments)
//
// Keepalive: response.created is sent before the browser AI answers; while
// waiting we emit `response.output_text.delta` with an empty string? No — codex
// treats unexpected deltas as content. Instead we send the lightweight
// `response.in_progress` event repeatedly, which is a no-op status ping.

// responsesEvent emits one named SSE event (Responses uses named events, like
// Anthropic, so the existing sseWriter.event encoding fits).
func (w *sseWriter) responsesEvent(name string, data map[string]interface{}) {
	data["type"] = name
	w.event(name, data)
}

func responseEnvelope(id, model, status string, output []map[string]interface{}) map[string]interface{} {
	env := map[string]interface{}{
		"id":     id,
		"object": "response",
		"model":  model,
		"status": status,
	}
	if output != nil {
		env["output"] = output
	} else {
		env["output"] = []interface{}{}
	}
	return env
}

// responsesCreated opens the stream. Sent before the page answers.
func (w *sseWriter) responsesCreated(id, model string) {
	w.responsesEvent("response.created", map[string]interface{}{
		"response": responseEnvelope(id, model, "in_progress", nil),
	})
}

// responsesPing keeps the connection warm while the browser AI is still
// thinking. response.in_progress carries no content, so codex ignores it.
func (w *sseWriter) responsesPing(id string) {
	w.responsesEvent("response.in_progress", map[string]interface{}{
		"response": map[string]interface{}{
			"id":     id,
			"object": "response",
			"status": "in_progress",
		},
	})
}

// responsesMessage streams a plain assistant message turn and completes.
func (w *sseWriter) responsesMessage(id, model, text string, inputTokens int) {
	itemID := responsesItemID(id, 0)
	w.responsesEvent("response.output_item.added", map[string]interface{}{
		"output_index": 0,
		"item": map[string]interface{}{
			"type": "message", "id": itemID, "role": "assistant", "status": "in_progress",
			"content": []interface{}{},
		},
	})
	w.responsesEvent("response.content_part.added", map[string]interface{}{
		"item_id": itemID, "output_index": 0, "content_index": 0,
		"part": map[string]interface{}{"type": "output_text", "text": ""},
	})
	w.responsesEvent("response.output_text.delta", map[string]interface{}{
		"item_id": itemID, "output_index": 0, "content_index": 0, "delta": text,
	})
	w.responsesEvent("response.output_text.done", map[string]interface{}{
		"item_id": itemID, "output_index": 0, "content_index": 0, "text": text,
	})
	w.responsesEvent("response.content_part.done", map[string]interface{}{
		"item_id": itemID, "output_index": 0, "content_index": 0,
		"part": map[string]interface{}{"type": "output_text", "text": text},
	})
	w.responsesEvent("response.output_item.done", map[string]interface{}{
		"output_index": 0,
		"item": map[string]interface{}{
			"type": "message", "id": itemID, "role": "assistant", "status": "completed",
			"content": []map[string]interface{}{{"type": "output_text", "text": text}},
		},
	})
	w.responsesCompleted(id, model, "completed",
		responsesMessageObject(id, model, text, inputTokens)["output"].([]map[string]interface{}),
		inputTokens, estimateTokens(text))
}

// responsesFunctionCalls streams an optional leading message plus one
// function_call item per parsed call, then completes.
func (w *sseWriter) responsesFunctionCalls(id, model, leadingText string, calls []parsedToolCall, inputTokens int) {
	index := 0
	outTokens := 0
	if leadingText != "" {
		w.responsesMessagePart(id, leadingText, index)
		outTokens += estimateTokens(leadingText)
		index++
	}
	for i, call := range calls {
		args := responsesArgsString(call)
		itemID := responsesItemID(id, index)
		callID := responsesCallID(id, i)
		w.responsesEvent("response.output_item.added", map[string]interface{}{
			"output_index": index,
			"item": map[string]interface{}{
				"type": "function_call", "id": itemID, "call_id": callID,
				"name": call.Name, "arguments": "", "status": "in_progress",
			},
		})
		w.responsesEvent("response.function_call_arguments.delta", map[string]interface{}{
			"item_id": itemID, "output_index": index, "delta": args,
		})
		w.responsesEvent("response.function_call_arguments.done", map[string]interface{}{
			"item_id": itemID, "output_index": index, "arguments": args,
		})
		w.responsesEvent("response.output_item.done", map[string]interface{}{
			"output_index": index,
			"item": map[string]interface{}{
				"type": "function_call", "id": itemID, "call_id": callID,
				"name": call.Name, "arguments": args, "status": "completed",
			},
		})
		outTokens += estimateTokens(args)
		index++
	}
	if outTokens < 1 {
		outTokens = 1
	}
	output := responsesFunctionCallObject(id, model, leadingText, calls, inputTokens)["output"].([]map[string]interface{})
	w.responsesCompleted(id, model, "completed", output, inputTokens, outTokens)
}

// responsesMessagePart streams a leading text message item at the given index
// (used before function calls when the page emitted prose first).
func (w *sseWriter) responsesMessagePart(id, text string, index int) {
	itemID := responsesItemID(id, index)
	w.responsesEvent("response.output_item.added", map[string]interface{}{
		"output_index": index,
		"item": map[string]interface{}{
			"type": "message", "id": itemID, "role": "assistant", "status": "in_progress",
			"content": []interface{}{},
		},
	})
	w.responsesEvent("response.output_text.delta", map[string]interface{}{
		"item_id": itemID, "output_index": index, "content_index": 0, "delta": text,
	})
	w.responsesEvent("response.output_text.done", map[string]interface{}{
		"item_id": itemID, "output_index": index, "content_index": 0, "text": text,
	})
	w.responsesEvent("response.output_item.done", map[string]interface{}{
		"output_index": index,
		"item": map[string]interface{}{
			"type": "message", "id": itemID, "role": "assistant", "status": "completed",
			"content": []map[string]interface{}{{"type": "output_text", "text": text}},
		},
	})
}

// responsesCompleted emits the terminal response.completed with the full output
// array and usage.
func (w *sseWriter) responsesCompleted(id, model, status string, output []map[string]interface{}, inputTokens, outputTokens int) {
	env := responseEnvelope(id, model, status, output)
	env["usage"] = responsesUsage(inputTokens, outputTokens)
	w.responsesEvent("response.completed", map[string]interface{}{"response": env})
}
