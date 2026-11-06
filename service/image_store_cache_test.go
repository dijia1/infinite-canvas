package service

import (
	"sync"
	"testing"

	"github.com/basketikun/infinite-canvas/config"
)

func TestOSSStoreReusesClientsAndInvalidatesForConfigurationChanges(t *testing.T) {
	previous := config.Cfg
	t.Cleanup(func() { config.Cfg = previous })
	base := config.Config{MediaStorage: "oss", OSSRegion: "cn-hangzhou", OSSBucket: "cache-test", OSSInternalEndpoint: "https://internal.example", OSSPublicEndpoint: "https://public.example", OSSAccessKeyID: "test-id", OSSAccessKeySecret: "test-secret", OSSSignedURLTTL: "15m"}
	config.Cfg = base
	first, err := newImageStore()
	if err != nil {
		t.Fatal(err)
	}
	var wait sync.WaitGroup
	for i := 0; i < 16; i++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			store, err := newImageStore()
			if err != nil || store != first {
				t.Error("identical concurrent calls did not share one store")
			}
		}()
	}
	wait.Wait()
	changes := []func(*config.Config){
		func(c *config.Config) { c.OSSRegion = "cn-shanghai" },
		func(c *config.Config) { c.OSSBucket = "another-bucket" },
		func(c *config.Config) { c.OSSInternalEndpoint = "https://internal-2.example" },
		func(c *config.Config) { c.OSSPublicEndpoint = "https://public-2.example" },
		func(c *config.Config) { c.OSSAccessKeyID = "rotated-id" },
		func(c *config.Config) { c.OSSAccessKeySecret = "rotated-secret" },
		func(c *config.Config) { c.OSSSignedURLTTL = "30m" },
	}
	for i, change := range changes {
		config.Cfg = base
		before, err := newImageStore()
		if err != nil {
			t.Fatal(err)
		}
		change(&config.Cfg)
		after, err := newImageStore()
		if err != nil || after == before {
			t.Fatalf("configuration change %d did not invalidate store", i)
		}
	}
	config.Cfg.OSSAccessKeySecret = ""
	if _, err := newImageStore(); err == nil {
		t.Fatal("cache bypassed invalid configuration")
	}
	config.Cfg.MediaStorage, config.Cfg.MediaLocalDir = "local", t.TempDir()
	store, err := newImageStore()
	if err != nil || store.(localImageStore).directory != config.Cfg.MediaLocalDir {
		t.Fatal("local storage used an OSS cache entry")
	}
}
