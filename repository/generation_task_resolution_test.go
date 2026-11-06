package repository

import (
	"errors"
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/model"
)

func TestGenerationTaskResolutionIsAuditedAtomicAndNeverReplacesKnownUpstream(t *testing.T) {
	for _, kind := range []string{"image", "video"} {
		t.Run(kind, func(t *testing.T) {
			useRepositoryTestDB(t, newRepositoryTestConfig(t, "task_resolution_"+kind))
			db, _ := DB()
			current := time.Now().UTC().Truncate(time.Microsecond)
			table, errorColumn := "image_generation_tasks", "error_message"
			if kind == "image" {
				if err := db.Create(&model.ImageGenerationTask{ID: "task", OwnerUID: "owner", ClientRequestID: "request", Status: model.ImageTaskUncertain, OperationLogID: "original-operation", ProviderConfig: "secret"}).Error; err != nil {
					t.Fatal(err)
				}
			} else {
				table, errorColumn = "video_generation_tasks", "error"
				if err := db.Create(&model.VideoGenerationTask{ID: "task", OwnerUID: "owner", ClientRequestID: "request", Status: "uncertain", OperationLogID: "original-operation", ProviderConfig: "secret", ResultURLsJSON: "[]"}).Error; err != nil {
					t.Fatal(err)
				}
			}
			if err := db.Create(&model.OperationLog{ID: "original-operation", Status: model.OperationStatusSubmitted}).Error; err != nil {
				t.Fatal(err)
			}
			audit := model.OperationLog{ID: "attached-operation", ActorUID: "admin", Action: "generation_task_resolution", RequestSummary: `{"action":"attach","reason":"供应商已核对"}`, CreatedAt: current}
			if err := ResolveGenerationTask(kind, "task", "attach", "original-upstream", current, time.Hour, 4, audit); err != nil {
				t.Fatal(err)
			}
			var task struct {
				Status, ProviderTaskID string
				Deadline               *time.Time
			}
			if err := db.Table(table).Where("id = ?", "task").Take(&task).Error; err != nil || task.Status != "running" || task.ProviderTaskID != "original-upstream" || task.Deadline == nil {
				t.Fatalf("attached=%+v err=%v", task, err)
			}
			if err := ResolveGenerationTask(kind, "task", "attach", "replacement", current, time.Hour, 4, model.OperationLog{ID: "duplicate"}); !errors.Is(err, ErrGenerationTaskResolutionConflict) {
				t.Fatalf("duplicate resolution: %v", err)
			}
			if err := db.Table(table).Where("id = ?", "task").Update("status", "uncertain").Error; err != nil {
				t.Fatal(err)
			}
			if err := ResolveGenerationTask(kind, "task", "attach", "replacement", current, time.Hour, 4, model.OperationLog{ID: "replacement"}); !errors.Is(err, ErrGenerationTaskResolutionConflict) {
				t.Fatalf("replaced known upstream: %v", err)
			}
			// A failed audit write must roll back the state change as well.
			if err := ResolveGenerationTask(kind, "task", "close", "", current, time.Hour, 4, audit); err == nil {
				t.Fatal("duplicate audit key accepted")
			}
			if err := db.Table(table).Where("id = ?", "task").Take(&task).Error; err != nil || task.Status != "uncertain" {
				t.Fatalf("failed audit changed task=%+v err=%v", task, err)
			}
			audit.ID, audit.RequestSummary = "closed-operation", `{"action":"close","reason":"供应商确认失败"}`
			if err := ResolveGenerationTask(kind, "task", "close", "", current, time.Hour, 4, audit); err != nil {
				t.Fatal(err)
			}
			var closed struct{ Status, ProviderTaskID, FinishedAt string }
			if err := db.Table(table).Select("status", "provider_task_id", "finished_at").Where("id = ?", "task").Take(&closed).Error; err != nil || closed.Status != "failed" || closed.ProviderTaskID != "original-upstream" || closed.FinishedAt == "" {
				t.Fatalf("closed=%+v err=%v", closed, err)
			}
			var operation model.OperationLog
			if err := db.First(&operation, "id = ?", "original-operation").Error; err != nil || operation.Status != model.OperationStatusFailure || operation.ErrorMessage == "" {
				t.Fatalf("original audit=%+v err=%v", operation, err)
			}
			operation = model.OperationLog{}
			if err := db.First(&operation, "id = ?", audit.ID).Error; err != nil || operation.ActorUID != "admin" || operation.RequestSummary != audit.RequestSummary || operation.ProviderTaskID != "original-upstream" {
				t.Fatalf("resolution audit=%+v err=%v", operation, err)
			}
			var message string
			if err := db.Table(table).Select(errorColumn).Where("id = ?", "task").Scan(&message).Error; err != nil || message == "" {
				t.Fatalf("failure message=%q err=%v", message, err)
			}
		})
	}
}
