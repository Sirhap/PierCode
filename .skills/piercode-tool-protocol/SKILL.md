---
name: piercode-tool-protocol
description: Detailed PierCode tool-call protocol, result handling, retry rules, and transport troubleshooting.
---

# PierCode Tool Protocol

Use this skill when the task depends on precise PierCode tool formatting, tool result parsing, retries, or troubleshooting host-page tool confusion.

## Transport

PierCode tools execute only when the assistant prints visible Markdown fences using the `piercode-tool` language:

```piercode-tool
{"name":"read_file","call_id":"r8k2m","args":{"path":"README.md"}}
```

Do not use host-native function calls, XML tool tags, generic `tool` fences, plugin syntax, or hidden reasoning calls.

## Request Shape

- `name`: exact PierCode operation name from the rendered tool list.
- `call_id`: required, unique, random-looking, at least 5 characters.
- `args`: required JSON object; use `{}` when the tool has no parameters.

Do not translate tool names or invent aliases. Do not use sequential IDs like `call1`, `tool_001`, or `1`.

## Multiple Calls

Independent reads/searches may be emitted in the same assistant message as separate fences. Dependent work must wait for the prior result.

Good independent batch:

```piercode-tool
{"name":"list_dir","call_id":"n7k4q","args":{"path":"."}}
```

```piercode-tool
{"name":"grep","call_id":"h5m9v","args":{"pattern":"TODO","path":"."}}
```

## Result Handling

PierCode returns results with headings:

```text
### read_file #r8k2m
(result)
```

Match each result by `call_id`. If several results are merged into one assistant-visible message, parse each heading independently.

## Error Handling

When a tool fails:

1. Read the error text.
2. Check name, path, arguments, JSON shape, and workspace constraints.
3. Retry once with a materially corrected call when appropriate.
4. If the same call fails twice with the same error, stop repeating it and change approach or ask for the missing requirement.

## Common Tool Choices

- `list_dir`: directory overview.
- `glob`: path-pattern discovery.
- `grep`: text search.
- `read_file`: exact file inspection.
- `edit`: exact replacement.
- `write_file`: create or intentionally replace a whole file.
- `exec_cmd`: commands and tests, only when listed in the available tools.
- `question`: required user input.
- `todo_write`: useful multi-step tracking.
- `skill`: load specialized guidance.

