package service

import (
	"context"
	"strings"
	"testing"

	"github.com/basketikun/infinite-canvas/ai"
)

func TestPrepareImageTaskResultMediaRequiresPortalIdentity(t *testing.T) {
	for name, ctx := range map[string]context.Context{
		"missing identity": context.Background(),
		"empty UID":        WithPortalUser(context.Background(), PortalUser{}),
		"blank UID":        WithPortalUser(context.Background(), PortalUser{UID: "  "}),
	} {
		t.Run(name, func(t *testing.T) {
			_, err := prepareImageTaskResultMedia(ctx, []ai.ImageResult{{Data: []byte("image")}})
			if err == nil || !strings.Contains(err.Error(), "Portal") {
				t.Fatalf("prepareImageTaskResultMedia() error = %v, want Portal identity error", err)
			}
		})
	}
}
