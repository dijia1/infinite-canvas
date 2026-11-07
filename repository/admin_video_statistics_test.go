package repository

import (
	"github.com/basketikun/infinite-canvas/model"
	"testing"
	"time"
)

func TestVideoStatisticsFinishedRangeAndOperationStatusFilters(t *testing.T) {
	task, _ := videoFixture(t)
	createVideoFixture(t, task)
	duplicate := task
	duplicate.ID = "duplicate"
	duplicate.OperationLogID = "duplicate-operation"
	if _, err := CreateVideoGenerationTask(duplicate, model.OperationLog{ID: duplicate.OperationLogID}, []string{"reference"}, nil); err != nil {
		t.Fatal(err)
	}
	db, _ := DB()
	var count int64
	if err := db.Model(&model.OperationLog{}).Where("action = ?", "video_generate").Count(&count).Error; err != nil || count != 1 {
		t.Fatalf("idempotent logs=%d err=%v", count, err)
	}
	for _, status := range []string{"queued", "submitting", "running", "saving", "paused", "uncertain", "succeeded", "failed"} {
		if err := db.Model(&model.VideoGenerationTask{}).Where("id = ?", task.ID).Update("status", status).Error; err != nil {
			t.Fatal(err)
		}
		items, total, err := ListOperationLogs(model.OperationLogQuery{Status: status})
		if err != nil || total != 1 || len(items) != 1 {
			t.Fatalf("status %s: %d %v", status, total, err)
		}
		_, total, err = ListOperationLogs(model.OperationLogQuery{Status: "submitted"})
		if err != nil || total != 1 {
			t.Fatalf("lost submitted audit status: %d %v", total, err)
		}
	}
	claimed := task
	claimed.ClaimID = "lease"
	leaseUntil := time.Now().UTC().Add(time.Minute)
	if err := db.Model(&model.VideoGenerationTask{}).Where("id = ?", task.ID).Updates(map[string]any{"claim_id": "lease", "lease_until": leaseUntil, "status": "running"}).Error; err != nil {
		t.Fatal(err)
	}
	if err := UpdateClaimedVideoTask(claimed, map[string]any{"provider_task_id": "new-upstream"}); err != nil {
		t.Fatal(err)
	}
	live, err := ListVideoTasksForOperations([]string{task.OperationLogID})
	if err != nil || len(live) != 1 || live[0].ProviderTaskID != "new-upstream" || live[0].Status != "running" {
		t.Fatalf("live audit=%+v err=%v", live, err)
	}
	start := time.Date(2026, 9, 7, 16, 0, 0, 0, time.UTC)
	end := start.Add(24 * time.Hour)
	for i, fixture := range []struct {
		status   string
		finished time.Time
		want     int
	}{
		{"succeeded", start.Add(-time.Microsecond), 0}, {"succeeded", start, 1}, {"succeeded", end.Add(-time.Microsecond), 1}, {"succeeded", end, 0}, {"failed", start, 0}, {"paused", start, 0}, {"uncertain", start, 0},
	} {
		if err := db.Model(&model.VideoGenerationTask{}).Where("id = ?", task.ID).Updates(map[string]any{"status": fixture.status, "finished_at": fixture.finished}).Error; err != nil {
			t.Fatal(err)
		}
		items, err := ListSucceededVideoGenerationTasksFinishedBetween(start, end)
		if err != nil || len(items) != fixture.want {
			t.Fatalf("boundary %d: %d want %d err %v", i, len(items), fixture.want, err)
		}
	}
}
