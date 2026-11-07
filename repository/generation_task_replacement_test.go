package repository

import (
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/model"
)

func TestCanvasRegenerationClosesAndCreatesAtomically(t *testing.T) {
	for _, kind := range []string{"image", "video"} {
		t.Run(kind, func(t *testing.T) {
			useRepositoryTestDB(t, newRepositoryTestConfig(t, "canvas_regeneration_"+kind))
			db, _ := DB()
			current := time.Now().UTC()
			oldOperation := model.OperationLog{ID: "original-operation", ActorUID: "owner", Status: model.OperationStatusSubmitted}
			if err := db.Create(&oldOperation).Error; err != nil {
				t.Fatal(err)
			}
			table := "image_generation_tasks"
			if kind == "image" {
				if err := db.Create(&model.ImageGenerationTask{ID: "original", OwnerUID: "owner", ClientRequestID: "old-client", Status: model.ImageTaskUncertain, ProviderTaskID: "upstream", OperationLogID: oldOperation.ID, ProviderConfig: "old-secret"}).Error; err != nil {
					t.Fatal(err)
				}
			} else {
				table = "video_generation_tasks"
				if err := db.Create(&model.VideoGenerationTask{ID: "original", OwnerUID: "owner", ClientRequestID: "old-client", Status: "paused", ProviderTaskID: "upstream", OperationLogID: oldOperation.ID, ProviderConfig: "old-secret", ResultURLsJSON: "[]"}).Error; err != nil {
					t.Fatal(err)
				}
			}
			replacement := &GenerationTaskReplacement{TaskID: "original", Audit: model.OperationLog{ID: "retry-audit", ActorUID: "owner", Action: "generation_task_regenerate", CreatedAt: current}}
			create := func(id, owner string) (string, error) {
				operation := model.OperationLog{ID: "new-operation", ActorUID: owner, Status: model.OperationStatusSubmitted}
				if kind == "image" {
					item, _, err := CreateImageGenerationTaskWithInputsAndOperationLog(model.ImageGenerationTask{ID: id, OwnerUID: owner, ClientRequestID: "new-client", Status: model.ImageTaskQueued, OperationLogID: operation.ID, ProviderConfig: "new-config"}, operation, nil, replacement)
					return item.ID, err
				}
				item, err := CreateVideoGenerationTask(model.VideoGenerationTask{ID: id, OwnerUID: owner, ClientRequestID: "new-client", Status: "queued", OperationLogID: operation.ID, ProviderConfig: "new-config", ResultURLsJSON: "[]"}, operation, nil, replacement)
				return item.ID, err
			}
			if _, err := create("new", "owner"); err == nil {
				t.Fatal("unconfirmed regeneration accepted")
			}
			replacement.ConfirmUncertain = true
			if _, err := create("new", "other"); err == nil {
				t.Fatal("closed another owner's task")
			}
			replacement.Audit.ID = "new-operation"
			if _, err := create("new", "owner"); err == nil {
				t.Fatal("audit failure did not roll back")
			}
			var before struct{ Status, ProviderConfig string }
			if err := db.Table(table).Where("id = 'original'").Take(&before).Error; err != nil || before.ProviderConfig != "old-secret" || before.Status == "failed" {
				t.Fatalf("old task changed on rollback: %+v %v", before, err)
			}
			var count int64
			if err := db.Table(table).Where("client_request_id = 'new-client'").Count(&count).Error; err != nil || count != 0 {
				t.Fatalf("new task survived rollback: %d %v", count, err)
			}
			replacement.Audit.ID = "retry-audit"
			if id, err := create("new", "owner"); err != nil || id != "new" {
				t.Fatalf("replacement=%s err=%v", id, err)
			}
			if id, err := create("duplicate", "owner"); err != nil || id != "new" {
				t.Fatalf("replay=%s err=%v", id, err)
			}
			var closed struct{ Status, ProviderConfig, ProviderTaskID string }
			if err := db.Table(table).Where("id = 'original'").Take(&closed).Error; err != nil || closed.Status != "failed" || closed.ProviderConfig != "" || closed.ProviderTaskID != "upstream" {
				t.Fatalf("old task=%+v err=%v", closed, err)
			}
			if err := db.Table(table).Where("client_request_id = 'new-client'").Count(&count).Error; err != nil || count != 1 {
				t.Fatalf("duplicate tasks=%d %v", count, err)
			}
			if err := db.Model(&model.OperationLog{}).Where("action = 'generation_task_regenerate'").Count(&count).Error; err != nil || count != 1 {
				t.Fatalf("duplicate audits=%d %v", count, err)
			}
		})
	}
}
