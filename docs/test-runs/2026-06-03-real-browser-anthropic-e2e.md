# Real Browser Anthropic E2E - 2026-06-03

## Summary

Status: failed at real Claude Code CLI flow.

Provider: ChatGPT in the user's real Chrome profile with PierCode extension `lolcioebooncpbcgfdkcpolcihcdhcfl`.

The browser bridge did connect and a direct `ask_web_ai` smoke test succeeded, but Claude Code CLI requests through `/v1/messages` timed out at 60 seconds for both A and B. No `[webai-raw]` sample was produced for the CLI runs, so the real page did not return text to the Anthropic impersonation handler before the CLI timeout.

## Connection Evidence

Final connected stats before CLI failure:

```json
{
  "browser_client_details": [
    {
      "ID": "ws_1780496232882072000",
      "Client": "background",
      "Role": "browser-relay",
      "Provider": "Extension",
      "Host": "",
      "Connected": "2026-06-03T22:17:12.882075+08:00"
    },
    {
      "ID": "content-mpy5oiqm-w3bc1ps0",
      "Client": "content",
      "Role": "ai-page",
      "Provider": "ChatGPT",
      "Host": "chatgpt.com",
      "Connected": "2026-06-03T22:24:47.022293+08:00"
    }
  ],
  "browser_clients": 2,
  "browser_providers": {
    "ChatGPT": 1,
    "Extension": 1
  },
  "browser_relays": 1,
  "tasks_running": 0,
  "tasks_total": 0
}
```

Direct bridge smoke:

```json
{
  "name": "ask_web_ai",
  "call_id": "direct_smoke_001",
  "status": "success",
  "output": "PONG"
}
```

## Test A

Command:

```bash
claude -p "Reply with exactly the word PONG and nothing else." --output-format json
```

Result: failed by 60 second timeout. Claude Code produced no JSON output.

Evidence:

```text
rc=timeout
stdout: 0 bytes
stderr: 0 bytes
```

Server observed repeated `ask_web_ai` executions during the run, but no `[webai-raw]` line was emitted.

## Test B

Command:

```bash
claude -p "Use the Read tool to read the file go.mod, then tell me the exact Go module path declared on the first line." --output-format json --allowedTools Read
```

Result: failed by 60 second timeout. Claude Code produced no JSON output.

Evidence:

```text
rc=timeout
stdout: 0 bytes
stderr: 0 bytes
num_turns: unavailable
result: unavailable
Read execution: not observed
```

ChatGPT page inspection after the run:

```json
{
  "containsGoMod": false,
  "containsPiercodeCall": false,
  "containsRead": false
}
```

## Raw Web AI Output

No CLI `[webai-raw]` sample was captured. The direct smoke output was `PONG`, but that was not a Claude Code CLI `/v1/messages` request.

The ChatGPT page did not visibly receive the Test B prompt and did not show any `piercode-call` block. The server log only showed repeated `ask_web_ai` starts, with no returned raw text.

## Failure Classification

Primary failure mode: `④ 超时/无响应`.

Secondary observation: no evidence of `① 不输出工具块只闲聊`, `② 输出了但 fence 标签/字段名不对`, or `③ 字段值错`, because no real CLI web AI response returned at all.

## Prompt/Protocol Notes

The direct `ask_web_ai` prompt works, so the browser injection/response path is basically healthy. The Claude Code CLI path sends a much larger flattened Anthropic request and triggered repeated `ask_web_ai` calls without page output before 60 seconds.

Recommended follow-up before changing parser logic:

- Add request-size and prompt-preview debug logging around `flattenAnthropicRequest` and `buildToolProtocolPreamble`.
- Consider shortening the browser-facing prompt for no-tool turns so a simple PONG test does not forward the full Claude Code runtime context.
- Add a provider-facing trace marker near the end of the prompt to verify whether the page receives the current request or stalls before visible submission.
- If the page receives the prompt but ignores the tool contract, strengthen `buildToolProtocolPreamble` with an initial "You must choose exactly one of: plain answer or piercode-call block" decision line and put the fence example after the user's last instruction.
