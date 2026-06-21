package prompts

import _ "embed"

//go:embed init_prompt.txt
var DefaultPrompt []byte

//go:embed qwen_append.txt
var QwenPromptAppend []byte

// ChatGPTPromptAppend warns the ChatGPT-hosted model that its native
// python/python_user_visible analysis tool is a no-op in this environment
// (placeholder output, no real fs/shell/network) and that all local work must
// go through visible piercode-tool blocks. Appended via the "chatgpt" profile.
//
//go:embed chatgpt_append.txt
var ChatGPTPromptAppend []byte

// QwenBasePrompt is a slim, Qwen-specific base prompt used as the qwen profile's
// Prompt INSTEAD of inheriting DefaultPrompt. Qwen's function-calling RLHF makes it
// reach for its own native tools (code_interpreter/web_search) when it sees the
// generic init prompt's tooling context, so this base leads with the strongest
// possible "piercode-tool is the ONLY transport, never a Qwen native tool" rule and
// keeps the {{TOOLS}}/{{SKILLS}} placeholders (compact route index, not full schema).
//
//go:embed qwen_base.txt
var QwenBasePrompt []byte

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
