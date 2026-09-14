package repository

import (
	"testing"

	"github.com/basketikun/infinite-canvas/model"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func repositoryWorkflow(id, owner string) model.Workflow {
	return model.Workflow{
		ID: id, OwnerUID: owner, Name: id, Revision: 1,
		Graph:     model.WorkflowGraph{Version: 1, Nodes: []model.WorkflowNode{}, Connections: []model.WorkflowConnection{}},
		CreatedAt: "2026-09-09T01:00:00Z", UpdatedAt: "2026-09-09T01:00:00Z",
	}
}

func TestWorkflowRepositoryMigratesAndEnforcesOwnerRevisionAndPagination(t *testing.T) {
	useRepositoryTestDB(t, newRepositoryTestConfig(t, "workflow_repository"))
	database, err := DB()
	if err != nil {
		t.Fatal(err)
	}
	if !database.Migrator().HasTable(&model.Workflow{}) || !database.Migrator().HasTable(&model.WorkflowMediaRef{}) || !database.Migrator().HasTable(&model.WorkflowRun{}) || !database.Migrator().HasTable(&model.WorkflowOutputAttempt{}) {
		t.Fatal("DB() did not migrate workflow definition, media, and runtime tables")
	}

	for _, item := range []model.Workflow{
		repositoryWorkflow("workflow-a", "owner-a"),
		repositoryWorkflow("workflow-b", "owner-a"),
		repositoryWorkflow("workflow-a", "owner-b"),
	} {
		if _, err := CreateWorkflow(item); err != nil {
			t.Fatalf("CreateWorkflow(%s/%s): %v", item.OwnerUID, item.ID, err)
		}
	}
	items, total, err := ListWorkflows("owner-a", 1, 1)
	if err != nil || total != 2 || len(items) != 1 {
		t.Fatalf("ListWorkflows() items=%#v total=%d err=%v", items, total, err)
	}

	updatedGraph := model.WorkflowGraph{Version: 1, Nodes: []model.WorkflowNode{{ID: "text", Type: model.WorkflowNodeTextInput, Position: model.WorkflowPoint{}, Text: "updated"}}, Connections: []model.WorkflowConnection{}}
	updated, accepted, err := UpdateWorkflow("owner-a", "workflow-a", 1, "updated", updatedGraph, "2026-09-09T02:00:00Z")
	if err != nil || !accepted || updated.Revision != 2 || updated.Name != "updated" {
		t.Fatalf("UpdateWorkflow() = %#v accepted=%t err=%v", updated, accepted, err)
	}
	if _, accepted, err := UpdateWorkflow("owner-a", "workflow-a", 1, "stale", updatedGraph, "2026-09-09T03:00:00Z"); err != nil || accepted {
		t.Fatalf("stale UpdateWorkflow() accepted=%t err=%v", accepted, err)
	}
	if _, accepted, err := UpdateWorkflow("owner-b", "workflow-b", 1, "cross-owner", updatedGraph, "2026-09-09T03:00:00Z"); err != nil || accepted {
		t.Fatalf("cross-owner UpdateWorkflow() accepted=%t err=%v", accepted, err)
	}

	deleted, err := DeleteWorkflow("owner-a", "workflow-a", 1)
	if err != nil || deleted {
		t.Fatalf("stale DeleteWorkflow() deleted=%t err=%v", deleted, err)
	}
	deleted, err = DeleteWorkflow("owner-a", "workflow-a", 2)
	if err != nil || !deleted {
		t.Fatalf("DeleteWorkflow() deleted=%t err=%v", deleted, err)
	}
	if _, found, err := GetWorkflow("owner-b", "workflow-a"); err != nil || !found {
		t.Fatalf("other owner's same workflow ID found=%t err=%v", found, err)
	}
}

func TestWorkflowGraphMediaIDsAreTrimmedAndDeduplicated(t *testing.T) {
	ids := WorkflowGraphMediaIDs(model.WorkflowGraph{Nodes: []model.WorkflowNode{
		{MediaID: " media-b "}, {MediaID: "media-a"}, {MediaID: "media-b"}, {},
	}})
	if len(ids) != 2 || ids[0] != "media-a" || ids[1] != "media-b" {
		t.Fatalf("WorkflowGraphMediaIDs() = %#v", ids)
	}
}

func TestWorkflowMigrationPreservesLegacyImageTasks(t *testing.T) {
	cfg := newRepositoryTestConfig(t, "workflow_legacy_image_task")
	useRepositoryTestDB(t, cfg)
	legacy, err := gorm.Open(postgres.Open(cfg.DatabaseDSN), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	connection, err := legacy.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = connection.Close() })
	if err := legacy.Exec(`CREATE TABLE image_generation_tasks (
 id TEXT PRIMARY KEY, owner_uid TEXT, client_request_id TEXT,
 status TEXT, created_at TEXT, updated_at TEXT
 )`).Error; err != nil {
		t.Fatal(err)
	}
	if err := legacy.Exec(`INSERT INTO image_generation_tasks (id, owner_uid, client_request_id, status, created_at, updated_at)
 VALUES ('legacy-image-task', 'legacy-owner', 'legacy-request', 'running', '2026-09-08T01:00:00Z', '2026-09-08T01:00:01Z')`).Error; err != nil {
		t.Fatal(err)
	}
	if err := legacy.Exec(`CREATE TABLE video_generation_tasks (
 id TEXT PRIMARY KEY, owner_uid TEXT, client_request_id TEXT,
 status TEXT, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ
 )`).Error; err != nil {
		t.Fatal(err)
	}
	if err := legacy.Exec(`INSERT INTO video_generation_tasks (id, owner_uid, client_request_id, status, created_at, updated_at)
 VALUES ('legacy-video-task', 'legacy-owner', 'legacy-video-request', 'running', '2026-09-08T01:00:00Z', '2026-09-08T01:00:01Z')`).Error; err != nil {
		t.Fatal(err)
	}
	for _, column := range []string{"claim_id", "lease_until", "request_hash"} {
		if legacy.Migrator().HasColumn("image_generation_tasks", column) {
			t.Fatalf("legacy fixture already has %s", column)
		}
	}
	database, err := DB()
	if err != nil {
		t.Fatalf("migrate legacy image task: %v", err)
	}
	for _, column := range []string{"claim_id", "lease_until", "request_hash"} {
		if !database.Migrator().HasColumn(&model.ImageGenerationTask{}, column) {
			t.Errorf("migration omitted %s", column)
		}
	}
	var item model.ImageGenerationTask
	if err := database.First(&item, "id = ?", "legacy-image-task").Error; err != nil {
		t.Fatal(err)
	}
	if item.OwnerUID != "legacy-owner" || item.ClientRequestID != "legacy-request" || item.Status != model.ImageTaskRunning || item.ClaimID != "" || item.LeaseUntil != nil {
		t.Fatalf("legacy image task changed during migration: %#v", item)
	}
	var hashMissing bool
	if err := database.Raw("SELECT request_hash IS NULL FROM image_generation_tasks WHERE id = ?", item.ID).Scan(&hashMissing).Error; err != nil || !hashMissing {
		t.Fatalf("legacy image request hash = null %t, err=%v", hashMissing, err)
	}
	var video model.VideoGenerationTask
	if err := database.First(&video, "id = ?", "legacy-video-task").Error; err != nil {
		t.Fatal(err)
	}
	if video.OwnerUID != "legacy-owner" || video.ClientRequestID != "legacy-video-request" || video.Status != "running" || video.RequestHash != "" {
		t.Fatalf("legacy video task changed during migration: %#v", video)
	}
	if err := database.Raw("SELECT request_hash IS NULL FROM video_generation_tasks WHERE id = ?", video.ID).Scan(&hashMissing).Error; err != nil || !hashMissing {
		t.Fatalf("legacy video request hash = null %t, err=%v", hashMissing, err)
	}
}
