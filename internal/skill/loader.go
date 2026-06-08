package skill

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type Info struct {
	Name        string
	Description string
	Dir         string
	Location    string // absolute path to SKILL.md
}

// LoadInfos is hot: /prompt, /skills, and every periodic prompt re-injection
// call it, and each call stats 7 dirs and reads+parses every SKILL.md. Skills
// almost never change mid-session, so cache results per rootDir with a short
// TTL. The TTL bounds staleness (a freshly written skill shows up within
// cacheTTL) without paying the disk walk on every request.
const cacheTTL = 3 * time.Second

type loadCacheEntry struct {
	infos []Info
	at    time.Time
}

var (
	loadCacheMu sync.Mutex
	loadCache   = map[string]loadCacheEntry{}
)

// InvalidateCache drops the cached skill listing for rootDir (or all roots when
// rootDir is empty). Call after writing a skill if you need it visible
// immediately rather than within the TTL.
func InvalidateCache(rootDir string) {
	loadCacheMu.Lock()
	defer loadCacheMu.Unlock()
	if rootDir == "" {
		loadCache = map[string]loadCacheEntry{}
		return
	}
	delete(loadCache, rootDir)
}

func SkillDirs(rootDir string) []string {
	home, _ := os.UserHomeDir()
	return []string{
		filepath.Join(rootDir, ".skills"),
		filepath.Join(rootDir, ".piercode", "skills"),
		filepath.Join(rootDir, ".agent", "skills"),
		filepath.Join(rootDir, ".claude", "skills"),
		filepath.Join(home, ".piercode", "skills"),
		filepath.Join(home, ".agent", "skills"),
		filepath.Join(home, ".claude", "skills"),
		filepath.Join(home, ".agents", "skills"),
	}
}

func LoadInfos(rootDir string) []Info {
	loadCacheMu.Lock()
	if e, ok := loadCache[rootDir]; ok && time.Since(e.at) < cacheTTL {
		infos := e.infos
		loadCacheMu.Unlock()
		return infos
	}
	loadCacheMu.Unlock()

	infos := loadInfosUncached(rootDir)

	loadCacheMu.Lock()
	loadCache[rootDir] = loadCacheEntry{infos: infos, at: time.Now()}
	loadCacheMu.Unlock()
	return infos
}

func loadInfosUncached(rootDir string) []Info {
	seen := map[string]Info{}
	var order []string

	for _, dir := range SkillDirs(rootDir) {
		if _, err := os.Stat(dir); err != nil {
			continue
		}
		log.Printf("[Skill] 扫描目录: %s", dir)
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			// 跟随软链接：用 os.Stat 而非 entry.Type()
			subPath := filepath.Join(dir, entry.Name())
			info, err := os.Stat(subPath)
			if err != nil || !info.IsDir() {
				continue
			}
			skillFile := findSkillMd(subPath)
			if skillFile == "" {
				continue
			}
			data, err := os.ReadFile(skillFile)
			if err != nil {
				continue
			}
			sk := parse(skillFile, string(data))
			sk.Dir = subPath
			sk.Location = skillFile
			log.Printf("[Skill] 加载: name=%s description=%.60s", sk.Name, sk.Description)
			if _, exists := seen[sk.Name]; !exists {
				order = append(order, sk.Name)
			}
			seen[sk.Name] = sk
		}
	}

	log.Printf("[Skill] 共加载 %d 个 skill", len(order))
	result := make([]Info, 0, len(order))
	for _, name := range order {
		result = append(result, seen[name])
	}
	return result
}

func Get(rootDir, name string) (Info, bool) {
	if strings.ContainsAny(name, "/\\") || strings.Contains(name, "..") {
		return Info{}, false
	}
	// Resolve a named skill against disk directly, not the cached listing. This
	// path runs when the model actually loads a skill (cold, infrequent), and
	// must see a skill written moments earlier (e.g. via write_file) without
	// waiting out the LoadInfos cache TTL. Only the bulk listing is cached.
	for _, info := range loadInfosUncached(rootDir) {
		if strings.EqualFold(info.Name, name) {
			return info, true
		}
	}
	return Info{}, false
}

func FindSkill(rootDir, name string) (content, dir string, err error) {
	if strings.ContainsAny(name, "/\\") || strings.Contains(name, "..") {
		return "", "", fmt.Errorf("invalid skill name: %q", name)
	}
	for _, d := range SkillDirs(rootDir) {
		// flat file: dir/<name>.md
		p := filepath.Join(d, name+".md")
		if data, e := os.ReadFile(p); e == nil {
			return string(data), d, nil
		}
		// subdir: dir/<name>/SKILL.md (case-insensitive match on dir name)
		entries, e := os.ReadDir(d)
		if e != nil {
			continue
		}
		for _, entry := range entries {
			if entry.IsDir() && strings.EqualFold(entry.Name(), name) {
				skillPath := filepath.Join(d, entry.Name(), "SKILL.md")
				if data, e := os.ReadFile(skillPath); e == nil {
					return string(data), filepath.Join(d, entry.Name()), nil
				}
			}
		}
	}
	return "", "", fmt.Errorf("skill %q not found", name)
}

// findSkillMd 在目录下查找 SKILL.md（大小写不敏感）
func findSkillMd(dir string) string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return ""
	}
	for _, e := range entries {
		if !e.IsDir() && strings.EqualFold(e.Name(), "skill.md") {
			return filepath.Join(dir, e.Name())
		}
	}
	return ""
}

func parse(path, content string) Info {
	name := filepath.Base(filepath.Dir(path))
	description := ""

	if !strings.HasPrefix(content, "---") {
		return Info{Name: name, Description: description}
	}
	// Find the closing fence on a line boundary, not the first "---" substring:
	// a frontmatter value may legitimately contain "---" (e.g. a description like
	// "step 1 --- step 2"), and a raw substring search would truncate the block.
	allLines := strings.Split(content, "\n")
	closeIdx := -1
	for i := 1; i < len(allLines); i++ {
		if strings.TrimSpace(allLines[i]) == "---" {
			closeIdx = i
			break
		}
	}
	if closeIdx < 0 {
		return Info{Name: name, Description: description}
	}
	lines := allLines[1:closeIdx]
	for i := 0; i < len(lines); i++ {
		line := lines[i]
		line = strings.TrimSpace(line)
		if k, v, ok := strings.Cut(line, ":"); ok {
			v = strings.TrimSpace(v)
			switch strings.TrimSpace(k) {
			case "name":
				name = v
			case "description":
				if v == ">" || v == "|" {
					var parts []string
					for i+1 < len(lines) {
						next := lines[i+1]
						if strings.TrimSpace(next) == "" {
							i++
							continue
						}
						if !strings.HasPrefix(next, " ") && !strings.HasPrefix(next, "\t") {
							break
						}
						parts = append(parts, strings.TrimSpace(next))
						i++
					}
					description = strings.Join(parts, " ")
				} else {
					description = strings.Trim(v, "\"'")
				}
			}
		}
	}
	return Info{Name: name, Description: description}
}
