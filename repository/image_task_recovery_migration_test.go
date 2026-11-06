package repository

import (
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/model"
)

func TestImageRecoveryMigrationPreservesLegacyTasksAndPausedTasksAreNotClaimed(t *testing.T) {
	db := useImageTaskTestDB(t)
	for _, field := range []string{"Deadline", "PollFailures"} {
		if err := db.Migrator().DropColumn(&model.ImageGenerationTask{}, field); err != nil {
			t.Fatal(err)
		}
	}
	current := time.Now().UTC()
	legacy := model.ImageGenerationTask{ID: "legacy", OwnerUID: "owner", ClientRequestID: "request", Status: model.ImageTaskQueued, ProviderTaskID: "original-task", CreatedAt: current.Format(time.RFC3339Nano), ProviderConfig: "original-config"}
	if err := db.Omit("Deadline", "PollFailures").Create(&legacy).Error; err != nil {
		t.Fatal(err)
	}
	for pass := 0; pass < 2; pass++ {
		if err := MigrateDatabase(); err != nil {
			t.Fatal(err)
		}
	}
	stored, found, err := GetImageGenerationTask(legacy.ID)
	if err != nil || !found || stored.Deadline != nil || stored.PollFailures != 0 || stored.ProviderTaskID != legacy.ProviderTaskID || stored.ProviderConfig != legacy.ProviderConfig {
		t.Fatalf("migrated task=%+v err=%v", stored, err)
	}
	claimed, found, err := ClaimNextImageGenerationTask(current, time.Minute)
	if err != nil || !found || claimed.ID != legacy.ID {
		t.Fatalf("legacy claim=%+v found=%v err=%v", claimed, found, err)
	}
	if err := UpdateClaimedImageGenerationTask(claimed, map[string]any{"status": model.ImageTaskPaused, "claim_id": "", "lease_until": nil}); err != nil {
		t.Fatal(err)
	}
	if _, found, err := ClaimNextImageGenerationTask(current.Add(time.Hour), time.Minute); err != nil || found {
		t.Fatalf("paused task was automatically claimed: found=%v err=%v", found, err)
	}
}
