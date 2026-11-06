package repository

import (
	"strings"
	"testing"

	"github.com/basketikun/infinite-canvas/model"
)

func TestTerminalCredentialCleanupIsRepeatableAndPreservesRecoveryAndReplay(t *testing.T) {
	db := useImageTaskTestDB(t)
	statuses := []string{"preparing", "queued", "submitting", "running", "saving", "paused", "uncertain", "succeeded", "failed"}
	for _, status := range statuses {
		image := model.ImageGenerationTask{ID: "image-" + status, OwnerUID: "owner", ClientRequestID: "image-" + status, Status: model.ImageGenerationTaskStatus(status), ProviderConfig: "private-config", ProviderTaskID: "original-upstream", RequestHash: strings.Repeat("a", 64), RequestSchemaJSON: `{"version":1}`, ResultMediaIDsJSON: `["original-result"]`}
		video := model.VideoGenerationTask{ID: "video-" + status, OwnerUID: "owner", ClientRequestID: "video-" + status, Status: status, ProviderConfig: "private-config", ProviderTaskID: "original-upstream", RequestHash: strings.Repeat("a", 64), RequestJSON: `{"prompt":"original"}`, ResultMediaIDsJSON: `["original-result"]`}
		if err := db.Create(&image).Error; err != nil {
			t.Fatal(err)
		}
		if err := db.Create(&video).Error; err != nil {
			t.Fatal(err)
		}
	}
	for pass := 0; pass < 2; pass++ {
		if err := MigrateDatabase(); err != nil {
			t.Fatal(err)
		}
	}
	for _, status := range statuses {
		image, _, err := GetImageGenerationTaskByClientRequest("owner", "image-"+status)
		if err != nil {
			t.Fatal(err)
		}
		video, _, err := GetVideoGenerationTaskByClient("owner", "video-"+status)
		if err != nil {
			t.Fatal(err)
		}
		expected := "private-config"
		if status == "succeeded" || status == "failed" {
			expected = ""
		}
		if image.ProviderConfig != expected || video.ProviderConfig != expected {
			t.Fatalf("wrong credential retention for %s", status)
		}
		if image.ProviderTaskID != "original-upstream" || video.ProviderTaskID != "original-upstream" || image.RequestHash != strings.Repeat("a", 64) || video.RequestHash != strings.Repeat("a", 64) || image.ResultMediaIDsJSON != `["original-result"]` || video.RequestJSON != `{"prompt":"original"}` {
			t.Fatalf("cleanup changed replay or recovery data for %s", status)
		}
	}
}
