package server

import (
	"encoding/json"
	"fmt"
	"io/ioutil"
	"sync"

	"rogchap.com/v8go"
)

type Renderer struct {
	iso   *v8go.Isolate
	ctx   *v8go.Context
	mutex sync.Mutex
	// In production, we might want a pool of contexts or just one global if stateless.
	// For simplicity, one context re-used (watch out for pollution) or re-created.
	// V8Go contexts are cheap-ish. Let's reuse isolate, new context per request or reuse?
	// React SSR usually needs a fresh context or careful cleanup.
	// Let's reload the script every time for Dev, or once for Prod?
	// Better: One Render Script loaded into a cached template/script, run per request.
	scriptContent string
}

func NewRenderer(scriptPath string) (*Renderer, error) {
	iso := v8go.NewIsolate()

	// Read script
	bytes, err := ioutil.ReadFile(scriptPath)
	if err != nil {
		return nil, err
	}

	return &Renderer{
		iso:           iso,
		scriptContent: string(bytes),
	}, nil
}

// ReloadScript re-reads the file (for dev mode)
func (r *Renderer) ReloadScript(scriptPath string) error {
	bytes, err := ioutil.ReadFile(scriptPath)
	if err != nil {
		return err
	}
	r.mutex.Lock()
	r.scriptContent = string(bytes)
	r.mutex.Unlock()
	return nil
}

// Render executes the SSR logic.
// url: The request path.
// state: Initial Redux/Context state.
func (r *Renderer) Render(url string, state interface{}) (string, error) {
	r.mutex.Lock()
	script := r.scriptContent
	r.mutex.Unlock()

	ctx := v8go.NewContext(r.iso)
	// We should defer ctx.Close() but v8go 0.9 context lifecycle is managed by GC usually,
	// or explicit close if we want to free immediately.
	defer ctx.Close()

	// Inject Global Helper to receive the result?
	// Or simply run the script which calls a global function.

	// Convention:
	// The bundle defines `globalThis.SSR_RENDER = function(url, state) { ... return html; }`

	// Load the bundle
	_, err := ctx.RunScript(script, "server.js")
	if err != nil {
		return "", fmt.Errorf("failed to run bundle: %v", err)
	}

	// Prepare Args
	stateJson, _ := json.Marshal(state)

	val, err := ctx.RunScript(fmt.Sprintf("SSR_RENDER('%s', %s)", url, string(stateJson)), "render_call.js")
	if err != nil {
		// JS Error
		return "", fmt.Errorf("render error: %v", err)
	}

	return val.String(), nil
}
