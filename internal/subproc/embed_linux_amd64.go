//go:build proxyembed && linux && amd64

package subproc

import _ "embed"

//go:embed proxybin/chatgpt-proxy-linux-amd64
var proxyBin []byte

func embeddedProxyImpl() (data []byte, name string) {
	return proxyBin, "chatgpt-proxy"
}
