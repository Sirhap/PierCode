package prompts

import _ "embed"

//go:embed init_prompt.txt
var DefaultPrompt []byte

//go:embed qwen_append.txt
var QwenPromptAppend []byte

//go:embed worker_append.txt
var WorkerPromptAppend []byte

//go:embed browser_agent_append.txt
var BrowserAgentPromptAppend []byte

// BrowserAgentBasePrompt is a slim, browser-operator-focused base prompt used as
// the browser-agent profile's Prompt INSTEAD of inheriting DefaultPrompt. The
// default init prompt is ~90% local-software-engineering guidance (file/git/edit
// tooling) that directly contradicts the browser-agent role ("you have NO
// filesystem tools") and confuses the model. This base keeps only the
// piercode-tool transport rule, runtime context, trust order, and the
// {{TOOLS}}/{{SKILLS}} placeholders (audit Bug #5, full fix).
//
//go:embed browser_agent_base.txt
var BrowserAgentBasePrompt []byte
