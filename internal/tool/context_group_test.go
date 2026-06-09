package tool

import "testing"

func TestClientIOZeroValueIsNilSafe(t *testing.T) {
	var c ClientIO
	if c.Streamer != nil || c.Broadcast != nil || c.BroadcastToClient != nil {
		t.Fatal("zero ClientIO must have nil callbacks")
	}
	if c.SourceClientID != "" || c.ConversationURL != "" {
		t.Fatal("zero ClientIO must have empty identity strings")
	}
}

func TestTaskAccessZeroValueHasNilRunner(t *testing.T) {
	var ta TaskAccess
	if ta.Runner != nil {
		t.Fatal("zero TaskAccess must have nil Runner")
	}
}

func TestContextEmbedsGroupsByValue(t *testing.T) {
	ctx := &Context{}
	_ = ctx.Client.Streamer
	_ = ctx.Tasks.Runner
	if ctx.Client.SourceClientID != "" {
		t.Fatal("bare Context must have empty Client.SourceClientID")
	}
}
