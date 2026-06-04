// Package version exposes the build version, injected at link time via ldflags.
//
//	go build -ldflags "-X github.com/sirhap/piercode/internal/version.Version=v1.2.3"
//
// GoReleaser and scripts/build.sh set this from the git tag. A plain `go build`
// or `go run` leaves the default "dev".
package version

// Version is the release version. Overridden at build time via -ldflags -X.
var Version = "dev"
