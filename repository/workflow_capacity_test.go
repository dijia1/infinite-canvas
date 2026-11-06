package repository

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/model"
)

func TestUncertainWorkflowTasksReleaseGlobalCapacityAndReserveItOnResume(t *testing.T) {
	useRepositoryTestDB(t, newRepositoryTestConfig(t, "workflow_uncertain_capacity"))
	db, _ := DB()
	current := time.Now().UTC().Truncate(time.Microsecond)
	for i := 0; i < 5; i++ {
		id := fmt.Sprintf("run-%d", i)
		status, runStatus := "uncertain", "attention_required"
		if i == 4 {
			status, runStatus = "ready", "running"
		}
		run := model.WorkflowRun{ID: id, OwnerUID: id + "-owner", RequestID: id + "-request", Snapshot: "{}", Status: runStatus, StateVersion: 1, CreatedAt: current, UpdatedAt: current}
		output := model.WorkflowOutputExecution{RunID: id, NodeID: "node", SlotID: "out", Attempt: 1, Status: status, UpdatedAt: current}
		if _, _, err := createWorkflowRunFixture(run, nil, []model.WorkflowOutputExecution{output}, nil); err != nil {
			t.Fatal(err)
		}
		if i < 4 {
			attempt := model.WorkflowOutputAttempt{ID: id + "-attempt", RunID: id, OwnerUID: run.OwnerUID, NodeID: "node", SlotID: "out", Attempt: 1, RequestID: id + "-task-request", TaskType: "image", TaskID: id + "-task", Status: "uncertain", NextPollAt: current.Add(time.Hour), CreatedAt: current, UpdatedAt: current}
			if err := db.Create(&attempt).Error; err != nil {
				t.Fatal(err)
			}
		}
	}
	attempt, found, err := ClaimWorkflowAttempt(4, 2, true, current, time.Minute)
	if err != nil || !found || attempt.RunID != "run-4" {
		t.Fatalf("independent run blocked: %+v found=%v err=%v", attempt, found, err)
	}
	if err := DeleteWorkflowRun("run-0-owner", "run-0"); !errors.Is(err, ErrWorkflowRunActive) {
		t.Fatalf("uncertain run lost protection: %v", err)
	}
	if err := db.Create(&model.WorkflowOutputExecution{RunID: "run-0", NodeID: "node", SlotID: "second", Attempt: 1, Status: "ready", UpdatedAt: current}).Error; err != nil {
		t.Fatal(err)
	}
	if _, found, err := ClaimWorkflowAttempt(4, 1, true, current, time.Minute); err != nil || found {
		t.Fatalf("uncertain attempt lost per-run capacity protection: found=%v err=%v", found, err)
	}
	task := model.ImageGenerationTask{ID: "run-0-task", OwnerUID: "run-0-owner", ClientRequestID: "original-request", Status: model.ImageTaskPaused, ProviderTaskID: "original-upstream", PollFailures: 5}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.WorkflowOutputAttempt{}).Where("id IN ?", []string{"run-1-attempt", "run-2-attempt", "run-3-attempt"}).Update("status", "running").Error; err != nil {
		t.Fatal(err)
	}
	if err := ResumeImageGenerationTask(task.ID, task.OwnerUID, current, time.Hour, 4); !errors.Is(err, ErrWorkflowCapacity) {
		t.Fatalf("resume exceeded capacity: %v", err)
	}
	stored, _, _ := GetImageGenerationTask(task.ID)
	if stored.Status != model.ImageTaskPaused || stored.PollFailures != 5 {
		t.Fatalf("rejected resume mutated task: %+v", stored)
	}
	if err := db.Model(&model.WorkflowOutputAttempt{}).Where("id = ?", "run-3-attempt").Update("status", "failed").Error; err != nil {
		t.Fatal(err)
	}
	if err := ResumeImageGenerationTask(task.ID, task.OwnerUID, current, time.Hour, 4); err != nil {
		t.Fatal(err)
	}
	var resumed model.WorkflowOutputAttempt
	if err := db.First(&resumed, "id = ?", "run-0-attempt").Error; err != nil || resumed.Status != "running" || resumed.RequestID != "run-0-task-request" || resumed.TaskID != task.ID {
		t.Fatalf("resumed attempt=%+v err=%v", resumed, err)
	}
	if err := ResumeImageGenerationTask(task.ID, task.OwnerUID, current, time.Hour, 4); err == nil {
		t.Fatal("duplicate resume accepted")
	}
	stored, _, _ = GetImageGenerationTask(task.ID)
	if stored.Status != model.ImageTaskRunning || stored.ProviderTaskID != "original-upstream" || stored.PollFailures != 0 {
		t.Fatalf("resumed task=%+v", stored)
	}
}
