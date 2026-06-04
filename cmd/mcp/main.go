package main

import (
	"context"
	"flag"
	"fmt"
	"os"

	"github.com/sirhap/piercode/internal/claudemcp"
)

func main() {
	apiDefault := os.Getenv("PIERCODE_API_URL")
	if apiDefault == "" {
		apiDefault = "http://127.0.0.1:39527"
	}
	tokenDefault := os.Getenv("PIERCODE_TOKEN")

	apiURL := flag.String("api", apiDefault, "PierCode API URL")
	token := flag.String("token", tokenDefault, "PierCode bearer token")
	flag.Parse()

	server := claudemcp.NewServer(claudemcp.Config{
		APIURL: *apiURL,
		Token:  *token,
	})
	if err := server.Run(context.Background(), os.Stdin, os.Stdout); err != nil && err != context.Canceled {
		fmt.Fprintf(os.Stderr, "piercode MCP server error: %v\n", err)
		os.Exit(1)
	}
}
