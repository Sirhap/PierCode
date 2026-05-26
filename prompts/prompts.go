package prompts

import _ "embed"

//go:embed init_prompt.txt
var DefaultPrompt []byte

//go:embed qwen_append.txt
var QwenPromptAppend []byte
