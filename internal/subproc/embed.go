package subproc

// embeddedProxy returns the embedded chatgpt-proxy binary bytes and the
// filename to extract it as, for the current platform. When no binary was
// embedded (the default, until a release build drops one into proxybin/), it
// returns nil — Start treats that as "feature unavailable, not an error".
//
// Release builds place a PyInstaller-built single-file proxy at
//   internal/subproc/proxybin/chatgpt-proxy-<goos>-<goarch>[.exe]
// and a platform-specific embed_<goos>_<arch>.go file (build-tagged
// `proxyembed && <goos> && <arch>`) pulls in ONLY that platform's binary via
// //go:embed. Because each file embeds only its own platform, a release build
// on macOS arm64 needs just the darwin-arm64 binary present, not all four.
//
// Without -tags proxyembed (the default `go build ./...`), embed_absent.go
// supplies a nil implementation, so no binary is required and the build works
// with an empty proxybin/. With -tags proxyembed on an unsupported platform,
// embed_unsupported.go provides the same nil fallback.

func embeddedProxy() (data []byte, name string) {
	return embeddedProxyImpl()
}
