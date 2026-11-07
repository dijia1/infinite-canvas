package repository

import (
	"errors"
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/model"
)

func TestWorkflowOwnerCanConfirmUncertainRetryAtomically(t *testing.T) {
	for _, kind := range []string{"image", "video"} {
		t.Run(kind, func(t *testing.T) {
			useRepositoryTestDB(t, newRepositoryTestConfig(t, "workflow_retry_confirmation_"+kind))
			db, _ := DB()
			current := time.Now().UTC().Truncate(time.Microsecond)
			seedAdmissionWorkflow(t, "owner", "workflow")
			run := model.WorkflowRun{ID: "run", OwnerUID: "owner", RequestID: "start", WorkflowID: "workflow", Snapshot: `{}`, Status: "attention_required", StateVersion: 1, CreatedAt: current, UpdatedAt: current}
			output := model.WorkflowOutputExecution{RunID: run.ID, NodeID: "node", SlotID: "slot", Status: "uncertain", Attempt: 1, UpdatedAt: current}
			sibling := model.WorkflowOutputExecution{RunID: run.ID, NodeID: "node", SlotID: "success", Status: "succeeded", Attempt: 1, MediaID: "saved-result", UpdatedAt: current}
			if _, _, err := createWorkflowRunFixture(run, nil, []model.WorkflowOutputExecution{output, sibling}, nil); err != nil {
				t.Fatal(err)
			}
			attempt := model.WorkflowOutputAttempt{ID: "attempt", RunID: run.ID, OwnerUID: run.OwnerUID, NodeID: "node", SlotID: "slot", Attempt: 1, RequestID: "task-request", TaskType: kind, TaskID: "task", Status: "uncertain", CreatedAt: current, UpdatedAt: current}
			if err := db.Create(&attempt).Error; err != nil {
				t.Fatal(err)
			}
			table := "image_generation_tasks"
			if kind == "image" {
				if err := db.Create(&model.ImageGenerationTask{ID: "task", OwnerUID: run.OwnerUID, ClientRequestID: attempt.RequestID, Status: model.ImageTaskUncertain, ProviderTaskID: "upstream", OperationLogID: "original", ProviderConfig: "old-config"}).Error; err != nil {
					t.Fatal(err)
				}
			} else {
				table = "video_generation_tasks"
				if err := db.Create(&model.VideoGenerationTask{ID: "task", OwnerUID: run.OwnerUID, ClientRequestID: attempt.RequestID, Status: "paused", ProviderTaskID: "upstream", OperationLogID: "original", ProviderConfig: "old-config", ResultURLsJSON: "[]"}).Error; err != nil {
					t.Fatal(err)
				}
			}
			if err := db.Create(&model.OperationLog{ID: "original", Status: model.OperationStatusSubmitted}).Error; err != nil {
				t.Fatal(err)
			}
			confirmation := model.OperationLog{ID: "confirmation", ActorUID: run.OwnerUID, Action: "workflow_output_retry", TargetID: run.ID, Status: model.OperationStatusSuccess, CreatedAt: current}
			retry := func(owner string, audit *model.OperationLog) (WorkflowOutputRetryResult, error) {
				return RetryWorkflowOutput(owner, run.ID, "node", "slot", "retry-request", audit, current)
			}
			if _, err := retry(run.OwnerUID, nil); !errors.Is(err, ErrWorkflowRunActive) {
				t.Fatalf("unconfirmed retry: %v", err)
			}
			if _, err := retry("other-owner", &confirmation); !errors.Is(err, ErrWorkflowRunNotFound) {
				t.Fatalf("cross-owner retry: %v", err)
			}
			if err := db.Table(table).Where("id = 'task'").Update("owner_uid", "other-owner").Error; err != nil {
				t.Fatal(err)
			}
			if _, err := retry(run.OwnerUID, &confirmation); err == nil {
				t.Fatal("closed another owner's task")
			}
			if err := db.Table(table).Where("id = 'task'").Updates(map[string]any{"owner_uid": run.OwnerUID, "status": "running"}).Error; err != nil {
				t.Fatal(err)
			}
			if _, err := retry(run.OwnerUID, &confirmation); !errors.Is(err, ErrGenerationTaskResolutionConflict) {
				t.Fatalf("running task retry: %v", err)
			}
			if err := db.Table(table).Where("id = 'task'").Update("status", "uncertain").Error; err != nil {
				t.Fatal(err)
			}
			conflictingAudit := confirmation
			conflictingAudit.ID = "original"
			if _, err := retry(run.OwnerUID, &conflictingAudit); err == nil {
				t.Fatal("audit failure did not abort")
			}
			var before struct{ Status, ProviderConfig string }
			if err := db.Table(table).Where("id = 'task'").Take(&before).Error; err != nil || before.Status != "uncertain" || before.ProviderConfig != "old-config" {
				t.Fatalf("audit failure changed task: %+v %v", before, err)
			}
			var oldAttempt model.WorkflowOutputAttempt
			if err := db.First(&oldAttempt, "id = ?", attempt.ID).Error; err != nil || oldAttempt.Status != "uncertain" {
				t.Fatalf("audit failure changed attempt: %+v %v", oldAttempt, err)
			}
			// Cover a paused task whose create response did not link its local ID.
			if kind == "video" {
				if err := db.Model(&attempt).Update("task_id", "").Error; err != nil {
					t.Fatal(err)
				}
				if err := db.Table(table).Where("id = 'task'").Update("status", "paused").Error; err != nil {
					t.Fatal(err)
				}
			}
			first, err := retry(run.OwnerUID, &confirmation)
			if err != nil || first.Output.Attempt != 2 || first.Output.Status != "waiting" {
				t.Fatalf("retry: %+v %v", first, err)
			}
			if kind == "image" && first.ClosedImageTaskID != "task" {
				t.Fatalf("cleanup task id: %q", first.ClosedImageTaskID)
			}
			duplicate, err := retry(run.OwnerUID, &confirmation)
			if err != nil || duplicate.Output.Attempt != 2 || duplicate.ClosedImageTaskID != "" {
				t.Fatalf("duplicate retry: %+v %v", duplicate, err)
			}
			var closed struct{ Status, ProviderConfig, ProviderTaskID string }
			if err := db.Table(table).Where("id = 'task'").Take(&closed).Error; err != nil || closed.Status != "failed" || closed.ProviderConfig != "" || closed.ProviderTaskID != "upstream" {
				t.Fatalf("task not closed: %+v %v", closed, err)
			}
			if err := db.First(&oldAttempt, "id = ?", attempt.ID).Error; err != nil || oldAttempt.Status != "failed" || oldAttempt.FinishedAt == nil || oldAttempt.TaskID != "task" {
				t.Fatalf("old attempt: %+v %v", oldAttempt, err)
			}
			record, _, err := GetWorkflowRun(run.OwnerUID, run.ID)
			if err != nil || record.Run.Status != "running" {
				t.Fatalf("run not restarted: %+v %v", record, err)
			}
			for _, result := range record.Outputs {
				if result.SlotID == sibling.SlotID && (result.MediaID != sibling.MediaID || result.Status != "succeeded" || result.Attempt != 1) {
					t.Fatalf("successful sibling changed: %+v", result)
				}
			}
			var audit model.OperationLog
			if err := db.First(&audit, "id = ?", confirmation.ID).Error; err != nil || audit.ActorUID != run.OwnerUID || audit.ProviderTaskID != "upstream" {
				t.Fatalf("confirmation audit: %+v %v", audit, err)
			}
			// A released per-run slot can now claim the replacement attempt.
			if err := db.Model(&output).Update("status", "ready").Error; err != nil {
				t.Fatal(err)
			}
			replacement, found, err := ClaimWorkflowAttempt(1, 1, true, current.Add(time.Second), time.Minute)
			if err != nil || !found || replacement.Attempt != 2 || replacement.RequestID == attempt.RequestID {
				t.Fatalf("replacement claim: %+v %v %v", replacement, found, err)
			}
		})
	}
}

func TestWorkflowOwnerCanRetryUncertainAttemptWithoutLocalTask(t *testing.T) {
	useRepositoryTestDB(t, newRepositoryTestConfig(t, "workflow_retry_without_task"))
	db, _ := DB()
	current := time.Now().UTC()
	seedAdmissionWorkflow(t, "owner", "workflow")
	run := model.WorkflowRun{ID: "run", OwnerUID: "owner", RequestID: "start", WorkflowID: "workflow", Snapshot: `{}`, Status: "attention_required", CreatedAt: current, UpdatedAt: current}
	output := model.WorkflowOutputExecution{RunID: run.ID, NodeID: "node", SlotID: "slot", Status: "uncertain", Attempt: 1, UpdatedAt: current}
	if _, _, err := createWorkflowRunFixture(run, nil, []model.WorkflowOutputExecution{output}, nil); err != nil {
		t.Fatal(err)
	}
	attempt := model.WorkflowOutputAttempt{ID: "attempt", RunID: run.ID, OwnerUID: run.OwnerUID, NodeID: output.NodeID, SlotID: output.SlotID, Attempt: 1, RequestID: "missing-task", TaskType: "image", Status: "uncertain", CreatedAt: current, UpdatedAt: current}
	if err := db.Create(&attempt).Error; err != nil {
		t.Fatal(err)
	}
	audit := model.OperationLog{ID: "confirmation", ActorUID: run.OwnerUID, Action: "workflow_output_retry", CreatedAt: current}
	if _, err := RetryWorkflowOutput(run.OwnerUID, run.ID, output.NodeID, output.SlotID, "retry", &audit, current); err != nil {
		t.Fatal(err)
	}
	var stored model.WorkflowOutputAttempt
	if err := db.First(&stored, "id = ?", attempt.ID).Error; err != nil || stored.Status != "failed" {
		t.Fatalf("old attempt: %+v %v", stored, err)
	}
}
