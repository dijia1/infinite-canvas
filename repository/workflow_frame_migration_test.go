package repository

import (
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/model"
)

func TestWorkflowFrameMigrationIsRepeatableAndPreservesHistoricalSnapshot(t *testing.T) {
	useRepositoryTestDB(t, newRepositoryTestConfig(t, "workflow_frame_migration"))
	database, _ := DB()
	if err := database.Exec(`ALTER TABLE workflow_runs DROP CONSTRAINT IF EXISTS workflow_runs_scope_fields_check`).Error; err != nil {
		t.Fatal(err)
	}
	snapshot := `{"version":1,"nodes":[{"id":"legacy"}],"connections":[]}`
	now := time.Now().UTC()
	runs := []model.WorkflowRun{
		{ID: "legacy-run", OwnerUID: "legacy-owner", RequestID: "legacy-request", WorkflowID: "legacy-workflow", Revision: 1, Title: "Legacy", Snapshot: snapshot, Status: "completed", CreatedAt: now, UpdatedAt: now},
		{ID: "corrupt-run", OwnerUID: "legacy-owner", RequestID: "corrupt-request", WorkflowID: "legacy-workflow", Revision: 1, ScopeType: "garbage", FrameID: "stray", FrameName: "stray", Snapshot: snapshot, Status: "completed", CreatedAt: now, UpdatedAt: now},
		{ID: "bad-frame-run", OwnerUID: "legacy-owner", RequestID: "bad-frame-request", WorkflowID: "legacy-workflow", Revision: 1, ScopeType: model.WorkflowRunScopeFrame, FrameID: "", FrameName: "", Snapshot: snapshot, Status: "completed", CreatedAt: now, UpdatedAt: now},
		{ID: "valid-frame-run", OwnerUID: "legacy-owner", RequestID: "valid-frame-request", WorkflowID: "legacy-workflow", Revision: 1, ScopeType: model.WorkflowRunScopeFrame, FrameID: "frame-a", FrameName: "A", Snapshot: snapshot, Status: "completed", CreatedAt: now, UpdatedAt: now},
	}
	if err := database.Omit("scope_type", "frame_id", "frame_name").Create(&runs[0]).Error; err != nil {
		t.Fatal(err)
	}
	if err := database.Create(runs[1:]).Error; err != nil {
		t.Fatal(err)
	}
	if err := migrateWorkflowFrameSchema(database); err != nil {
		t.Fatal(err)
	}
	if err := migrateWorkflowFrameSchema(database); err != nil {
		t.Fatal(err)
	}
	var stored model.WorkflowRun
	if err := database.First(&stored, "id = ?", runs[0].ID).Error; err != nil {
		t.Fatal(err)
	}
	if stored.ScopeType != model.WorkflowRunScopeWorkflow || stored.FrameID != "" || stored.FrameName != "" || stored.Snapshot != snapshot {
		t.Fatalf("migrated run = %#v", stored)
	}
	for _, id := range []string{"corrupt-run", "bad-frame-run"} {
		stored = model.WorkflowRun{}
		if err := database.First(&stored, "id = ?", id).Error; err != nil {
			t.Fatal(err)
		}
		if stored.ScopeType != model.WorkflowRunScopeWorkflow || stored.FrameID != "" || stored.FrameName != "" || stored.Snapshot != snapshot {
			t.Fatalf("normalized corrupt run = %#v", stored)
		}
	}
	stored = model.WorkflowRun{}
	if err := database.First(&stored, "id = ?", "valid-frame-run").Error; err != nil {
		t.Fatal(err)
	}
	if stored.ScopeType != model.WorkflowRunScopeFrame || stored.FrameID != "frame-a" || stored.FrameName != "A" || stored.Snapshot != snapshot {
		t.Fatalf("valid frame changed = %#v", stored)
	}
	var indexes int64
	if err := database.Raw(`SELECT COUNT(*) FROM pg_indexes WHERE schemaname = current_schema() AND indexname IN ('idx_workflow_runs_scope_latest','idx_workflow_runs_active')`).Scan(&indexes).Error; err != nil || indexes != 2 {
		t.Fatalf("indexes=%d err=%v", indexes, err)
	}
	var constraints int64
	if err := database.Raw(`SELECT COUNT(*) FROM pg_constraint WHERE conrelid = 'workflow_runs'::regclass AND conname = 'workflow_runs_scope_fields_check'`).Scan(&constraints).Error; err != nil || constraints != 1 {
		t.Fatalf("constraints=%d err=%v", constraints, err)
	}
}
