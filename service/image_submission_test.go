package service

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/basketikun/infinite-canvas/ai"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"testing"
	"time"
)

type submissionOutcomeProvider struct {
	result         ai.ImageTask
	err            error
	creates, polls int
}

func (p *submissionOutcomeProvider) CreateImageTask(context.Context, ai.ImageTaskRequest) (ai.ImageTask, error) {
	p.creates++
	return p.result, p.err
}
func (p *submissionOutcomeProvider) GetImageTask(context.Context, string) (ai.ImageTask, error) {
	p.polls++
	return ai.ImageTask{Status: ai.ImageTaskStatusFailed, Error: "查询确认失败"}, nil
}
func (p *submissionOutcomeProvider) SummarizeImageTaskRequest(ai.ImageTaskRequest) (ai.ImageTaskRequestSummary, error) {
	return ai.ImageTaskRequestSummary{}, nil
}

func TestImageSubmissionErrorSemantics(t *testing.T) {
	for _, tc := range []struct {
		name    string
		result  ai.ImageTask
		err     error
		status  model.ImageGenerationTaskStatus
		message string
		polls   int
	}{
		{name: "definite rejection", err: &ai.ImageSubmissionError{NotAccepted: true, Message: "请求被拒绝"}, status: model.ImageTaskFailed, message: "请求被拒绝"},
		{name: "default uncertain", err: &ai.ImageSubmissionError{Message: "unknown"}, status: model.ImageTaskUncertain},
		{name: "safe is not rejection", err: safeMessageError{message: "safe but unknown"}, status: model.ImageTaskUncertain},
		{name: "timeout", err: context.DeadlineExceeded, status: model.ImageTaskUncertain},
		{name: "connection reset", err: errors.New("reset"), status: model.ImageTaskUncertain},
		{name: "accepted contradictory error", result: ai.ImageTask{ID: "accepted", Status: ai.ImageTaskStatusRunning}, err: &ai.ImageSubmissionError{NotAccepted: true, Message: "conflicting rejection"}, status: model.ImageTaskFailed, message: "查询确认失败", polls: 1},
		{name: "terminal with id and error", result: ai.ImageTask{ID: "accepted", Status: ai.ImageTaskStatusFailed, Error: "上游终态失败"}, err: errors.New("response error"), status: model.ImageTaskFailed, message: "上游终态失败"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := &submissionOutcomeProvider{result: tc.result, err: tc.err}
			kind := newID("submission-provider")
			if err := ai.Register(ai.ProviderType{ID: kind, Name: kind, Capabilities: []ai.Capability{ai.CapabilityImageGenerate}, New: func(json.RawMessage) (ai.Provider, error) { return p, nil }}); err != nil {
				t.Fatal(err)
			}
			lease := time.Now().UTC().Add(time.Minute)
			task := model.ImageGenerationTask{ID: newID("task"), OwnerUID: newID("owner"), ClientRequestID: newID("request"), Mode: ImageTaskModeGeneration, Status: model.ImageTaskQueued, ProviderType: kind, ReferencesJSON: "[]", RequestSummary: "{}", OperationLogID: newID("op"), ClaimID: newID("claim"), LeaseUntil: &lease, CreatedAt: now(), UpdatedAt: now()}
			db, err := repository.DB()
			if err != nil {
				t.Fatal(err)
			}
			if err := db.Create(&task).Error; err != nil {
				t.Fatal(err)
			}
			op := model.OperationLog{ID: task.OperationLogID, ActorUID: task.OwnerUID, Status: model.OperationStatusSubmitted}
			if err := db.Create(&op).Error; err != nil {
				t.Fatal(err)
			}
			executeImageTask(context.Background(), task)
			saved, _, err := repository.GetImageGenerationTask(task.ID)
			if err != nil || saved.Status != tc.status || saved.ProviderTaskID != tc.result.ID || p.creates != 1 || p.polls != tc.polls || saved.ClaimID != "" || saved.LeaseUntil != nil {
				t.Fatalf("task=%+v creates=%d polls=%d err=%v", saved, p.creates, p.polls, err)
			}
			if err := db.First(&op, "id = ?", op.ID).Error; err != nil {
				t.Fatal(err)
			}
			if tc.status == model.ImageTaskFailed {
				if saved.FinishedAt == "" || saved.ErrorMessage != tc.message || op.Status != model.OperationStatusFailure || op.ErrorMessage != tc.message {
					t.Fatalf("terminal/log mismatch: %+v %+v", saved, op)
				}
			} else if saved.FinishedAt != "" || op.Status != model.OperationStatusSubmitted {
				t.Fatal("uncertain falsely finalized")
			}
			view, err := imageTaskView(context.Background(), PortalUser{UID: task.OwnerUID}, saved)
			if err != nil || view.Status != string(tc.status) || view.Error != saved.ErrorMessage || len(view.Images) != 0 {
				t.Fatalf("Canvas view=%+v err=%v", view, err)
			}
			if tc.status == model.ImageTaskFailed {
				clearWorkflowRuntimeTables(t)
				run := seedWorkflowImageRun(t, newID("submission-run"), task.OwnerUID)
				if err := reevaluateWorkflowRun(run.OwnerUID, run.ID); err != nil {
					t.Fatal(err)
				}
				attempt, found, err := repository.ClaimWorkflowAttempt(4, 2, true, time.Now().UTC(), time.Minute)
				if err != nil || !found {
					t.Fatalf("claim workflow: %v %v", found, err)
				}
				attempt.TaskID, attempt.TaskType = task.ID, "image"
				if err := applyWorkflowImageView(attempt, view); err != nil {
					t.Fatal(err)
				}
				record, found, err := repository.GetWorkflowRun(run.OwnerUID, run.ID)
				if err != nil || !found || len(record.Outputs) != 1 || record.Outputs[0].Status != "failed" || len(record.Attempts) != 1 || record.Attempts[0].Error != tc.message || record.Attempts[0].TaskID != task.ID {
					t.Fatalf("Workflow propagation: %+v %v", record, err)
				}
				clearWorkflowRuntimeTables(t)
			}
			claimed, found, err := repository.ClaimNextImageGenerationTask(time.Now().UTC(), time.Minute)
			if err != nil || (found && claimed.ID == task.ID) {
				t.Fatalf("terminal/uncertain reclaimed: %+v %v", claimed, err)
			}
		})
	}
}
