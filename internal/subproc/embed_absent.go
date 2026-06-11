//go:build !proxyembed

package subproc

// embeddedProxyImpl returns nil when the proxy binary is not embedded
// (default `go build` without -tags proxyembed). ChatGPT sub-agents then
// require a manually-run proxy.
func embeddedProxyImpl() (data []byte, name string) {
	return nil, ""
}
