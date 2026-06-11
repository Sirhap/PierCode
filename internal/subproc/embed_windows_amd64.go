//go:build proxyembed && windows && amd64

package subproc

import _ "embed"

//go:embed proxybin/chatgpt-proxy-windows-amd64.exe
var proxyBin []byte

func embeddedProxyImpl() (data []byte, name string) {
	return proxyBin, "chatgpt-proxy.exe"
}
