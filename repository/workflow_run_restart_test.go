package repository

import (
	"errors"
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/model"
)

func TestRestartStoppedUncertainWorkflowUsesNewSnapshotAndKeepsHistory(t *testing.T) {
	for _, kind := range []string{"image", "video"} {
		t.Run(kind, func(t *testing.T) {
			useRepositoryTestDB(t, newRepositoryTestConfig(t, "workflow_restart_"+kind))
			db, _ := DB()
			current := time.Now().UTC()
			seedAdmissionWorkflow(t, "owner", "workflow")
			old, steps := admissionFixture("old-run", "old-request", "owner", "workflow", "frame-a", "a")
			old.Status, old.StopRequested, old.Revision = "attention_required", true, 0
			outputs := []model.WorkflowOutputExecution{{RunID: old.ID, NodeID: "a", SlotID: "failed", Status: "uncertain", Attempt: 1}, {RunID: old.ID, NodeID: "a", SlotID: "success", Status: "succeeded", Attempt: 1, MediaID: "keep-media"}, {RunID: old.ID, NodeID: "b", SlotID: "waiting", Status: "stopped", Attempt: 1}}
			if _, _, err := createWorkflowRunFixture(old, steps, outputs, nil); err != nil {
				t.Fatal(err)
			}
			attempt := model.WorkflowOutputAttempt{ID: "old-attempt", OwnerUID: "owner", RunID: old.ID, NodeID: "a", SlotID: "failed", Attempt: 1, RequestID: "old-task-request", TaskType: kind, TaskID: "old-task", Status: "uncertain", CreatedAt: current, UpdatedAt: current}
			if err := db.Create(&attempt).Error; err != nil {
				t.Fatal(err)
			}
			table := "image_generation_tasks"
			if kind == "image" {
				if err := db.Create(&model.ImageGenerationTask{ID: "old-task", OwnerUID: "owner", ClientRequestID: attempt.RequestID, Status: model.ImageTaskUncertain, ProviderConfig: "secret"}).Error; err != nil {
					t.Fatal(err)
				}
			} else {
				table = "video_generation_tasks"
				if err := db.Create(&model.VideoGenerationTask{ID: "old-task", OwnerUID: "owner", ClientRequestID: attempt.RequestID, Status: "paused", ProviderConfig: "secret"}).Error; err != nil {
					t.Fatal(err)
				}
			}
			candidate, newSteps := admissionFixture("new-run", "new-request", "owner", "workflow", "frame-a", "a")
			candidate.CreatedAt = current.Add(time.Second)
			candidate.Snapshot = `{"version":1,"currentConfig":true}`
			newOutputs := []model.WorkflowOutputExecution{{RunID: candidate.ID, NodeID: "a", SlotID: "failed", Status: "waiting", Attempt: 1}}
			restart := &WorkflowRunRestart{RunID: old.ID, Audit: model.OperationLog{ID: "restart-audit", ActorUID: "owner", Action: "workflow_run_restart", CreatedAt: current}}
			if _, _, err := AdmitWorkflowRun(candidate, newSteps, newOutputs, nil, 1, restart); !errors.Is(err, ErrWorkflowRunRestartConfirmation) {
				t.Fatalf("missing consent: %v", err)
			}
			restart.ConfirmUncertain = true
			seedAdmissionWorkflow(t, "other-owner", "workflow")
			otherOwner := candidate
			otherOwner.OwnerUID = "other-owner"
			if _, _, err := AdmitWorkflowRun(otherOwner, newSteps, newOutputs, nil, 1, restart); !errors.Is(err, ErrWorkflowRunNotFound) {
				t.Fatal("replaced another owner run")
			}
			wrongScope := candidate
			wrongScope.FrameID = "other-frame"
			if _, _, err := AdmitWorkflowRun(wrongScope, newSteps, newOutputs, nil, 1, restart); !errors.Is(err, ErrWorkflowRunRestartUnavailable) {
				t.Fatalf("scope mismatch: %v", err)
			}
			if err := db.Model(&attempt).Update("status", "running").Error; err != nil {
				t.Fatal(err)
			}
			if _, _, err := AdmitWorkflowRun(candidate, newSteps, newOutputs, nil, 1, restart); !errors.Is(err, ErrWorkflowRunRestartUnavailable) {
				t.Fatalf("running task replaced: %v", err)
			}
			if err := db.Model(&attempt).Update("status", "uncertain").Error; err != nil {
				t.Fatal(err)
			}
			if err := db.Create(&restart.Audit).Error; err != nil {
				t.Fatal(err)
			}
			if _, _, err := AdmitWorkflowRun(candidate, newSteps, newOutputs, nil, 1, restart); err == nil {
				t.Fatal("audit failure was ignored")
			}
			var state struct{ Status, ProviderConfig string }
			db.Table(table).Where("id = ?", "old-task").Take(&state)
			if state.Status == "failed" || state.ProviderConfig != "secret" {
				t.Fatalf("closure survived rollback: %+v", state)
			}
			db.Delete(&model.OperationLog{}, "id = ?", restart.Audit.ID)
			saved, inserted, err := AdmitWorkflowRun(candidate, newSteps, newOutputs, nil, 1, restart)
			if err != nil || !inserted || saved.Snapshot != candidate.Snapshot {
				t.Fatalf("new run=%+v inserted=%v err=%v", saved, inserted, err)
			}
			record, _, err := GetWorkflowRun("owner", old.ID)
			if err != nil || record.Run.Status != "stopped" || record.Outputs[1].MediaID != "keep-media" {
				t.Fatalf("old history=%+v err=%v", record, err)
			}
			db.Table(table).Where("id = ?", "old-task").Take(&state)
			if state.Status != "failed" || state.ProviderConfig != "" {
				t.Fatalf("old task=%+v", state)
			}
			candidate.ID = "duplicate"
			replay, inserted, err := AdmitWorkflowRun(candidate, newSteps, newOutputs, nil, 1, restart)
			if err != nil || inserted || replay.ID != saved.ID {
				t.Fatalf("replay=%+v inserted=%v err=%v", replay, inserted, err)
			}
			var count int64
			db.Model(&model.WorkflowRun{}).Where("request_id = ?", "new-request").Count(&count)
			if count != 1 {
				t.Fatalf("duplicate replacements: %d", count)
			}
		})
	}
}
