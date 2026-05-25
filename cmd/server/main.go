package main

import (
	"log"
	"os"
	"strconv"

	"github.com/sergiom/fakeartist/internal/bundler"
	"github.com/sergiom/fakeartist/internal/server"
	"github.com/sergiom/fakeartist/internal/storage"
)

func main() {
	port := os.Getenv("SERVER_PORT")
	if port == "" {
		port = "6060"
	}

	storageDriver := os.Getenv("STORAGE_DRIVER")
	if storageDriver == "" {
		storageDriver = "json"
	}
	storagePath := os.Getenv("STORAGE_PATH")

	driver, err := storage.NewDriver(storageDriver, storagePath)
	if err != nil {
		log.Fatalf("Failed to init storage driver: %v", err)
	}

	// BUNDLE_DEV=true skips minification (faster iteration). Default is
	// production-mode bundling so docker images ship a minified app.js.
	isProd := !parseBool(os.Getenv("BUNDLE_DEV"), false)
	log.Printf("Building Frontend... (minified=%t)", isProd)
	err = bundler.Build(bundler.BundleOptions{
		EntryPoints: []string{"frontend/app.jsx"},
		OutDir:      "web/dist",
		IsProd:      isProd,
	})
	if err != nil {
		log.Fatalf("Build failed: %v", err)
	}

	renderer, err := server.NewRenderer("web/dist/app.js")
	if err != nil {
		log.Fatalf("Renderer init failed: %v", err)
	}

	cfg := server.Config{
		// P2P_ENABLED defaults to true post-PR 10 (T10.2). Set to "false"
		// only in tests or to roll back the migration.
		P2PEnabled: parseBool(os.Getenv("P2P_ENABLED"), true),
	}
	log.Printf("Config: P2P_ENABLED=%t", cfg.P2PEnabled)

	srv := server.New(renderer, cfg)
	if cfg.P2PEnabled {
		srv.EnableP2P(driver)
	}
	log.Printf("Starting Fake Artist Server on :%s", port)
	if err := srv.Start(port); err != nil {
		log.Fatal(err)
	}
}

func parseBool(s string, def bool) bool {
	if s == "" {
		return def
	}
	b, err := strconv.ParseBool(s)
	if err != nil {
		return def
	}
	return b
}
