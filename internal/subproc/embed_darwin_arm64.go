//go:build proxyembed && darwin && arm64

package subproc

import _ "embed"

//go:embed proxybin/chatgpt-proxy-darwin-arm64
var proxyBin []byte

func embeddedProxyImpl() (data []byte, name string) {
	return proxyBin, "chatgpt-proxy"
}
