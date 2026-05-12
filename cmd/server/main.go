package main

import (
	"log"
	"os"

	"github.com/sergiom/fakeartist/internal/bundler"
	"github.com/sergiom/fakeartist/internal/dao"
	"github.com/sergiom/fakeartist/internal/game"
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

	gameDAO := dao.NewGameDAO(driver)

	gm := game.NewGameManager(gameDAO)
	go gm.Run()

	log.Println("Building Frontend...")
	err = bundler.Build(bundler.BundleOptions{
		EntryPoints: []string{"frontend/app.jsx"},
		OutDir:      "web/dist",
		IsProd:      false,
	})
	if err != nil {
		log.Fatalf("Build failed: %v", err)
	}

	renderer, err := server.NewRenderer("web/dist/app.js")
	if err != nil {
		log.Fatalf("Renderer init failed: %v", err)
	}

	srv := server.New(gm, renderer)
	log.Printf("Starting Fake Artist Server on :%s", port)
	if err := srv.Start(port); err != nil {
		log.Fatal(err)
	}
}
