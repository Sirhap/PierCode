package tool

// ClientIO groups everything tied to the WebSocket client that initiated the
// tool call: live stdout/stderr streaming, broadcast channels, and the client's
// own identity. Grouping these keeps the surrounding Context honest about which
// tools touch the client at all — filesystem tools take a zero ClientIO and
// never reach for it.
//
// The zero value is fully usable: nil callbacks and empty identity strings mean
// "this capability is not available in this invocation". Consumers nil-check
// each field before use.
type ClientIO struct {
	// Streamer, if set, receives incremental stdout/stderr chunks from a
	// long-running tool (currently only exec_cmd). stream is "stdout" or
	// "stderr". Nil means the caller does not want live output.
	Streamer func(stream, text string)

	// Broadcast, if set, sends an arbitrary JSON payload to every connected
	// WebSocket client. The question tool uses it to push question_ask. Nil
	// means broadcast is not available.
	Broadcast func(payload []byte)

	// BroadcastToClient, if set, sends a JSON payload to one WebSocket client.
	// Browser-page side effects (screenshot attachment upload) use it so
	// multi-tab sessions do not all receive the same event.
	BroadcastToClient func(clientID string, payload []byte) bool

	// SourceClientID is the WebSocket client id of the AI page that initiated
	// this call, when it came through the browser extension. Empty otherwise.
	SourceClientID string

	// ConversationURL is the canonical conversation URL of the initiating page.
	ConversationURL string
}
