package repository

import (
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/model"
)

func seedAdmissionWorkflow(t *testing.T, owner, workflowID string) {
	t.Helper()
	database, _ := DB()
	graph := model.WorkflowGraph{Version: 1, Nodes: []model.WorkflowNode{{ID: "a", Type: model.WorkflowNodeImageGeneration}, {ID: "b", Type: model.WorkflowNodeImageGeneration}}, Connections: []model.WorkflowConnection{}}
	if err := database.Create(&model.Workflow{ID: workflowID, OwnerUID: owner, Name: "Flow", Graph: graph, Revision: 1, CreatedAt: time.Now().UTC().Format(time.RFC3339Nano), UpdatedAt: time.Now().UTC().Format(time.RFC3339Nano)}).Error; err != nil {
		t.Fatal(err)
	}
}

func admissionFixture(id, requestID, owner, workflowID, frameID, nodeID string) (model.WorkflowRun, []model.WorkflowStepExecution) {
	now := time.Now().UTC()
	run := model.WorkflowRun{ID: id, OwnerUID: owner, RequestID: requestID, WorkflowID: workflowID, Revision: 1, Title: "Flow", ScopeType: model.WorkflowRunScopeFrame, FrameID: frameID, FrameName: frameID, Snapshot: `{}`, Status: "pending", StateVersion: 1, CreatedAt: now, UpdatedAt: now}
	return run, []model.WorkflowStepExecution{{RunID: id, NodeID: nodeID, Status: "waiting"}}
}

func TestAdmitWorkflowRunSerializesSameFrameAndAllowsDisjointFrames(t *testing.T) {
	useRepositoryTestDB(t, newRepositoryTestConfig(t, "workflow_run_scope"))
	owner, workflowID := "scope-owner", "scope-workflow"
	seedAdmissionWorkflow(t, owner, workflowID)
	start := make(chan struct{})
	results := make(chan error, 2)
	var wait sync.WaitGroup
	for i := 0; i < 2; i++ {
		run, steps := admissionFixture("same-run-"+string(rune('a'+i)), "same-request-"+string(rune('a'+i)), owner, workflowID, "frame-a", "a")
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			_, _, err := AdmitWorkflowRun(run, steps, nil, nil, 1)
			results <- err
		}()
	}
	close(start)
	wait.Wait()
	close(results)
	successes, conflicts := 0, 0
	for err := range results {
		if err == nil {
			successes++
			continue
		}
		var conflict *WorkflowRunAdmissionConflict
		if errors.As(err, &conflict) && conflict.Code == "workflow_run_scope_active" {
			conflicts++
			continue
		}
		t.Fatalf("unexpected admission error: %v", err)
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("successes=%d conflicts=%d", successes, conflicts)
	}

	run, steps := admissionFixture("disjoint-run", "disjoint-request", owner, workflowID, "frame-b", "b")
	if _, inserted, err := AdmitWorkflowRun(run, steps, nil, nil, 1); err != nil || !inserted {
		t.Fatalf("disjoint frame admission inserted=%t err=%v", inserted, err)
	}
}

func TestAdmitWorkflowRunChecksScopeMatrixBeforeNodeOverlap(t *testing.T) {
	useRepositoryTestDB(t, newRepositoryTestConfig(t, "workflow_run_matrix"))
	owner, workflowID := "matrix-owner", "matrix-workflow"
	seedAdmissionWorkflow(t, owner, workflowID)
	active, steps := admissionFixture("active-frame", "active-frame-request", owner, workflowID, "frame-a", "a")
	if _, _, err := AdmitWorkflowRun(active, steps, nil, nil, 1); err != nil {
		t.Fatal(err)
	}
	candidate, candidateSteps := admissionFixture("same-frame-disjoint", "same-frame-disjoint-request", owner, workflowID, "frame-a", "b")
	_, _, err := AdmitWorkflowRun(candidate, candidateSteps, nil, nil, 1)
	var conflict *WorkflowRunAdmissionConflict
	if !errors.As(err, &conflict) || conflict.Code != "workflow_run_scope_active" || conflict.RunID != active.ID {
		t.Fatalf("same-frame conflict = %#v", err)
	}

	workflowRun := candidate
	workflowRun.ID, workflowRun.RequestID, workflowRun.ScopeType, workflowRun.FrameID = "whole-run", "whole-request", model.WorkflowRunScopeWorkflow, ""
	_, _, err = AdmitWorkflowRun(workflowRun, candidateSteps, nil, nil, 1)
	if !errors.As(err, &conflict) || conflict.Code != "workflow_run_scope_active" {
		t.Fatalf("whole graph conflict = %#v", err)
	}
}

func TestWorkflowRunStateUsesCreatedAtAndIDForLatestAndIncludesAllActiveScopes(t *testing.T) {
	useRepositoryTestDB(t, newRepositoryTestConfig(t, "workflow_run_state"))
	owner, workflowID := "state-owner", "state-workflow"
	seedAdmissionWorkflow(t, owner, workflowID)
	database, _ := DB()
	base := time.Now().UTC().Add(-time.Hour)
	runs := []model.WorkflowRun{
		{ID: "run-a-old", OwnerUID: owner, RequestID: "request-a-old", WorkflowID: workflowID, Revision: 1, ScopeType: model.WorkflowRunScopeFrame, FrameID: "frame-a", FrameName: "A", Snapshot: `{}`, Status: "completed", CreatedAt: base, UpdatedAt: base.Add(time.Hour)},
		{ID: "run-a-new", OwnerUID: owner, RequestID: "request-a-new", WorkflowID: workflowID, Revision: 1, ScopeType: model.WorkflowRunScopeFrame, FrameID: "frame-a", FrameName: "A", Snapshot: `{}`, Status: "completed", CreatedAt: base.Add(time.Minute), UpdatedAt: base.Add(time.Minute)},
		{ID: "run-b", OwnerUID: owner, RequestID: "request-b", WorkflowID: workflowID, Revision: 1, ScopeType: model.WorkflowRunScopeFrame, FrameID: "frame-b", FrameName: "B", Snapshot: `{}`, Status: "running", CreatedAt: base.Add(2 * time.Minute), UpdatedAt: base.Add(2 * time.Minute)},
	}
	if err := database.Create(&runs).Error; err != nil {
		t.Fatal(err)
	}
	steps := []model.WorkflowStepExecution{{RunID: "run-a-old", NodeID: "a", Status: "succeeded"}, {RunID: "run-a-new", NodeID: "a", Status: "succeeded"}, {RunID: "run-b", NodeID: "b", Status: "running"}}
	if err := database.Create(&steps).Error; err != nil {
		t.Fatal(err)
	}
	state, err := GetWorkflowRunState(owner, workflowID, 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	if state.LatestRuns["frame\x00frame-a"].ID != "run-a-new" || state.NodeRunIDs["a"] != "run-a-new" || state.ActiveTotal != 1 || len(state.ActiveRuns) != 1 || state.ActiveRunIDs["frame\x00frame-b"] != "run-b" {
		t.Fatalf("state = %#v", state)
	}
}

func TestWorkflowRunStateCanonicalizesCorruptScopeHistory(t *testing.T) {
	useRepositoryTestDB(t, newRepositoryTestConfig(t, "workflow_run_state_corrupt_scope"))
	owner, workflowID := "corrupt-state-owner", "corrupt-state-workflow"
	seedAdmissionWorkflow(t, owner, workflowID)
	database, _ := DB()
	if err := database.Exec(`ALTER TABLE workflow_runs DROP CONSTRAINT workflow_runs_scope_fields_check`).Error; err != nil {
		t.Fatal(err)
	}
	base := time.Now().UTC().Add(-time.Hour)
	runs := []model.WorkflowRun{
		{ID: "valid-workflow-run", OwnerUID: owner, RequestID: "valid-workflow-request", WorkflowID: workflowID, Revision: 1, ScopeType: model.WorkflowRunScopeWorkflow, Snapshot: `{}`, Status: "completed", CreatedAt: base, UpdatedAt: base},
		{ID: "corrupt-newer-run", OwnerUID: owner, RequestID: "corrupt-newer-request", WorkflowID: workflowID, Revision: 1, ScopeType: "garbage", FrameID: "stray", FrameName: "stray", Snapshot: `{}`, Status: "running", CreatedAt: base.Add(time.Minute), UpdatedAt: base.Add(time.Minute)},
	}
	if err := database.Create(&runs).Error; err != nil {
		t.Fatal(err)
	}
	state, err := GetWorkflowRunState(owner, workflowID, 1, 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(state.LatestRuns) != 1 || state.LatestRuns["workflow\x00"].ID != "corrupt-newer-run" || state.ActiveRunIDs["workflow\x00"] != "corrupt-newer-run" {
		t.Fatalf("canonical state = %#v", state)
	}
	if len(state.ActiveRuns) != 1 || state.ActiveRuns[0].ScopeType != model.WorkflowRunScopeWorkflow || state.ActiveRuns[0].FrameID != "" || state.ActiveRuns[0].FrameName != "" {
		t.Fatalf("canonical active runs = %#v", state.ActiveRuns)
	}
}

func TestRetryWorkflowOutputRejectsCorruptMissingWorkflowIdentity(t *testing.T) {
	useRepositoryTestDB(t, newRepositoryTestConfig(t, "workflow_retry_corrupt_identity"))
	now := time.Now().UTC()
	run := model.WorkflowRun{ID: "corrupt-retry-run", OwnerUID: "corrupt-retry-owner", RequestID: "corrupt-retry-request", Revision: 1, ScopeType: model.WorkflowRunScopeWorkflow, Snapshot: `{}`, Status: "failed", CreatedAt: now, UpdatedAt: now}
	output := model.WorkflowOutputExecution{RunID: run.ID, NodeID: "node", SlotID: "slot", Status: "failed", Attempt: 1, UpdatedAt: now}
	if _, inserted, err := createWorkflowRunFixture(run, nil, []model.WorkflowOutputExecution{output}, nil); err != nil || !inserted {
		t.Fatalf("fixture inserted=%t err=%v", inserted, err)
	}
	if _, err := RetryWorkflowOutput(run.OwnerUID, run.ID, output.NodeID, output.SlotID, "retry-corrupt", now.Add(time.Second)); !errors.Is(err, ErrWorkflowRunCorrupt) {
		t.Fatalf("retry corrupt run error = %v", err)
	}
}

func TestWorkflowRunRetryAndNewAdmissionAreAtomic(t *testing.T) {
	useRepositoryTestDB(t, newRepositoryTestConfig(t, "workflow_retry_admission"))
	owner, workflowID := "retry-admission-owner", "retry-admission-workflow"
	seedAdmissionWorkflow(t, owner, workflowID)
	old, oldSteps := admissionFixture("old-failed-run", "old-failed-request", owner, workflowID, "frame-a", "a")
	old.Status = "failed"
	oldOutput := model.WorkflowOutputExecution{RunID: old.ID, NodeID: "a", SlotID: "slot", Status: "failed", Attempt: 1, UpdatedAt: time.Now().UTC()}
	if _, inserted, err := createWorkflowRunFixture(old, oldSteps, []model.WorkflowOutputExecution{oldOutput}, nil); err != nil || !inserted {
		t.Fatalf("old run: inserted=%t err=%v", inserted, err)
	}
	candidate, candidateSteps := admissionFixture("new-run", "new-request", owner, workflowID, "frame-a", "a")
	start := make(chan struct{})
	results := make(chan error, 2)
	var wait sync.WaitGroup
	wait.Add(2)
	go func() {
		defer wait.Done()
		<-start
		_, err := RetryWorkflowOutput(owner, old.ID, "a", "slot", "retry-request", time.Now().UTC())
		results <- err
	}()
	go func() {
		defer wait.Done()
		<-start
		_, _, err := AdmitWorkflowRun(candidate, candidateSteps, nil, nil, 1)
		results <- err
	}()
	close(start)
	wait.Wait()
	close(results)
	successes, conflicts := 0, 0
	for err := range results {
		if err == nil {
			successes++
			continue
		}
		var conflict *WorkflowRunAdmissionConflict
		if errors.As(err, &conflict) {
			conflicts++
			continue
		}
		t.Fatalf("unexpected result: %v", err)
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("successes=%d conflicts=%d", successes, conflicts)
	}
}

func TestWorkflowRunRetryAndSchedulerClaimDoNotDeadlock(t *testing.T) {
	useRepositoryTestDB(t, newRepositoryTestConfig(t, "workflow_retry_claim"))
	owner, workflowID := "retry-claim-owner", "retry-claim-workflow"
	seedAdmissionWorkflow(t, owner, workflowID)
	run, steps := admissionFixture("retry-claim-run", "retry-claim-start", owner, workflowID, "frame-a", "a")
	run.Status = "attention_required"
	steps = append(steps, model.WorkflowStepExecution{RunID: run.ID, NodeID: "b", Status: "waiting"})
	now := time.Now().UTC()
	outputs := []model.WorkflowOutputExecution{
		{RunID: run.ID, NodeID: "a", SlotID: "failed-slot", Status: "failed", Attempt: 1, UpdatedAt: now},
		{RunID: run.ID, NodeID: "b", SlotID: "ready-slot", Status: "ready", Attempt: 1, UpdatedAt: now},
	}
	if _, inserted, err := createWorkflowRunFixture(run, steps, outputs, nil); err != nil || !inserted {
		t.Fatalf("run: inserted=%t err=%v", inserted, err)
	}
	start := make(chan struct{})
	results := make(chan error, 2)
	go func() {
		<-start
		_, err := RetryWorkflowOutput(owner, run.ID, "a", "failed-slot", "retry-claim-request", now.Add(time.Second))
		results <- err
	}()
	go func() {
		<-start
		_, found, err := ClaimWorkflowAttempt(4, 2, true, now.Add(time.Second), time.Minute)
		if err == nil && !found {
			err = errors.New("ready attempt was not claimed")
		}
		results <- err
	}()
	close(start)
	for range 2 {
		select {
		case err := <-results:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("retry and scheduler claim did not complete")
		}
	}
}

func TestClaimWorkflowAttemptWaitsForRunBeforeLockingOutput(t *testing.T) {
	useRepositoryTestDB(t, newRepositoryTestConfig(t, "workflow_claim_lock_order"))
	owner, workflowID := "claim-order-owner", "claim-order-workflow"
	seedAdmissionWorkflow(t, owner, workflowID)
	run, steps := admissionFixture("claim-order-run", "claim-order-request", owner, workflowID, "frame-a", "a")
	run.Status = "running"
	now := time.Now().UTC()
	output := model.WorkflowOutputExecution{RunID: run.ID, NodeID: "a", SlotID: "ready-slot", Status: "ready", Attempt: 1, UpdatedAt: now}
	if _, inserted, err := createWorkflowRunFixture(run, steps, []model.WorkflowOutputExecution{output}, nil); err != nil || !inserted {
		t.Fatalf("run: inserted=%t err=%v", inserted, err)
	}
	database, _ := DB()
	blocker := database.Begin()
	if blocker.Error != nil {
		t.Fatal(blocker.Error)
	}
	defer blocker.Rollback()
	if err := blocker.Exec(`SELECT id FROM workflow_runs WHERE id = ? FOR UPDATE`, run.ID).Error; err != nil {
		t.Fatal(err)
	}
	type claimResult struct {
		found bool
		err   error
	}
	claimed := make(chan claimResult, 1)
	go func() {
		_, found, err := ClaimWorkflowAttempt(4, 2, true, now, time.Minute)
		claimed <- claimResult{found: found, err: err}
	}()
	deadline := time.Now().Add(5 * time.Second)
	for {
		var waiting int64
		if err := database.Raw(`SELECT COUNT(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%workflow_runs%' AND query LIKE '%FOR UPDATE%'`).Scan(&waiting).Error; err != nil {
			t.Fatal(err)
		}
		if waiting > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("claim did not wait for the selected run lock")
		}
		time.Sleep(10 * time.Millisecond)
	}
	probe := database.Begin()
	if probe.Error != nil {
		t.Fatal(probe.Error)
	}
	var lockedRunID string
	probeErr := probe.Raw(`SELECT run_id FROM workflow_output_executions WHERE run_id = ? AND node_id = ? AND slot_id = ? FOR UPDATE NOWAIT`, run.ID, output.NodeID, output.SlotID).Scan(&lockedRunID).Error
	_ = probe.Rollback().Error
	if probeErr != nil {
		t.Fatalf("claim locked output before run: %v", probeErr)
	}
	if err := blocker.Rollback().Error; err != nil {
		t.Fatal(err)
	}
	select {
	case result := <-claimed:
		if result.err != nil || !result.found {
			t.Fatalf("claim after run unlock = found %t err %v", result.found, result.err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("claim did not finish after run unlock")
	}
}
