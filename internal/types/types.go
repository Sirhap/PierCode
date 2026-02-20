package types

type ToolRequest struct {
	Name   string                 `json:"name"`
	Args   map[string]interface{} `json:"args"`
	Reason string                 `json:"reason,omitempty"`
}

type ToolResponse struct {
	Status string `json:"status"`
	Output string `json:"output"`
	Error  string `json:"error,omitempty"`
}

type Config struct {
	RootDir string
	Port    int
	Timeout int
	Token   string
}

type Settings struct {
	Token     string `json:"token"`
	CreatedAt string `json:"created_at"`
}
