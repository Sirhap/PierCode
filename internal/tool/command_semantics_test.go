package tool

import "testing"

func TestInterpretCommandResult(t *testing.T) {
	cases := []struct {
		name        string
		cmd         string
		exitCode    int
		wantError   bool
		wantNoteSub string
	}{
		// exit 0 always success
		{"grep match", "grep foo file.txt", 0, false, ""},
		{"plain success", "go build ./...", 0, false, ""},

		// grep/rg: exit 1 = no matches, not an error
		{"grep no match", "grep foo file.txt", 1, false, "No matches"},
		{"rg no match", "rg foo", 1, false, "No matches"},
		{"grep real error", "grep foo missing.txt", 2, true, ""},

		// the *last* command in a pipeline decides the exit code
		{"piped grep no match", "cat file.txt | grep foo", 1, false, "No matches"},
		{"chained grep no match", "ls && grep foo file.txt", 1, false, "No matches"},

		// diff: exit 1 = files differ, not an error
		{"diff differs", "diff a.txt b.txt", 1, false, "differ"},
		{"diff error", "diff a.txt missing.txt", 2, true, ""},

		// test/[: exit 1 = condition false, not an error
		{"test false", "test -f missing", 1, false, "false"},
		{"bracket false", "[ -f missing ]", 1, false, "false"},

		// find: exit 1 = some dirs inaccessible, not a hard error
		{"find partial", "find . -name '*.go'", 1, false, "inaccessible"},

		// default: any nonzero is an error for unknown commands
		{"unknown nonzero", "go test ./...", 1, true, ""},
		{"unknown nonzero 2", "node script.js", 3, true, ""},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := interpretCommandResult(c.cmd, c.exitCode)
			if got.isError != c.wantError {
				t.Errorf("isError = %v, want %v", got.isError, c.wantError)
			}
			if c.wantNoteSub != "" && !contains(got.message, c.wantNoteSub) {
				t.Errorf("message = %q, want substring %q", got.message, c.wantNoteSub)
			}
		})
	}
}

func TestExtractLastBaseCommand(t *testing.T) {
	cases := map[string]string{
		"grep foo":          "grep",
		"cat f | grep foo":  "grep",
		"ls && grep foo":    "grep",
		"a; b; diff x y":    "diff",
		"  rg   pattern  ":  "rg",
		"/usr/bin/grep foo": "grep",
		"FOO=bar grep x":    "grep",
		"":                  "",
	}
	for in, want := range cases {
		if got := extractLastBaseCommand(in); got != want {
			t.Errorf("extractLastBaseCommand(%q) = %q, want %q", in, got, want)
		}
	}
}

func contains(s, sub string) bool {
	return len(sub) == 0 || (len(s) >= len(sub) && indexOf(s, sub) >= 0)
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
