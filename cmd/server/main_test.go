package main

import (
	"testing"

	"github.com/sirhap/piercode/internal/portutil"
)

func TestWindowsNetstatLinePIDMatchesExactListeningPort(t *testing.T) {
	cases := []struct {
		name string
		line string
		port int
		want int
		ok   bool
	}{
		{
			name: "exact listening port",
			line: "  TCP    127.0.0.1:80          0.0.0.0:0              LISTENING       222",
			port: 80,
			want: 222,
			ok:   true,
		},
		{
			name: "prefix port does not match",
			line: "  TCP    127.0.0.1:8080        0.0.0.0:0              LISTENING       111",
			port: 80,
			ok:   false,
		},
		{
			name: "established connection ignored",
			line: "  TCP    127.0.0.1:80          127.0.0.1:50000        ESTABLISHED     333",
			port: 80,
			ok:   false,
		},
		{
			name: "ipv6 exact listening port",
			line: "  TCP    [::]:39527            [::]:0                 LISTENING       444",
			port: 39527,
			want: 444,
			ok:   true,
		},
	}

	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := portutil.WindowsNetstatLinePID(tt.line, tt.port)
			if ok != tt.ok || got != tt.want {
				t.Fatalf("expected pid=%d ok=%v, got pid=%d ok=%v", tt.want, tt.ok, got, ok)
			}
		})
	}
}
