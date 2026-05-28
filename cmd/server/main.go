package main

import (
	"log"
	"os"
	"strconv"
	"time"

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
		P2PEnabled:      parseBool(os.Getenv("P2P_ENABLED"), true),
		GCIdleTTL:       parseDuration(os.Getenv("GC_IDLE_TTL"), 10*time.Minute),
		GCFinishedGrace: parseDuration(os.Getenv("GC_FINISHED_GRACE"), 1*time.Minute),
		GCSweepInterval: parseDuration(os.Getenv("GC_SWEEP_INTERVAL"), 1*time.Minute),
	}
	log.Printf("Config: P2P_ENABLED=%t GC_IDLE_TTL=%s GC_FINISHED_GRACE=%s GC_SWEEP_INTERVAL=%s",
		cfg.P2PEnabled, cfg.GCIdleTTL, cfg.GCFinishedGrace, cfg.GCSweepInterval)

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

func parseDuration(s string, def time.Duration) time.Duration {
	if s == "" {
		return def
	}
	d, err := time.ParseDuration(s)
	if err != nil {
		log.Printf("invalid duration %q, using default %s", s, def)
		return def
	}
	return d
}
