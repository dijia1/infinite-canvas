package repository

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/model"
)

func TestCreateWorkflowRunIsOwnerRequestIdempotent(t *testing.T) {
	useRepositoryTestDB(t, newRepositoryTestConfig(t, "workflow_run_idempotent"))
	current := time.Now().UTC().Truncate(time.Microsecond)
	first := model.WorkflowRun{ID: "run-first", OwnerUID: "run-owner", RequestID: "start-request", Snapshot: `{"version":1,"nodes":[],"connections":[]}`, Status: "pending", CreatedAt: current, UpdatedAt: current}
	created, inserted, err := createWorkflowRunFixture(first, nil, []model.WorkflowOutputExecution{{RunID: first.ID, NodeID: "node", SlotID: "slot", Status: "waiting", Attempt: 1, UpdatedAt: current}}, nil)
	if err != nil || !inserted || created.ID != first.ID {
		t.Fatalf("first createWorkflowRunFixture() = %#v, %v, %v", created, inserted, err)
	}
	duplicate := first
	duplicate.ID = "run-second"
	created, inserted, err = createWorkflowRunFixture(duplicate, nil, []model.WorkflowOutputExecution{{RunID: duplicate.ID, NodeID: "node", SlotID: "slot", Status: "waiting", Attempt: 1, UpdatedAt: current}}, nil)
	if err != nil || inserted || created.ID != first.ID {
		t.Fatalf("duplicate createWorkflowRunFixture() = %#v, %v, %v", created, inserted, err)
	}
	database, _ := DB()
	var count int64
	if err := database.Model(&model.WorkflowOutputExecution{}).Where("run_id IN ?", []string{first.ID, duplicate.ID}).Count(&count).Error; err != nil || count != 1 {
		t.Fatalf("output count = %d, %v", count, err)
	}
}

func TestClaimWorkflowAttemptAtomicallyEnforcesGlobalAndRunCapacity(t *testing.T) {
	useRepositoryTestDB(t, newRepositoryTestConfig(t, "workflow_run_capacity"))
	current := time.Now().UTC().Truncate(time.Microsecond)
	for runIndex := 1; runIndex <= 2; runIndex++ {
		runID := fmt.Sprintf("capacity-run-%d", runIndex)
		run := model.WorkflowRun{ID: runID, OwnerUID: "capacity-owner", RequestID: fmt.Sprintf("request-%d", runIndex), Snapshot: `{}`, Status: "running", CreatedAt: current, UpdatedAt: current}
		outputs := []model.WorkflowOutputExecution{}
		for slotIndex := 1; slotIndex <= 2; slotIndex++ {
			outputs = append(outputs, model.WorkflowOutputExecution{RunID: runID, NodeID: "node", SlotID: fmt.Sprintf("slot-%d", slotIndex), Status: "ready", Attempt: 1, UpdatedAt: current})
		}
		if _, _, err := createWorkflowRunFixture(run, nil, outputs, nil); err != nil {
			t.Fatal(err)
		}
	}
	first, found, err := ClaimWorkflowAttempt(2, 1, true, current, time.Minute)
	if err != nil || !found {
		t.Fatalf("first claim = %#v, %v, %v", first, found, err)
	}
	if first.QueuedAt == nil || first.StartedAt != nil || !first.QueuedAt.Equal(current) {
		t.Fatalf("first claim timing = queued %v started %v", first.QueuedAt, first.StartedAt)
	}
	authorized, err := AuthorizeWorkflowAttemptSubmission(first, true, current.Add(time.Millisecond))
	if err != nil || !authorized {
		t.Fatalf("authorize first claim = %v, %v", authorized, err)
	}
	database, _ := DB()
	var started model.WorkflowOutputAttempt
	if err := database.First(&started, "id = ?", first.ID).Error; err != nil || started.StartedAt == nil || !started.StartedAt.Equal(current.Add(time.Millisecond)) {
		t.Fatalf("authorized claim timing = %v, %v", started.StartedAt, err)
	}
	second, found, err := ClaimWorkflowAttempt(2, 1, true, current, time.Minute)
	if err != nil || !found || second.RunID == first.RunID {
		t.Fatalf("second claim = %#v, %v, %v", second, found, err)
	}
	if third, found, err := ClaimWorkflowAttempt(2, 1, true, current, time.Minute); err != nil || found {
		t.Fatalf("third claim exceeded capacity = %#v, %v, %v", third, found, err)
	}
}

func TestWorkflowAttemptLeaseFencesAnExpiredWorker(t *testing.T) {
	useRepositoryTestDB(t, newRepositoryTestConfig(t, "workflow_attempt_fence"))
	current := time.Now().UTC()
	run := model.WorkflowRun{ID: "fence-run", OwnerUID: "fence-owner", RequestID: "fence-request", Snapshot: `{}`, Status: "running", CreatedAt: current, UpdatedAt: current}
	output := model.WorkflowOutputExecution{RunID: run.ID, NodeID: "node", SlotID: "slot", Status: "ready", Attempt: 1, UpdatedAt: current}
	if _, _, err := createWorkflowRunFixture(run, nil, []model.WorkflowOutputExecution{output}, nil); err != nil {
		t.Fatal(err)
	}
	oldClaim, found, err := ClaimWorkflowAttempt(4, 2, true, current, time.Millisecond)
	if err != nil || !found {
		t.Fatalf("old claim = %#v, %v, %v", oldClaim, found, err)
	}
	newClaim, found, err := ClaimWorkflowAttempt(4, 2, true, current.Add(2*time.Millisecond), time.Minute)
	if err != nil || !found || newClaim.ID != oldClaim.ID || newClaim.ClaimID == oldClaim.ClaimID {
		t.Fatalf("new claim = %#v, %v, %v", newClaim, found, err)
	}
	oldClaim.Status = "failed"
	if err := UpdateClaimedWorkflowAttempt(oldClaim, "failed", current, true); !errors.Is(err, ErrWorkflowLeaseLost) {
		t.Fatalf("expired worker write error = %v, want ErrWorkflowLeaseLost", err)
	}
	newClaim.Status = "running"
	if err := UpdateClaimedWorkflowAttempt(newClaim, "running", current.Add(time.Second), false); err != nil {
		t.Fatalf("current worker write: %v", err)
	}
}

func TestWorkflowAttemptRequestIDIsStableAndBounded(t *testing.T) {
	long := string(make([]byte, 128))
	first := workflowAttemptRequestID(long, long, long, 9)
	if first != workflowAttemptRequestID(long, long, long, 9) || len(first) > 128 || first == workflowAttemptRequestID(long, long, long, 8) {
		t.Fatalf("request ID is not stable and bounded: %q", first)
	}
}

func TestWorkflowEvaluationRejectsAConcurrentStopSnapshot(t *testing.T) {
	useRepositoryTestDB(t, newRepositoryTestConfig(t, "workflow_evaluation_stale"))
	current := time.Now().UTC()
	run := model.WorkflowRun{ID: "stale-run", OwnerUID: "stale-owner", RequestID: "stale-request", Snapshot: `{}`, Status: "running", CreatedAt: current, UpdatedAt: current}
	output := model.WorkflowOutputExecution{RunID: run.ID, NodeID: "node", SlotID: "slot", Status: "waiting", Attempt: 1, UpdatedAt: current}
	if _, _, err := createWorkflowRunFixture(run, nil, []model.WorkflowOutputExecution{output}, nil); err != nil {
		t.Fatal(err)
	}
	record, found, err := GetWorkflowRun(run.OwnerUID, run.ID)
	if err != nil || !found {
		t.Fatal(err)
	}
	if changed, err := RequestWorkflowRunStop(run.OwnerUID, run.ID, current.Add(time.Second)); err != nil || !changed {
		t.Fatalf("RequestWorkflowRunStop() = %v, %v", changed, err)
	}
	err = UpdateWorkflowEvaluation(run.ID, record.Run.StateVersion, []model.WorkflowOutputExecution{{RunID: run.ID, NodeID: "node", SlotID: "slot", Status: "ready"}}, nil, "running", nil, current)
	if !errors.Is(err, ErrWorkflowRunStale) {
		t.Fatalf("stale evaluation error = %v", err)
	}
	updated, _, _ := GetWorkflowRun(run.OwnerUID, run.ID)
	if !updated.Run.StopRequested || updated.Run.Status != "stopping" || updated.Outputs[0].Status != "waiting" {
		t.Fatalf("stale evaluation overwrote stop: %#v", updated)
	}
}

func TestRetryWorkflowOutputIsIdempotentPerClientRequest(t *testing.T) {
	useRepositoryTestDB(t, newRepositoryTestConfig(t, "workflow_retry_idempotent"))
	current := time.Now().UTC()
	seedAdmissionWorkflow(t, "retry-owner", "retry-workflow")
	run := model.WorkflowRun{ID: "retry-run", OwnerUID: "retry-owner", RequestID: "run-request", WorkflowID: "retry-workflow", Revision: 1, Snapshot: `{}`, Status: "failed", StateVersion: 1, CreatedAt: current, UpdatedAt: current}
	output := model.WorkflowOutputExecution{RunID: run.ID, NodeID: "node", SlotID: "slot", Status: "failed", Attempt: 1, Error: "first failure", UpdatedAt: current}
	if _, _, err := createWorkflowRunFixture(run, nil, []model.WorkflowOutputExecution{output}, nil); err != nil {
		t.Fatal(err)
	}
	first, err := RetryWorkflowOutput(run.OwnerUID, run.ID, output.NodeID, output.SlotID, "retry-request-one", current.Add(time.Second))
	if err != nil || first.Attempt != 2 || first.Status != "waiting" {
		t.Fatalf("first retry = %#v, %v", first, err)
	}
	database, _ := DB()
	if err := database.Model(&model.WorkflowOutputExecution{}).Where("run_id = ? AND node_id = ? AND slot_id = ?", run.ID, output.NodeID, output.SlotID).Updates(map[string]any{"status": "failed", "error": "second failure"}).Error; err != nil {
		t.Fatal(err)
	}
	if err := database.Create(&model.WorkflowOutputAttempt{ID: "retry-attempt-one", RunID: run.ID, NodeID: output.NodeID, SlotID: output.SlotID, Attempt: 2, OwnerUID: run.OwnerUID, RequestID: "retry-attempt-request-one", RetryRequestID: "retry-request-one", Status: "failed", CreatedAt: current, UpdatedAt: current}).Error; err != nil {
		t.Fatal(err)
	}
	duplicate, err := RetryWorkflowOutput(run.OwnerUID, run.ID, output.NodeID, output.SlotID, "retry-request-one", current.Add(2*time.Second))
	if err != nil || duplicate.Attempt != 2 || duplicate.Status != "failed" {
		t.Fatalf("duplicate retry = %#v, %v", duplicate, err)
	}
	second, err := RetryWorkflowOutput(run.OwnerUID, run.ID, output.NodeID, output.SlotID, "retry-request-two", current.Add(3*time.Second))
	if err != nil || second.Attempt != 3 || second.Status != "waiting" {
		t.Fatalf("second logical retry = %#v, %v", second, err)
	}
	if err := database.Model(&model.WorkflowOutputExecution{}).Where("run_id = ? AND node_id = ? AND slot_id = ?", run.ID, output.NodeID, output.SlotID).Updates(map[string]any{"status": "failed", "error": "third failure"}).Error; err != nil {
		t.Fatal(err)
	}
	lateFirst, err := RetryWorkflowOutput(run.OwnerUID, run.ID, output.NodeID, output.SlotID, "retry-request-one", current.Add(4*time.Second))
	if err != nil || lateFirst.Attempt != 3 || lateFirst.Status != "failed" {
		t.Fatalf("late first retry replay = %#v, %v", lateFirst, err)
	}
}
