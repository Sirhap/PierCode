package prompt

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"hash/fnv"
	"strings"
	"sync"

	"github.com/sirhap/piercode/internal/memory"
	"github.com/sirhap/piercode/internal/skill"
	"github.com/sirhap/piercode/internal/tool"
	"github.com/sirhap/piercode/prompts"
)

const skillsPlaceholder = "{{SKILLS}}"

// systemInfoPlaceholder carries volatile content (current time) so it must be
// re-stamped on every render. The cache below stores prompts with this token
// still present, then substitutes it last — letting the expensive tool/skill
// doc build be reused while keeping the timestamp fresh.
const systemInfoPlaceholder = "{{SYSTEM_INFO}}"

// renderCache memoizes the heavy part of Render (tool sort + route-index build +
// skills doc + append) keyed by what actually affects it. The timestamp is NOT
// part of the body — it is substituted after the cache lookup.
type renderCacheKey struct {
	profileID  string
	rootDir    string
	toolsHash  uint64
	skillsHash uint64
}

// renderCacheMaxEntries bounds the memoization map. Each distinct rootDir,
// skill write, or tool-set change mints a new key, so without a cap the map
// grows for the life of the process. A small LRU keeps the hot prompts cached
// (one per active profile/workspace) while evicting stale ones.
const renderCacheMaxEntries = 64

var (
	renderCacheMu    sync.Mutex
	renderCache      = map[renderCacheKey][]byte{}
	renderCacheOrder []renderCacheKey // oldest first; LRU recency order
)

// renderCacheGet returns the cached body and promotes the key to most-recent.
// Caller must hold renderCacheMu.
func renderCacheGet(key renderCacheKey) ([]byte, bool) {
	body, ok := renderCache[key]
	if ok {
		renderCacheTouch(key)
	}
	return body, ok
}

// renderCachePut stores body and evicts the least-recently-used entry when the
// cap is exceeded. Caller must hold renderCacheMu.
func renderCachePut(key renderCacheKey, body []byte) {
	if _, exists := renderCache[key]; !exists {
		renderCacheOrder = append(renderCacheOrder, key)
	} else {
		renderCacheTouch(key)
	}
	renderCache[key] = body
	for len(renderCacheOrder) > renderCacheMaxEntries {
		oldest := renderCacheOrder[0]
		renderCacheOrder = renderCacheOrder[1:]
		delete(renderCache, oldest)
	}
}

// renderCacheTouch moves key to the most-recent position. Caller must hold
// renderCacheMu.
func renderCacheTouch(key renderCacheKey) {
	for i, k := range renderCacheOrder {
		if k == key {
			renderCacheOrder = append(renderCacheOrder[:i], renderCacheOrder[i+1:]...)
			renderCacheOrder = append(renderCacheOrder, key)
			return
		}
	}
}

func hashTools(tools []tool.ToolInfo) uint64 {
	h := fnv.New64a()
	for _, t := range tools {
		h.Write([]byte(t.Name))
		h.Write([]byte{0})
		h.Write([]byte(t.Description))
		h.Write([]byte{0})
	}
	return h.Sum64()
}

func hashSkills(skills []skill.Info) uint64 {
	h := fnv.New64a()
	for _, s := range skills {
		h.Write([]byte(s.Name))
		h.Write([]byte{0})
		h.Write([]byte(s.Description))
		h.Write([]byte{0})
	}
	return h.Sum64()
}

// promptFingerprint folds the profile's own prompt bytes into the cache key so a
// profile that overrides the prompt does not collide with another.
func promptFingerprint(b []byte) uint64 {
	sum := sha256.Sum256(b)
	return binary.LittleEndian.Uint64(sum[:8])
}

const DefaultProfileID = "default"

// Profile describes the prompt/tool/skill surface exposed to one AI adapter.
// Nil ToolNames or SkillNames means "inherit all currently available items";
// an empty non-nil slice means "expose none".
type Profile struct {
	ID string
	// Prompt nil means inherit the default prompt. A non-nil Prompt replaces
	// the default prompt for this profile, including an intentionally empty
	// prompt in tests or future locked-down profiles.
	Prompt       []byte
	PromptAppend []byte
	ToolNames    []string
	// ToolNamePrefixes, when non-empty, additionally admits any tool whose name
	// has one of these prefixes (e.g. "browser_" for the browser-agent profile,
	// which must expose the whole browser_* family without hardcoding ~44 names
	// or coupling this package to the executor registry). A tool passes the
	// filter if it matches ToolNames OR any prefix here. When BOTH ToolNames and
	// ToolNamePrefixes are nil, all tools are inherited (back-compat).
	ToolNamePrefixes []string
	SkillNames       []string
	// ContextHandoff, when non-empty, is appended to every AI-originated tool
	// result for this profile (e.g. Qwen's context-packet migration prompt).
	// Empty means the profile declares no per-call handoff guidance. Keeping it
	// on the profile lets new adapters opt in by registration instead of adding
	// a hardcoded platform check in the executor.
	ContextHandoff string
}

type ProfileRegistry struct {
	defaultPrompt []byte
	profiles      map[string]Profile
}

func NewProfileRegistry(defaultPrompt []byte) *ProfileRegistry {
	return &ProfileRegistry{
		defaultPrompt: defaultPrompt,
		profiles:      map[string]Profile{},
	}
}

func DefaultProfileRegistry(defaultPrompt []byte) *ProfileRegistry {
	// Keep adapter-specific profiles centralized here. Profiles should use
	// trusted embedded prompt bytes, not files from the writable workspace.
	registry := NewProfileRegistry(defaultPrompt)
	// Qwen profile: a slim Qwen-specific BASE prompt (not the generic init prompt)
	// whose §1 leads with the strongest "piercode-tool is the only transport, never a
	// Qwen native tool" rule — Qwen's function-calling RLHF otherwise reaches for its
	// own code_interpreter/web_search when it sees the generic prompt's tooling
	// context. PromptAppend adds only the context-packet handoff (the native-tool
	// guidance now lives in the base, so it isn't duplicated). {{TOOLS}} renders the
	// compact route index (names + one-line purpose, not full schema); detailed
	// parameters come from tool_help on demand.
	registry.Register(Profile{
		ID:           "qwen",
		Prompt:       prompts.QwenBasePrompt,
		PromptAppend: prompts.QwenPromptAppend,
	})
	// Worker profile: a sub-agent dispatched into its own AI tab. It inherits
	// the default prompt, gets the worker role + result-packet contract via
	// PromptAppend, and the periodic result-packet reminder via ContextHandoff.
	// spawn_agent (Phase B) selects this profile when seeding a new tab.
	registry.Register(Profile{
		ID:             "worker",
		PromptAppend:   prompts.WorkerPromptAppend,
		ContextHandoff: workerResultPacketReminder,
	})
	// ChatGPT profile: inherits the default prompt + all tools (no narrowing),
	// but appends a warning that ChatGPT's native python/python_user_visible tool
	// is a no-op here (it emits placeholder output with no real fs/shell/network),
	// so every local action must go through visible piercode-tool blocks. The
	// content script already fetches the prompt with ?adapter=chatgpt (the chatgpt
	// adapter's profile name is "chatgpt"), so Select("chatgpt") routes here with
	// no extension change needed.
	registry.Register(Profile{
		ID:           "chatgpt",
		PromptAppend: prompts.ChatGPTPromptAppend,
	})
	// Browser-agent profile: the AI hosted in the sidebar's embedded AI iframe
	// (chatgpt/qwen) that drives the user's real browser via browser_* tools. It
	// inherits the default prompt and gets the browser-operator role + per-turn
	// <page-snapshot> protocol via PromptAppend. The SW fetches it once with
	// GET /prompt?profile=browser-agent and prepends it to the first injected
	// message (chatgpt/qwen have no system slot). No ContextHandoff: the loop
	// re-injects a fresh snapshot every turn, so no per-result reminder is needed.
	// Constrain the rendered {{TOOLS}} list to the browser_* family (+ a couple
	// of generic helpers) so the prompt's "you have NO filesystem/shell tools"
	// claim is actually TRUE. Previously ToolNames was nil → FilterTools returned
	// ALL tools, so the rendered prompt advertised read_file/write_file/exec_cmd/
	// grep with docs; the model would then emit a non-browser tool which the SW's
	// rawContent reparse (extractToolCalls, unfiltered) actually EXECUTED against
	// the sandbox, ungated. ToolNamePrefixes covers the whole browser_* family
	// without hardcoding ~44 names; tool_help/question stay available as generic
	// no-side-effect helpers.
	registry.Register(Profile{
		ID: "browser-agent",
		// Use a slim browser-operator base prompt instead of inheriting the default
		// init prompt (whose §4-§16 are file/git/edit engineering, contradicting the
		// "no filesystem tools" role). The append adds the operator role + snapshot
		// protocol. ToolNamePrefixes/ToolNames keep the rendered {{TOOLS}} to the
		// browser_* family + generic helpers (audit Bug #5, full fix).
		Prompt:           prompts.BrowserAgentBasePrompt,
		PromptAppend:     prompts.BrowserAgentPromptAppend,
		ToolNamePrefixes: []string{"browser_"},
		ToolNames:        []string{"tool_help", "question"},
	})
	return registry
}

func (r *ProfileRegistry) Register(profile Profile) {
	id := normalizeProfileID(profile.ID)
	if id == "" {
		return
	}
	profile.ID = id
	r.profiles[id] = profile
}

func (r *ProfileRegistry) Select(rawID string) Profile {
	id := normalizeProfileID(rawID)
	if id == "" {
		return r.defaultProfile()
	}
	if profile, ok := r.profiles[id]; ok {
		if profile.ID == "" {
			profile.ID = id
		}
		if profile.Prompt == nil {
			profile.Prompt = r.defaultPrompt
		}
		return profile
	}
	return r.defaultProfile()
}

func (r *ProfileRegistry) defaultProfile() Profile {
	return Profile{
		ID:     DefaultProfileID,
		Prompt: r.defaultPrompt,
	}
}

func (p Profile) Render(rootDir string, tools []tool.ToolInfo, skills []skill.Info) []byte {
	return p.RenderWithSandbox(rootDir, "", nil, tools, skills)
}

func (p Profile) RenderWithSandbox(rootDir, permissionMode string, additionalAllowedDirs []string, tools []tool.ToolInfo, skills []skill.Info) []byte {
	body := p.renderBodyCached(rootDir, tools, skills)
	// Stamp the volatile timestamp + sandbox info last so the cached body can be
	// reused across calls within the same minute / tool set. The project-rules
	// file (CLAUDE.md/AGENTS.md) lives on disk and can change, so it is also
	// substituted here rather than baked into the cached body.
	out := strings.ReplaceAll(string(body), systemInfoPlaceholder, BuildSystemInfo(rootDir, permissionMode, additionalAllowedDirs))
	out = strings.ReplaceAll(out, projectRulesPlaceholder, BuildProjectRules(rootDir))
	out = memory.AppendMemoryDoc(out, rootDir)
	return []byte(out)
}

// renderBodyCached produces the prompt with {{SYSTEM_INFO}} still present, so
// the expensive tool/skill doc build is reused while the timestamp stays fresh.
// Cache key covers everything that changes the body: profile identity + prompt
// bytes, rootDir, and the tool/skill fingerprints.
func (p Profile) renderBodyCached(rootDir string, tools []tool.ToolInfo, skills []skill.Info) []byte {
	filteredTools := p.FilterTools(tools)
	filteredSkills := p.FilterSkills(skills)

	key := renderCacheKey{
		profileID:  p.ID,
		rootDir:    rootDir,
		toolsHash:  hashTools(filteredTools) ^ promptFingerprint(p.Prompt) ^ promptFingerprint(p.PromptAppend),
		skillsHash: hashSkills(filteredSkills),
	}

	renderCacheMu.Lock()
	if cached, ok := renderCacheGet(key); ok {
		renderCacheMu.Unlock()
		return cached
	}
	// Build while holding the lock to prevent duplicate computation when
	// multiple goroutines miss the cache simultaneously. The build is
	// deterministic and fast (template substitution), so holding the lock
	// is acceptable.
	content := []byte(renderBody(p.Prompt, filteredTools))
	content = AppendSkillsDoc(content, filteredSkills)
	if len(p.PromptAppend) > 0 {
		content = append(content, []byte("\n\n")...)
		content = append(content, []byte(renderBody(p.PromptAppend, filteredTools))...)
	}
	renderCachePut(key, content)
	renderCacheMu.Unlock()
	return content
}

func (p Profile) FilterTools(tools []tool.ToolInfo) []tool.ToolInfo {
	allowed := allowedNameSet(p.ToolNames)
	// nil ToolNames AND nil prefixes = inherit all (back-compat). A non-nil
	// allowlist OR any prefix narrows the set.
	if allowed == nil && len(p.ToolNamePrefixes) == 0 {
		return tools
	}
	prefixes := make([]string, 0, len(p.ToolNamePrefixes))
	for _, pre := range p.ToolNamePrefixes {
		if pre = strings.ToLower(strings.TrimSpace(pre)); pre != "" {
			prefixes = append(prefixes, pre)
		}
	}
	hasPrefix := func(name string) bool {
		for _, pre := range prefixes {
			if strings.HasPrefix(name, pre) {
				return true
			}
		}
		return false
	}
	filtered := make([]tool.ToolInfo, 0, len(tools))
	for _, item := range tools {
		lower := strings.ToLower(item.Name)
		_, named := allowed[lower]
		if named || hasPrefix(lower) {
			filtered = append(filtered, item)
		}
	}
	return filtered
}

func (p Profile) FilterSkills(skills []skill.Info) []skill.Info {
	allowed := allowedNameSet(p.SkillNames)
	if allowed == nil {
		return skills
	}
	filtered := make([]skill.Info, 0, len(skills))
	for _, item := range skills {
		if _, ok := allowed[strings.ToLower(item.Name)]; ok {
			filtered = append(filtered, item)
		}
	}
	return filtered
}

// AppendSkillsDoc injects the dynamic skills list. If the template contains the
// {{SKILLS}} placeholder, the list is substituted in place so it sits next to
// the Skills guidance. Otherwise it is appended at the end (back-compat for
// templates without the placeholder).
func AppendSkillsDoc(content []byte, skills []skill.Info) []byte {
	if bytes.Contains(content, []byte(skillsPlaceholder)) {
		return bytes.ReplaceAll(content, []byte(skillsPlaceholder), []byte(buildSkillsList(skills)))
	}
	if len(skills) == 0 {
		return content
	}
	return append(content, []byte("\n\n## 当前可用 Skills\n\n"+buildSkillsList(skills))...)
}

func buildSkillsList(skills []skill.Info) string {
	if len(skills) == 0 {
		return "（当前会话没有可用 skills。）"
	}
	var sb strings.Builder
	for i, sk := range skills {
		if i > 0 {
			sb.WriteString("\n")
		}
		sb.WriteString("- `")
		sb.WriteString(sk.Name)
		sb.WriteString("`: ")
		sb.WriteString(conciseSkillDescription(sk.Description))
	}
	return sb.String()
}

func conciseSkillDescription(description string) string {
	description = firstLine(description)
	for _, sep := range []string{". ", "。", "; ", "；"} {
		if i := strings.Index(description, sep); i >= 0 {
			description = strings.TrimSpace(description[:i+len(strings.TrimSpace(sep))])
			break
		}
	}
	const max = 180
	if len([]rune(description)) <= max {
		return description
	}
	runes := []rune(description)
	return string(runes[:max-1]) + "…"
}

func allowedNameSet(names []string) map[string]struct{} {
	if names == nil {
		return nil
	}
	allowed := make(map[string]struct{}, len(names))
	for _, name := range names {
		normalized := strings.ToLower(strings.TrimSpace(name))
		if normalized == "" {
			continue
		}
		allowed[normalized] = struct{}{}
	}
	return allowed
}

func normalizeProfileID(id string) string {
	return strings.ToLower(strings.TrimSpace(id))
}
