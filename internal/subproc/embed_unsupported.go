//go:build proxyembed && !(darwin && arm64) && !(darwin && amd64) && !(linux && amd64) && !(windows && amd64)

package subproc

// embeddedProxyImpl falls back to nil when -tags proxyembed is set but the
// target platform has no PyInstaller-built proxy (e.g. linux/arm64). The
// feature is simply unavailable there; not a build error.
func embeddedProxyImpl() (data []byte, name string) {
	return nil, ""
}
