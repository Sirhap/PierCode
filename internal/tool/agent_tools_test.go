package tool

import "testing"

func TestDefaultPlatformFor(t *testing.T) {
	cases := []struct {
		name            string
		conversationURL string
		want            string
	}{
		{"chatgpt coordinator spawns chatgpt", "https://chatgpt.com/c/abc123", "chatgpt"},
		{"openai legacy host", "https://chat.openai.com/c/x", "chatgpt"},
		{"qwen coordinator", "https://chat.qwen.ai/c/y", "qwen"},
		{"qwenlm host", "https://qwenlm.ai/chat", "qwen"},
		{"claude coordinator", "https://claude.ai/chat/uuid", "claude"},
		{"gemini coordinator", "https://gemini.google.com/app", "gemini"},
		{"aistudio coordinator", "https://aistudio.google.com/prompts/x", "aistudio"},
		{"kimi coordinator", "https://www.kimi.com/chat", "kimi"},
		{"z.ai coordinator", "https://chat.z.ai/c/z", "z.ai"},
		{"mimo coordinator", "https://aistudio.xiaomimimo.com/", "mimo"},
		{"unknown host falls back to qwen", "https://example.com/x", "qwen"},
		{"empty url falls back to qwen", "", "qwen"},
		{"garbage url falls back to qwen", "::not a url::", "qwen"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := defaultPlatformFor(c.conversationURL); got != c.want {
				t.Errorf("defaultPlatformFor(%q) = %q, want %q", c.conversationURL, got, c.want)
			}
		})
	}
}
