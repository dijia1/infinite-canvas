package service

import (
	"context"
	"strings"
	"testing"

	"github.com/basketikun/infinite-canvas/ai"
)

func TestPersistGeneratedImagesRequiresPortalIdentity(t *testing.T) {
	_, err := persistGeneratedImages(context.Background(), []ai.ImageResult{{Data: []byte("image")}})
	if err == nil || !strings.Contains(err.Error(), "Portal") {
		t.Fatalf("persistGeneratedImages() error = %v, want Portal identity error", err)
	}
}
