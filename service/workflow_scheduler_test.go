package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"gorm.io/gorm"
)

func TestWorkflowSchedulerRecoversTheSameImageTaskWithoutResubmission(t *testing.T) {
	clearWorkflowRuntimeTables(t)
	previousConfig := config.Cfg
	config.Cfg.WorkflowEnabled = true
	config.Cfg.WorkflowGlobalConcurrency = 4
	config.Cfg.WorkflowRunConcurrency = 2
	t.Cleanup(func() { config.Cfg = previousConfig })
	seedWorkflowMember(t, "scheduler-owner", true)
	run := seedWorkflowImageRun(t, "scheduler-recovery", "scheduler-owner")

	previousCreate, previousGet := workflowCreateImageTask, workflowGetImageTask
	createCalls, getCalls := 0, 0
	workflowCreateImageTask = func(_ context.Context, request CreateImageTaskRequest) (ImageTaskView, error) {
		createCalls++
		if request.ClientRequestID == "" || request.Request.Prompt != "生成产品图" {
			t.Fatalf("unexpected workflow image request: %#v", request)
		}
		return ImageTaskView{ID: "durable-image-task", ClientRequestID: request.ClientRequestID, Status: "running"}, nil
	}
	workflowGetImageTask = func(_ context.Context, requestID string) (ImageTaskView, error) {
		getCalls++
		return ImageTaskView{ID: "durable-image-task", ClientRequestID: requestID, Status: "failed", Error: "供应商明确失败"}, nil
	}
	t.Cleanup(func() { workflowCreateImageTask, workflowGetImageTask = previousCreate, previousGet })

	processed, err := RunWorkflowSchedulerOnce(context.Background())
	if err != nil || !processed || createCalls != 1 || getCalls != 0 {
		t.Fatalf("first scheduler pass = %v, %v, create=%d get=%d", processed, err, createCalls, getCalls)
	}
	database, _ := repository.DB()
	if err := database.Model(&model.WorkflowOutputAttempt{}).Where("run_id = ?", run.ID).Update("next_poll_at", time.Now().UTC().Add(-time.Second)).Error; err != nil {
		t.Fatal(err)
	}
	processed, err = RunWorkflowSchedulerOnce(context.Background())
	if err != nil || !processed || createCalls != 1 || getCalls != 1 {
		t.Fatalf("recovery scheduler pass = %v, %v, create=%d get=%d", processed, err, createCalls, getCalls)
	}
	record, found, err := repository.GetWorkflowRun(run.OwnerUID, run.ID)
	if err != nil || !found || len(record.Outputs) != 1 || record.Outputs[0].Status != "failed" || len(record.Attempts) != 1 || record.Attempts[0].TaskID != "durable-image-task" {
		t.Fatalf("recovered workflow record = %#v, %v, %v", record, found, err)
	}
}

func TestWorkflowSchedulerRejectsSubmissionAfterOwnerIsDisabled(t *testing.T) {
	clearWorkflowRuntimeTables(t)
	previousConfig := config.Cfg
	config.Cfg.WorkflowEnabled = true
	t.Cleanup(func() { config.Cfg = previousConfig })
	seedWorkflowMember(t, "disabled-workflow-owner", false)
	run := seedWorkflowImageRun(t, "disabled-run", "disabled-workflow-owner")
	previousCreate := workflowCreateImageTask
	createCalls := 0
	workflowCreateImageTask = func(context.Context, CreateImageTaskRequest) (ImageTaskView, error) {
		createCalls++
		return ImageTaskView{}, errors.New("must not submit")
	}
	t.Cleanup(func() { workflowCreateImageTask = previousCreate })

	if processed, err := RunWorkflowSchedulerOnce(context.Background()); err != nil || !processed {
		t.Fatalf("scheduler pass = %v, %v", processed, err)
	}
	record, found, err := repository.GetWorkflowRun(run.OwnerUID, run.ID)
	if err != nil || !found || createCalls != 0 || record.Outputs[0].Status != "failed" {
		t.Fatalf("disabled owner result = %#v, found=%v err=%v create=%d", record, found, err, createCalls)
	}
}

func TestWorkflowSchedulerRecoversAnExistingTaskAfterOwnerIsDisabled(t *testing.T) {
	clearWorkflowRuntimeTables(t)
	previousConfig := config.Cfg
	config.Cfg.WorkflowEnabled = true
	t.Cleanup(func() { config.Cfg = previousConfig })
	seedWorkflowMember(t, "disabled-recovery-owner", false)
	run := seedWorkflowImageRun(t, "disabled-recovery-run", "disabled-recovery-owner")
	if err := reevaluateWorkflowRun(run.OwnerUID, run.ID); err != nil {
		t.Fatal(err)
	}
	attempt, found, err := repository.ClaimWorkflowAttempt(4, 2, true, time.Now().UTC(), time.Minute)
	if err != nil || !found {
		t.Fatalf("claim = %#v, %v, %v", attempt, found, err)
	}
	authorized, err := repository.AuthorizeWorkflowAttemptSubmission(attempt, true, time.Now().UTC())
	if err != nil || !authorized {
		t.Fatalf("authorize = %v, %v", authorized, err)
	}
	attempt.Status = "submitting"
	attempt.CreatedAt = time.Now().UTC().Add(-time.Hour)
	attempt.Error = "创建生成任务暂时失败"
	imageTask := model.ImageGenerationTask{ID: "disabled-existing-task", OwnerUID: run.OwnerUID, ClientRequestID: attempt.RequestID, Status: model.ImageTaskRunning, CreatedAt: now(), UpdatedAt: now()}
	operation := model.OperationLog{ID: "disabled-existing-operation", ActorUID: run.OwnerUID, Status: model.OperationStatusSubmitted, CreatedAt: time.Now().UTC()}
	imageTask.OperationLogID = operation.ID
	if _, _, err := repository.CreateImageGenerationTaskWithOperationLog(imageTask, operation); err != nil {
		t.Fatal(err)
	}
	previousCreate, previousGet := workflowCreateImageTask, workflowGetImageTask
	createCalls, getCalls := 0, 0
	workflowCreateImageTask = func(context.Context, CreateImageTaskRequest) (ImageTaskView, error) {
		createCalls++
		return ImageTaskView{}, errors.New("must not create")
	}
	workflowGetImageTask = func(_ context.Context, requestID string) (ImageTaskView, error) {
		getCalls++
		return ImageTaskView{ID: imageTask.ID, ClientRequestID: requestID, Status: "failed", Error: "原任务失败"}, nil
	}
	t.Cleanup(func() { workflowCreateImageTask, workflowGetImageTask = previousCreate, previousGet })
	if err := processWorkflowAttempt(context.Background(), attempt); err != nil {
		t.Fatal(err)
	}
	record, _, _ := repository.GetWorkflowRun(run.OwnerUID, run.ID)
	if createCalls != 0 || getCalls != 1 || record.Attempts[0].TaskID != imageTask.ID || record.Outputs[0].Status != "failed" {
		t.Fatalf("disabled recovery = %#v create=%d get=%d", record, createCalls, getCalls)
	}
}

func TestWorkflowSchedulerKeepsPollingAfterATransientTaskLookupFailure(t *testing.T) {
	clearWorkflowRuntimeTables(t)
	previousConfig := config.Cfg
	config.Cfg.WorkflowEnabled = true
	t.Cleanup(func() { config.Cfg = previousConfig })
	seedWorkflowMember(t, "transient-owner", true)
	run := seedWorkflowImageRun(t, "transient-run", "transient-owner")
	previousCreate, previousGet := workflowCreateImageTask, workflowGetImageTask
	createCalls, getCalls := 0, 0
	workflowCreateImageTask = func(_ context.Context, request CreateImageTaskRequest) (ImageTaskView, error) {
		createCalls++
		return ImageTaskView{ID: "transient-task", ClientRequestID: request.ClientRequestID, Status: "running"}, nil
	}
	workflowGetImageTask = func(_ context.Context, requestID string) (ImageTaskView, error) {
		getCalls++
		return ImageTaskView{}, errors.New("temporary database failure")
	}
	t.Cleanup(func() { workflowCreateImageTask, workflowGetImageTask = previousCreate, previousGet })
	if processed, err := RunWorkflowSchedulerOnce(context.Background()); err != nil || !processed {
		t.Fatalf("initial pass = %v, %v", processed, err)
	}
	database, _ := repository.DB()
	if err := database.Model(&model.WorkflowOutputAttempt{}).Where("run_id = ?", run.ID).Update("next_poll_at", time.Now().UTC().Add(-time.Second)).Error; err != nil {
		t.Fatal(err)
	}
	if processed, err := RunWorkflowSchedulerOnce(context.Background()); err != nil || !processed {
		t.Fatalf("transient pass = %v, %v", processed, err)
	}
	record, _, _ := repository.GetWorkflowRun(run.OwnerUID, run.ID)
	if createCalls != 1 || getCalls != 1 || len(record.Attempts) != 1 || record.Attempts[0].Status != "running" || record.Outputs[0].Status != "running" {
		t.Fatalf("transient failure changed retryability: %#v create=%d get=%d", record, createCalls, getCalls)
	}
}

func TestWorkflowSchedulerRetriesATransientLocalTaskCreateWithTheSameRequest(t *testing.T) {
	clearWorkflowRuntimeTables(t)
	previousConfig := config.Cfg
	config.Cfg.WorkflowEnabled = true
	t.Cleanup(func() { config.Cfg = previousConfig })
	seedWorkflowMember(t, "create-transient-owner", true)
	run := seedWorkflowImageRun(t, "create-transient-run", "create-transient-owner")
	previousCreate := workflowCreateImageTask
	createCalls := 0
	requestIDs := []string{}
	workflowCreateImageTask = func(_ context.Context, request CreateImageTaskRequest) (ImageTaskView, error) {
		createCalls++
		requestIDs = append(requestIDs, request.ClientRequestID)
		return ImageTaskView{}, errors.New("temporary local database failure")
	}
	t.Cleanup(func() { workflowCreateImageTask = previousCreate })
	if processed, err := RunWorkflowSchedulerOnce(context.Background()); err != nil || !processed {
		t.Fatalf("first pass = %v, %v", processed, err)
	}
	database, _ := repository.DB()
	if err := database.Model(&model.WorkflowOutputAttempt{}).Where("run_id = ?", run.ID).Update("next_poll_at", time.Now().UTC().Add(-time.Second)).Error; err != nil {
		t.Fatal(err)
	}
	if processed, err := RunWorkflowSchedulerOnce(context.Background()); err != nil || !processed {
		t.Fatalf("second pass = %v, %v", processed, err)
	}
	record, _, _ := repository.GetWorkflowRun(run.OwnerUID, run.ID)
	if createCalls != 2 || len(requestIDs) != 2 || requestIDs[0] != requestIDs[1] || len(record.Attempts) != 1 || record.Attempts[0].Status != "submitting" {
		t.Fatalf("transient create recovery = %#v create=%d requestIDs=%v", record, createCalls, requestIDs)
	}
}

func TestWorkflowSchedulerPollsDueTasksWithoutStarvingReadyCapacity(t *testing.T) {
	clearWorkflowRuntimeTables(t)
	previousConfig := config.Cfg
	config.Cfg.WorkflowEnabled = true
	config.Cfg.WorkflowGlobalConcurrency = 4
	config.Cfg.WorkflowRunConcurrency = 2
	t.Cleanup(func() { config.Cfg = previousConfig })
	seedWorkflowMember(t, "fair-owner", true)
	for _, runID := range []string{"fair-running-one", "fair-running-two"} {
		run := seedWorkflowImageRun(t, runID, "fair-owner")
		if err := reevaluateWorkflowRun(run.OwnerUID, run.ID); err != nil {
			t.Fatal(err)
		}
		attempt, found, err := repository.ClaimWorkflowAttempt(4, 2, true, time.Now().UTC(), time.Minute)
		if err != nil || !found {
			t.Fatalf("seed claim = %#v, %v, %v", attempt, found, err)
		}
		if authorized, err := repository.AuthorizeWorkflowAttemptSubmission(attempt, true, time.Now().UTC()); err != nil || !authorized {
			t.Fatalf("seed authorize = %v, %v", authorized, err)
		}
		attempt.Status, attempt.TaskType, attempt.TaskID = "running", "image", "task-"+runID
		if err := repository.UpdateClaimedWorkflowAttempt(attempt, "running", time.Now().UTC().Add(time.Hour), false); err != nil {
			t.Fatal(err)
		}
	}
	database, _ := repository.DB()
	if err := database.Model(&model.WorkflowOutputAttempt{}).Where("run_id IN ?", []string{"fair-running-one", "fair-running-two"}).Update("next_poll_at", time.Now().UTC().Add(-time.Second)).Error; err != nil {
		t.Fatal(err)
	}
	readyRun := seedWorkflowImageRun(t, "fair-ready", "fair-owner")
	previousCreate, previousGet := workflowCreateImageTask, workflowGetImageTask
	createCalls, getCalls := 0, 0
	workflowCreateImageTask = func(_ context.Context, request CreateImageTaskRequest) (ImageTaskView, error) {
		createCalls++
		return ImageTaskView{ID: "task-ready", ClientRequestID: request.ClientRequestID, Status: "running"}, nil
	}
	workflowGetImageTask = func(_ context.Context, requestID string) (ImageTaskView, error) {
		getCalls++
		return ImageTaskView{ID: "existing", ClientRequestID: requestID, Status: "running"}, nil
	}
	t.Cleanup(func() { workflowCreateImageTask, workflowGetImageTask = previousCreate, previousGet })
	if processed, err := RunWorkflowSchedulerOnce(context.Background()); err != nil || !processed {
		t.Fatalf("scheduler batch = %v, %v", processed, err)
	}
	record, found, err := repository.GetWorkflowRun(readyRun.OwnerUID, readyRun.ID)
	if err != nil || !found || createCalls != 1 || getCalls != 2 || len(record.Attempts) != 1 || record.Outputs[0].Status != "running" {
		t.Fatalf("fair scheduler result = %#v found=%v err=%v create=%d get=%d", record, found, err, createCalls, getCalls)
	}
}

func TestWorkflowStopBeforeSubmissionAuthorizationCreatesNoTask(t *testing.T) {
	clearWorkflowRuntimeTables(t)
	previousConfig := config.Cfg
	config.Cfg.WorkflowEnabled = true
	t.Cleanup(func() { config.Cfg = previousConfig })
	seedWorkflowMember(t, "stop-owner", true)
	run := seedWorkflowImageRun(t, "stop-run", "stop-owner")
	if err := reevaluateWorkflowRun(run.OwnerUID, run.ID); err != nil {
		t.Fatal(err)
	}
	attempt, found, err := repository.ClaimWorkflowAttempt(4, 2, true, time.Now().UTC(), time.Minute)
	if err != nil || !found {
		t.Fatalf("claim = %#v, %v, %v", attempt, found, err)
	}
	if changed, err := repository.RequestWorkflowRunStop(run.OwnerUID, run.ID, time.Now().UTC()); err != nil || !changed {
		t.Fatalf("stop = %v, %v", changed, err)
	}
	previousCreate := workflowCreateImageTask
	createCalls := 0
	workflowCreateImageTask = func(context.Context, CreateImageTaskRequest) (ImageTaskView, error) {
		createCalls++
		return ImageTaskView{}, nil
	}
	t.Cleanup(func() { workflowCreateImageTask = previousCreate })
	if err := processWorkflowAttempt(context.Background(), attempt); err != nil {
		t.Fatal(err)
	}
	record, _, _ := repository.GetWorkflowRun(run.OwnerUID, run.ID)
	if createCalls != 0 || record.Outputs[0].Status != "stopped" || record.Attempts[0].Status != "stopped" {
		t.Fatalf("stop boundary result = %#v create=%d", record, createCalls)
	}
}

func TestWorkflowStopSettlesAClaimWhenSubmissionSwitchIsOff(t *testing.T) {
	clearWorkflowRuntimeTables(t)
	previousConfig := config.Cfg
	config.Cfg.WorkflowEnabled = true
	t.Cleanup(func() { config.Cfg = previousConfig })
	seedWorkflowMember(t, "switch-stop-owner", true)
	run := seedWorkflowImageRun(t, "switch-stop-run", "switch-stop-owner")
	if err := reevaluateWorkflowRun(run.OwnerUID, run.ID); err != nil {
		t.Fatal(err)
	}
	attempt, found, err := repository.ClaimWorkflowAttempt(4, 2, true, time.Now().UTC(), time.Minute)
	if err != nil || !found {
		t.Fatalf("claim = %#v, %v, %v", attempt, found, err)
	}
	config.Cfg.WorkflowEnabled = false
	if changed, err := repository.RequestWorkflowRunStop(run.OwnerUID, run.ID, time.Now().UTC()); err != nil || !changed {
		t.Fatalf("stop = %v, %v", changed, err)
	}
	if err := processWorkflowAttempt(context.Background(), attempt); err != nil {
		t.Fatal(err)
	}
	record, _, _ := repository.GetWorkflowRun(run.OwnerUID, run.ID)
	if record.Outputs[0].Status != "stopped" || record.Attempts[0].Status != "stopped" {
		t.Fatalf("disabled switch left claimed work active: %#v", record)
	}
}

func TestWorkflowEvaluationDoesNotWaitForAnUnconnectedSiblingSlot(t *testing.T) {
	graph := model.WorkflowGraph{Version: 1, Nodes: []model.WorkflowNode{
		{ID: "source", Type: model.WorkflowNodeImageGeneration, Outputs: []model.WorkflowOutputSlot{{ID: "used", Type: model.WorkflowPortImage}, {ID: "unrelated", Type: model.WorkflowPortImage}}},
		{ID: "prompt", Type: model.WorkflowNodeTextInput, Text: "继续处理"},
		{ID: "target", Type: model.WorkflowNodeImageGeneration},
	}, Connections: []model.WorkflowConnection{
		{SourceNodeID: "source", SourceSlotID: "used", TargetNodeID: "target", TargetPortID: "image", Order: 0},
		{SourceNodeID: "prompt", SourceSlotID: "output", TargetNodeID: "target", TargetPortID: "prompt", Order: 1},
	}}
	resolved, err := resolveWorkflowInputs(graph, "target", []model.WorkflowOutputExecution{
		{NodeID: "source", SlotID: "used", Status: "succeeded", MediaID: "used-media"},
		{NodeID: "source", SlotID: "unrelated", Status: "running"},
	})
	if err != nil || resolved.State != "ready" || len(resolved.ImageMediaIDs) != 1 || resolved.ImageMediaIDs[0] != "used-media" {
		t.Fatalf("resolved inputs = %#v, %v", resolved, err)
	}
}

func TestWorkflowRunAggregationKeepsUncertainWorkVisibleAndStopsAfterActiveWork(t *testing.T) {
	if status, finished := aggregateWorkflowRun(model.WorkflowRun{}, []model.WorkflowOutputExecution{{Status: "uncertain"}}); status != "attention_required" || finished != nil {
		t.Fatalf("uncertain aggregation = %q, %v", status, finished)
	}
	stopping := model.WorkflowRun{StopRequested: true}
	if status, finished := aggregateWorkflowRun(stopping, []model.WorkflowOutputExecution{{Status: "running"}, {Status: "stopped"}}); status != "stopping" || finished != nil {
		t.Fatalf("stopping aggregation = %q, %v", status, finished)
	}
	if status, finished := aggregateWorkflowRun(stopping, []model.WorkflowOutputExecution{{Status: "succeeded"}, {Status: "stopped"}}); status != "stopped" || finished == nil {
		t.Fatalf("stopped aggregation = %q, %v", status, finished)
	}
}

func TestWorkflowSchedulerAdvancesAnImageToVideoDAGAndPublishesTheSlotResults(t *testing.T) {
	clearWorkflowRuntimeTables(t)
	previousConfig := config.Cfg
	config.Cfg.WorkflowEnabled = true
	config.Cfg.WorkflowGlobalConcurrency = 4
	config.Cfg.WorkflowRunConcurrency = 2
	t.Cleanup(func() { config.Cfg = previousConfig })
	seedWorkflowMember(t, "mixed-owner", true)
	run := seedWorkflowMixedRun(t, "mixed-run", "mixed-owner")
	previousImage, previousVideo, previousVideoGet := workflowCreateImageTask, workflowCreateVideoTask, workflowGetVideoTask
	imageCalls, videoCalls, videoGetCalls := 0, 0, 0
	workflowCreateImageTask = func(_ context.Context, request CreateImageTaskRequest) (ImageTaskView, error) {
		imageCalls++
		return ImageTaskView{ID: "mixed-image-task", ClientRequestID: request.ClientRequestID, Status: "succeeded", Images: []MediaAccess{{MediaID: "mixed-image-media"}}}, nil
	}
	workflowCreateVideoTask = func(_ context.Context, request CreateVideoTaskRequest) (VideoTaskView, error) {
		videoCalls++
		if len(request.ImageMediaIDs) != 1 || request.ImageMediaIDs[0] != "mixed-image-media" || request.Prompt != "制作视频" || request.Seconds != 6 {
			t.Fatalf("video request did not use upstream output: %#v", request)
		}
		return VideoTaskView{ID: "mixed-video-task", ClientRequestID: request.ClientRequestID, Status: "running"}, nil
	}
	workflowGetVideoTask = func(_ context.Context, requestID string) (VideoTaskView, error) {
		videoGetCalls++
		return VideoTaskView{ID: "mixed-video-task", ClientRequestID: requestID, Status: "succeeded", ResultMediaIDs: []string{"mixed-video-media"}}, nil
	}
	t.Cleanup(func() {
		workflowCreateImageTask, workflowCreateVideoTask, workflowGetVideoTask = previousImage, previousVideo, previousVideoGet
	})
	if processed, err := RunWorkflowSchedulerOnce(context.Background()); err != nil || !processed {
		t.Fatalf("mixed first pass = %v, %v", processed, err)
	}
	record, _, _ := repository.GetWorkflowRun(run.OwnerUID, run.ID)
	if imageCalls != 1 || videoCalls != 1 || len(record.Outputs) != 2 || record.Outputs[0].Status == "waiting" && record.Outputs[1].Status == "waiting" {
		t.Fatalf("mixed first result = %#v image=%d video=%d", record, imageCalls, videoCalls)
	}
	database, _ := repository.DB()
	if err := database.Model(&model.WorkflowOutputAttempt{}).Where("run_id = ? AND task_type = ?", run.ID, "video").Update("next_poll_at", time.Now().UTC().Add(-time.Second)).Error; err != nil {
		t.Fatal(err)
	}
	if processed, err := RunWorkflowSchedulerOnce(context.Background()); err != nil || !processed {
		t.Fatalf("mixed completion pass = %v, %v", processed, err)
	}
	record, _, _ = repository.GetWorkflowRun(run.OwnerUID, run.ID)
	byNode := map[string]model.WorkflowOutputExecution{}
	for _, output := range record.Outputs {
		byNode[output.NodeID] = output
	}
	if videoGetCalls != 1 || byNode["image"].MediaID != "mixed-image-media" || byNode["video"].MediaID != "mixed-video-media" || record.Run.Status != "completed" {
		t.Fatalf("mixed completed result = %#v videoGet=%d", record, videoGetCalls)
	}
}

func TestWorkflowVideoUncertainStateOnlyQueriesTheOriginalTask(t *testing.T) {
	clearWorkflowRuntimeTables(t)
	previousConfig := config.Cfg
	config.Cfg.WorkflowEnabled = true
	t.Cleanup(func() { config.Cfg = previousConfig })
	seedWorkflowMember(t, "video-uncertain-owner", true)
	run := seedWorkflowVideoRun(t, "video-uncertain-run", "video-uncertain-owner")
	previousCreate, previousGet := workflowCreateVideoTask, workflowGetVideoTask
	createCalls, getCalls := 0, 0
	workflowCreateVideoTask = func(_ context.Context, request CreateVideoTaskRequest) (VideoTaskView, error) {
		createCalls++
		return VideoTaskView{ID: "uncertain-video-task", ClientRequestID: request.ClientRequestID, Status: "uncertain", Error: "提交待确认"}, nil
	}
	workflowGetVideoTask = func(_ context.Context, requestID string) (VideoTaskView, error) {
		getCalls++
		return VideoTaskView{ID: "uncertain-video-task", ClientRequestID: requestID, Status: "running"}, nil
	}
	t.Cleanup(func() { workflowCreateVideoTask, workflowGetVideoTask = previousCreate, previousGet })
	if _, err := RunWorkflowSchedulerOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	database, _ := repository.DB()
	var first model.WorkflowOutputAttempt
	if err := database.Where("run_id = ?", run.ID).First(&first).Error; err != nil {
		t.Fatal(err)
	}
	if first.Status != "uncertain" {
		t.Fatalf("first video attempt = %#v", first)
	}
	if err := database.Model(&first).Update("next_poll_at", time.Now().UTC().Add(-time.Second)).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := RunWorkflowSchedulerOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	record, _, _ := repository.GetWorkflowRun(run.OwnerUID, run.ID)
	if createCalls != 1 || getCalls != 1 || len(record.Attempts) != 1 || record.Attempts[0].TaskID != "uncertain-video-task" || record.Outputs[0].Status != "running" {
		t.Fatalf("uncertain recovery = %#v create=%d get=%d", record, createCalls, getCalls)
	}
}

func TestWorkflowVideoRetryCreatesOneNewAttemptWithANewDeterministicRequest(t *testing.T) {
	clearWorkflowRuntimeTables(t)
	previousConfig := config.Cfg
	config.Cfg.WorkflowEnabled = true
	t.Cleanup(func() { config.Cfg = previousConfig })
	seedWorkflowMember(t, "video-retry-owner", true)
	run := seedWorkflowVideoRun(t, "video-retry-run", "video-retry-owner")
	previousCreate := workflowCreateVideoTask
	requestIDs := []string{}
	workflowCreateVideoTask = func(_ context.Context, request CreateVideoTaskRequest) (VideoTaskView, error) {
		requestIDs = append(requestIDs, request.ClientRequestID)
		if len(requestIDs) == 1 {
			return VideoTaskView{ID: "video-retry-first-task", ClientRequestID: request.ClientRequestID, Status: "failed", Error: "供应商明确失败"}, nil
		}
		return VideoTaskView{ID: "video-retry-second-task", ClientRequestID: request.ClientRequestID, Status: "succeeded", ResultMediaIDs: []string{"video-retry-media"}}, nil
	}
	t.Cleanup(func() { workflowCreateVideoTask = previousCreate })

	if processed, err := RunWorkflowSchedulerOnce(context.Background()); err != nil || !processed {
		t.Fatalf("first video attempt = %v, %v", processed, err)
	}
	record, _, _ := repository.GetWorkflowRun(run.OwnerUID, run.ID)
	if len(requestIDs) != 1 || record.Outputs[0].Status != "failed" || len(record.Attempts) != 1 {
		t.Fatalf("first video failure = %#v requests=%v", record, requestIDs)
	}
	input := RetryWorkflowOutputInput{RequestID: "retry-video-once", NodeID: "video", SlotID: "output"}
	for click := 0; click < 2; click++ {
		if _, err := RetryWorkflowOutput(context.Background(), PortalUser{UID: run.OwnerUID}, run.ID, input); err != nil {
			t.Fatalf("retry click %d: %v", click+1, err)
		}
	}
	if processed, err := RunWorkflowSchedulerOnce(context.Background()); err != nil || !processed {
		t.Fatalf("retried video attempt = %v, %v", processed, err)
	}
	record, _, _ = repository.GetWorkflowRun(run.OwnerUID, run.ID)
	retryRecorded := false
	for _, attempt := range record.Attempts {
		if attempt.Attempt == 2 && attempt.RetryRequestID == input.RequestID {
			retryRecorded = true
		}
	}
	if len(requestIDs) != 2 || requestIDs[0] == requestIDs[1] || len(record.Attempts) != 2 || !retryRecorded || record.Outputs[0].Attempt != 2 || record.Outputs[0].MediaID != "video-retry-media" || record.Run.Status != "completed" {
		t.Fatalf("retried video completion = %#v requests=%v", record, requestIDs)
	}
}

func TestRetryWorkflowOutputKeepsSuccessfulSiblingsAndReevaluatesDependents(t *testing.T) {
	clearWorkflowRuntimeTables(t)
	previousConfig := config.Cfg
	config.Cfg.WorkflowEnabled = true
	t.Cleanup(func() { config.Cfg = previousConfig })
	seedWorkflowMember(t, "retry-service-owner", true)
	seconds := 6
	graph := model.WorkflowGraph{Version: 1, Nodes: []model.WorkflowNode{
		{ID: "prompt", Type: model.WorkflowNodeTextInput, Text: "重试"},
		{ID: "source", Type: model.WorkflowNodeImageGeneration, Config: &model.WorkflowNodeConfig{ProviderID: "image"}, Outputs: []model.WorkflowOutputSlot{{ID: "failed-slot", Type: model.WorkflowPortImage}, {ID: "success-slot", Type: model.WorkflowPortImage}}},
		{ID: "downstream", Type: model.WorkflowNodeVideoGeneration, Config: &model.WorkflowNodeConfig{ProviderID: "video", Seconds: &seconds}, Outputs: []model.WorkflowOutputSlot{{ID: "video-slot", Type: model.WorkflowPortVideo}}},
	}, Connections: []model.WorkflowConnection{
		{SourceNodeID: "prompt", SourceSlotID: "output", TargetNodeID: "source", TargetPortID: "prompt", Order: 0},
		{SourceNodeID: "source", SourceSlotID: "failed-slot", TargetNodeID: "downstream", TargetPortID: "image", Order: 0},
		{SourceNodeID: "prompt", SourceSlotID: "output", TargetNodeID: "downstream", TargetPortID: "prompt", Order: 1},
	}}
	snapshot, _ := json.Marshal(graph)
	current := time.Now().UTC()
	run := model.WorkflowRun{ID: "retry-service-run", OwnerUID: "retry-service-owner", RequestID: "retry-service-start", Snapshot: string(snapshot), Status: "partially_completed", StateVersion: 1, CreatedAt: current, UpdatedAt: current}
	steps := []model.WorkflowStepExecution{{RunID: run.ID, NodeID: "source", Status: "failed"}, {RunID: run.ID, NodeID: "downstream", Status: "blocked"}}
	outputs := []model.WorkflowOutputExecution{
		{RunID: run.ID, NodeID: "source", SlotID: "failed-slot", Status: "failed", Attempt: 1, Error: "失败", UpdatedAt: current},
		{RunID: run.ID, NodeID: "source", SlotID: "success-slot", Status: "succeeded", Attempt: 1, MediaID: "successful-sibling", UpdatedAt: current},
		{RunID: run.ID, NodeID: "downstream", SlotID: "video-slot", Status: "blocked", Attempt: 1, Error: "上游输出失败", UpdatedAt: current},
	}
	if _, _, err := createWorkflowRunFixture(run, steps, outputs, nil); err != nil {
		t.Fatal(err)
	}
	user := PortalUser{UID: run.OwnerUID}
	input := RetryWorkflowOutputInput{RequestID: "retry-click", NodeID: "source", SlotID: "failed-slot"}
	if _, err := RetryWorkflowOutput(context.Background(), user, run.ID, input); err != nil {
		t.Fatal(err)
	}
	if _, err := RetryWorkflowOutput(context.Background(), user, run.ID, input); err != nil {
		t.Fatal(err)
	}
	if err := reevaluateWorkflowRun(run.OwnerUID, run.ID); err != nil {
		t.Fatal(err)
	}
	record, _, _ := repository.GetWorkflowRun(run.OwnerUID, run.ID)
	bySlot := map[string]model.WorkflowOutputExecution{}
	for _, output := range record.Outputs {
		bySlot[output.SlotID] = output
	}
	if bySlot["failed-slot"].Attempt != 2 || bySlot["failed-slot"].Status != "ready" || bySlot["success-slot"].MediaID != "successful-sibling" || bySlot["success-slot"].Status != "succeeded" || bySlot["video-slot"].Status != "waiting" {
		t.Fatalf("retry propagation = %#v", record)
	}
}

func TestWorkflowSchedulerProcessesNineInputsAndNineOutputSlots(t *testing.T) {
	clearWorkflowRuntimeTables(t)
	previousConfig := config.Cfg
	config.Cfg.WorkflowEnabled = true
	config.Cfg.WorkflowGlobalConcurrency = 9
	config.Cfg.WorkflowRunConcurrency = 9
	t.Cleanup(func() { config.Cfg = previousConfig })
	owner := "nine-slot-owner"
	seedWorkflowMember(t, owner, true)

	graph := model.WorkflowGraph{Version: 1, Nodes: []model.WorkflowNode{}, Connections: []model.WorkflowConnection{}}
	ports := make([]model.WorkflowInputPort, 0, 9)
	outputs := make([]model.WorkflowOutputSlot, 0, 9)
	wantPrompt := ""
	for index := 0; index < 9; index++ {
		nodeID := fmt.Sprintf("prompt-%d", index)
		portID := fmt.Sprintf("input-%d", index)
		slotID := fmt.Sprintf("slot-%d", index)
		text := fmt.Sprintf("提示-%d", index)
		graph.Nodes = append(graph.Nodes, model.WorkflowNode{ID: nodeID, Type: model.WorkflowNodeTextInput, Text: text})
		ports = append(ports, model.WorkflowInputPort{ID: portID, Type: model.WorkflowPortText})
		outputs = append(outputs, model.WorkflowOutputSlot{ID: slotID, Type: model.WorkflowPortImage})
		graph.Connections = append(graph.Connections, model.WorkflowConnection{SourceNodeID: nodeID, SourceSlotID: "output", TargetNodeID: "generate", TargetPortID: portID, Order: index})
		if wantPrompt != "" {
			wantPrompt += "\n\n"
		}
		wantPrompt += text
	}
	graph.Nodes = append(graph.Nodes, model.WorkflowNode{ID: "generate", Type: model.WorkflowNodeImageGeneration, InputPorts: ports, Config: &model.WorkflowNodeConfig{ProviderID: "nine-slot-provider", Resolution: "1k"}, Outputs: outputs})
	run := seedWorkflowRunGraph(t, "nine-slot-run", owner, graph)

	previousCreate := workflowCreateImageTask
	created := map[string]bool{}
	workflowCreateImageTask = func(_ context.Context, request CreateImageTaskRequest) (ImageTaskView, error) {
		if request.Request.Prompt != wantPrompt {
			t.Fatalf("ordered nine-input prompt = %q", request.Request.Prompt)
		}
		created[request.ClientRequestID] = true
		return ImageTaskView{ID: "task-" + request.ClientRequestID, ClientRequestID: request.ClientRequestID, Status: "succeeded", Images: []MediaAccess{{MediaID: "media-" + request.ClientRequestID}}}, nil
	}
	t.Cleanup(func() { workflowCreateImageTask = previousCreate })

	if processed, err := RunWorkflowSchedulerOnce(context.Background()); err != nil || !processed {
		t.Fatalf("nine-slot scheduler = processed %t err %v", processed, err)
	}
	record, found, err := repository.GetWorkflowRun(owner, run.ID)
	if err != nil || !found {
		t.Fatal(err)
	}
	if len(created) != 9 || len(record.Outputs) != 9 || len(record.Attempts) != 9 || record.Run.Status != "completed" {
		t.Fatalf("nine-slot result = created %d outputs %d attempts %d status %s", len(created), len(record.Outputs), len(record.Attempts), record.Run.Status)
	}
	for _, output := range record.Outputs {
		if output.Status != "succeeded" || output.MediaID == "" {
			t.Fatalf("nine-slot output = %#v", output)
		}
	}
}

func seedWorkflowImageRun(t *testing.T, id, owner string) model.WorkflowRun {
	t.Helper()
	graph := model.WorkflowGraph{Version: 1, Nodes: []model.WorkflowNode{
		{ID: "prompt", Type: model.WorkflowNodeTextInput, Text: "生成产品图"},
		{ID: "generate", Type: model.WorkflowNodeImageGeneration, Config: &model.WorkflowNodeConfig{ProviderID: "frozen-provider", Resolution: "1k"}, Outputs: []model.WorkflowOutputSlot{{ID: "output", Type: model.WorkflowPortImage}}},
	}, Connections: []model.WorkflowConnection{{SourceNodeID: "prompt", SourceSlotID: "output", TargetNodeID: "generate", TargetPortID: "prompt", Order: 0}}}
	snapshot, _ := json.Marshal(graph)
	current := time.Now().UTC().Add(-time.Hour)
	run := model.WorkflowRun{ID: id, OwnerUID: owner, RequestID: id + "-request", Snapshot: string(snapshot), Status: "pending", CreatedAt: current, UpdatedAt: current}
	steps := []model.WorkflowStepExecution{{RunID: id, NodeID: "generate", Status: "waiting"}}
	outputs := []model.WorkflowOutputExecution{{RunID: id, NodeID: "generate", SlotID: "output", Status: "waiting", Attempt: 1, UpdatedAt: current}}
	if _, _, err := createWorkflowRunFixture(run, steps, outputs, nil); err != nil {
		t.Fatal(err)
	}
	return run
}

func seedWorkflowVideoRun(t *testing.T, id, owner string) model.WorkflowRun {
	t.Helper()
	seconds := 6
	graph := model.WorkflowGraph{Version: 1, Nodes: []model.WorkflowNode{
		{ID: "prompt", Type: model.WorkflowNodeTextInput, Text: "制作视频"},
		{ID: "video", Type: model.WorkflowNodeVideoGeneration, Config: &model.WorkflowNodeConfig{ProviderID: "frozen-video-provider", Size: "16:9", Resolution: "720p", Seconds: &seconds}, Outputs: []model.WorkflowOutputSlot{{ID: "output", Type: model.WorkflowPortVideo}}},
	}, Connections: []model.WorkflowConnection{{SourceNodeID: "prompt", SourceSlotID: "output", TargetNodeID: "video", TargetPortID: "prompt", Order: 0}}}
	return seedWorkflowRunGraph(t, id, owner, graph)
}

func seedWorkflowMixedRun(t *testing.T, id, owner string) model.WorkflowRun {
	t.Helper()
	seconds := 6
	graph := model.WorkflowGraph{Version: 1, Nodes: []model.WorkflowNode{
		{ID: "image-prompt", Type: model.WorkflowNodeTextInput, Text: "生成产品图"},
		{ID: "video-prompt", Type: model.WorkflowNodeTextInput, Text: "制作视频"},
		{ID: "image", Type: model.WorkflowNodeImageGeneration, Config: &model.WorkflowNodeConfig{ProviderID: "frozen-image-provider", Resolution: "1k"}, Outputs: []model.WorkflowOutputSlot{{ID: "image-output", Type: model.WorkflowPortImage}}},
		{ID: "video", Type: model.WorkflowNodeVideoGeneration, Config: &model.WorkflowNodeConfig{ProviderID: "frozen-video-provider", Size: "16:9", Resolution: "720p", Seconds: &seconds}, Outputs: []model.WorkflowOutputSlot{{ID: "video-output", Type: model.WorkflowPortVideo}}},
	}, Connections: []model.WorkflowConnection{
		{SourceNodeID: "image-prompt", SourceSlotID: "output", TargetNodeID: "image", TargetPortID: "prompt", Order: 0},
		{SourceNodeID: "image", SourceSlotID: "image-output", TargetNodeID: "video", TargetPortID: "image", Order: 0},
		{SourceNodeID: "video-prompt", SourceSlotID: "output", TargetNodeID: "video", TargetPortID: "prompt", Order: 1},
	}}
	return seedWorkflowRunGraph(t, id, owner, graph)
}

func seedWorkflowRunGraph(t *testing.T, id, owner string, graph model.WorkflowGraph) model.WorkflowRun {
	t.Helper()
	snapshot, _ := json.Marshal(graph)
	current := time.Now().UTC().Add(-time.Hour)
	run := model.WorkflowRun{ID: id, OwnerUID: owner, RequestID: id + "-request", Snapshot: string(snapshot), Status: "pending", StateVersion: 1, CreatedAt: current, UpdatedAt: current}
	steps := []model.WorkflowStepExecution{}
	outputs := []model.WorkflowOutputExecution{}
	for _, node := range graph.Nodes {
		if node.Type != model.WorkflowNodeImageGeneration && node.Type != model.WorkflowNodeVideoGeneration {
			continue
		}
		steps = append(steps, model.WorkflowStepExecution{RunID: id, NodeID: node.ID, Status: "waiting"})
		for _, slot := range node.Outputs {
			outputs = append(outputs, model.WorkflowOutputExecution{RunID: id, NodeID: node.ID, SlotID: slot.ID, Status: "waiting", Attempt: 1, UpdatedAt: current})
		}
	}
	if _, _, err := createWorkflowRunFixture(run, steps, outputs, nil); err != nil {
		t.Fatal(err)
	}
	return run
}

func seedWorkflowMember(t *testing.T, uid string, enabled bool) {
	t.Helper()
	database, _ := repository.DB()
	if err := database.Create(&model.PortalMember{UserUID: uid, DisplayName: uid, Enabled: enabled}).Error; err != nil {
		t.Fatal(err)
	}
}

func clearWorkflowRuntimeTables(t *testing.T) {
	t.Helper()
	database, _ := repository.DB()
	for _, item := range []any{&model.WorkflowOutputAttempt{}, &model.WorkflowOutputExecution{}, &model.WorkflowStepExecution{}, &model.WorkflowRun{}, &model.WorkflowMediaRef{}} {
		if err := database.Session(&gorm.Session{AllowGlobalUpdate: true}).Delete(item).Error; err != nil {
			t.Fatal(err)
		}
	}
}

func createWorkflowRunFixture(run model.WorkflowRun, steps []model.WorkflowStepExecution, outputs []model.WorkflowOutputExecution, _ []string) (model.WorkflowRun, bool, error) {
	database, err := repository.DB()
	if err != nil {
		return model.WorkflowRun{}, false, err
	}
	if run.WorkflowID == "" {
		run.WorkflowID = "fixture-workflow-" + run.ID
		run.Revision = 1
		graph := model.WorkflowGraph{}
		_ = json.Unmarshal([]byte(run.Snapshot), &graph)
		stamp := run.CreatedAt.UTC().Format(time.RFC3339Nano)
		definition := model.Workflow{ID: run.WorkflowID, OwnerUID: run.OwnerUID, Name: "Fixture", Graph: graph, Revision: run.Revision, CreatedAt: stamp, UpdatedAt: stamp}
		if err := database.Create(&definition).Error; err != nil {
			return model.WorkflowRun{}, false, err
		}
	}
	err = database.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&run).Error; err != nil {
			return err
		}
		if len(steps) > 0 {
			if err := tx.Create(&steps).Error; err != nil {
				return err
			}
		}
		if len(outputs) > 0 {
			return tx.Create(&outputs).Error
		}
		return nil
	})
	return run, err == nil, err
}

func TestWorkflowSchedulerStopsMissingReferenceWithoutCreatingTask(t *testing.T) {
	clearWorkflowRuntimeTables(t)
	oldConfig := config.Cfg
	config.Cfg.WorkflowEnabled = true
	oldCreate := workflowCreateImageTask
	t.Cleanup(func() { config.Cfg = oldConfig; workflowCreateImageTask = oldCreate })
	seedWorkflowMember(t, "missing-ref-owner", true)
	run := seedWorkflowImageRun(t, "missing-ref-run", "missing-ref-owner")
	calls := 0
	workflowCreateImageTask = func(context.Context, CreateImageTaskRequest) (ImageTaskView, error) {
		calls++
		return ImageTaskView{}, fmt.Errorf("wrapped: %w", safeMessageError{message: "参考图片文件不存在，请重新上传或替换图片后重新运行"})
	}
	for i := 0; i < 3; i++ {
		if _, err := RunWorkflowSchedulerOnce(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	record, _, _ := repository.GetWorkflowRun(run.OwnerUID, run.ID)
	if calls != 1 || record.Run.Status != "failed" || record.Attempts[0].TaskID != "" || !strings.Contains(record.Outputs[0].Error, "参考图片文件不存在") {
		t.Fatalf("calls=%d record=%#v", calls, record)
	}
}

func TestWorkflowSchedulerBoundsLocalCreateRetriesAcrossRestartAndKeepsRequestID(t *testing.T) {
	clearWorkflowRuntimeTables(t)
	oldConfig := config.Cfg
	config.Cfg.WorkflowEnabled = true
	oldCreate := workflowCreateImageTask
	t.Cleanup(func() { config.Cfg = oldConfig; workflowCreateImageTask = oldCreate })
	seedWorkflowMember(t, "deadline-owner", true)
	run := seedWorkflowImageRun(t, "deadline-run", "deadline-owner")
	calls := 0
	workflowCreateImageTask = func(ctx context.Context, request CreateImageTaskRequest) (ImageTaskView, error) {
		calls++
		if _, ok := ctx.Deadline(); !ok {
			t.Fatal("submission has no timeout")
		}
		return ImageTaskView{}, errors.New("temporary failure")
	}
	if _, err := RunWorkflowSchedulerOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	record, _, _ := repository.GetWorkflowRun(run.OwnerUID, run.ID)
	firstID := record.Attempts[0].RequestID
	if record.Attempts[0].Error == "" {
		t.Fatal("transient failure was hidden")
	}
	database, _ := repository.DB()
	if err := database.Model(&model.WorkflowOutputAttempt{}).Where("run_id = ?", run.ID).Updates(map[string]any{"created_at": time.Now().UTC().Add(-2 * time.Minute), "next_poll_at": time.Now().UTC().Add(-time.Second)}).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := RunWorkflowSchedulerOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	record, _, _ = repository.GetWorkflowRun(run.OwnerUID, run.ID)
	if calls != 1 || record.Run.Status != "failed" || record.Attempts[0].RequestID != firstID || !strings.Contains(record.Outputs[0].Error, "超时") {
		t.Fatalf("calls=%d record=%#v", calls, record)
	}
}
