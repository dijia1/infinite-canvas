package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/basketikun/infinite-canvas/ai"
	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

const (
	workflowAttemptLease         = 30 * time.Second
	workflowPollDelay            = time.Second
	workflowCreateRetryWindow    = time.Minute
	workflowCreateRequestTimeout = 20 * time.Second
	workflowCreateRetryDelay     = 10 * time.Second
)

var (
	workflowCreateImageTask = CreateImageTask
	workflowGetImageTask    = GetImageTaskByClientRequest
	workflowCreateVideoTask = CreateVideoGenerationTask
	workflowGetVideoTask    = GetVideoGenerationTaskByClient
	workflowRunScan         struct {
		sync.Mutex
		afterID string
	}
)

func workflowsEnabled() bool {
	return config.Cfg.WorkflowEnabled
}

func workflowConcurrency() (int, int) {
	global, perRun := config.Cfg.WorkflowGlobalConcurrency, config.Cfg.WorkflowRunConcurrency
	if global <= 0 {
		global = 4
	}
	if perRun <= 0 {
		perRun = 2
	}
	if perRun > global {
		perRun = global
	}
	return global, perRun
}

func StartWorkflowScheduler(ctx context.Context) (func(), error) {
	if _, err := repository.DB(); err != nil {
		return nil, err
	}
	workerContext, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(500 * time.Millisecond)
		defer ticker.Stop()
		for {
			if workerContext.Err() != nil || workersStopping() {
				return
			}
			if _, err := RunWorkflowSchedulerOnce(ctx); err != nil && !errors.Is(err, context.Canceled) {
				log.Printf("workflow scheduler failed: %v", err)
			}
			select {
			case <-workerContext.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	return func() { cancel(); <-done }, nil
}

// RunWorkflowSchedulerOnce is intentionally bounded so every pass releases DB
// leases quickly and another service instance can take over after a crash.
func RunWorkflowSchedulerOnce(ctx context.Context) (bool, error) {
	if ctx.Err() != nil || workersStopping() {
		return false, ctx.Err()
	}
	if err := reevaluateOpenWorkflowRuns(); err != nil {
		return false, err
	}
	global, perRun := workflowConcurrency()
	processed := false
	// A bounded batch services existing polls and then uses any remaining
	// capacity for ready outputs. Since every processed attempt is scheduled in
	// the future, one batch cannot immediately reclaim the same row.
	for count := 0; count < global*2; count++ {
		if ctx.Err() != nil || workersStopping() {
			return processed, ctx.Err()
		}
		attempt, found, err := repository.ClaimWorkflowAttempt(global, perRun, workflowsEnabled(), time.Now().UTC(), workflowAttemptLease)
		if err != nil {
			return processed, err
		}
		if !found {
			break
		}
		processed = true
		if err := processWorkflowAttempt(ctx, attempt); err != nil && !errors.Is(err, repository.ErrWorkflowLeaseLost) {
			return true, fmt.Errorf("workflow attempt run=%s node=%s slot=%s attempt=%d task=%s: %w", attempt.RunID, attempt.NodeID, attempt.SlotID, attempt.Attempt, attempt.TaskID, err)
		}
		if err := reevaluateWorkflowRun(attempt.OwnerUID, attempt.RunID); err != nil {
			return true, fmt.Errorf("workflow evaluation run=%s after node=%s slot=%s attempt=%d: %w", attempt.RunID, attempt.NodeID, attempt.SlotID, attempt.Attempt, err)
		}
	}
	return processed, nil
}

func reevaluateOpenWorkflowRuns() error {
	workflowRunScan.Lock()
	defer workflowRunScan.Unlock()
	runs, err := repository.ListOpenWorkflowRuns(workflowRunScan.afterID, 200)
	if err != nil {
		return err
	}
	if len(runs) == 0 && workflowRunScan.afterID != "" {
		workflowRunScan.afterID = ""
		runs, err = repository.ListOpenWorkflowRuns("", 200)
		if err != nil {
			return err
		}
	}
	if len(runs) > 0 {
		workflowRunScan.afterID = runs[len(runs)-1].ID
	}
	for _, run := range runs {
		if err := reevaluateWorkflowRun(run.OwnerUID, run.ID); err != nil {
			return fmt.Errorf("workflow evaluation run=%s: %w", run.ID, err)
		}
	}
	return nil
}

func reevaluateWorkflowRun(ownerUID, runID string) error {
	record, found, err := repository.GetWorkflowRun(ownerUID, runID)
	if err != nil || !found {
		return err
	}
	var graph model.WorkflowGraph
	if err := json.Unmarshal([]byte(record.Run.Snapshot), &graph); err != nil {
		return err
	}
	updates := []model.WorkflowOutputExecution{}
	for index := range record.Outputs {
		output := &record.Outputs[index]
		if output.Status != "waiting" && output.Status != "ready" && output.Status != "blocked" {
			continue
		}
		previousError := output.Error
		next := output.Status
		if record.Run.StopRequested {
			next = "stopped"
		} else {
			resolved, resolveErr := resolveWorkflowInputs(graph, output.NodeID, record.Outputs)
			switch {
			case resolveErr != nil:
				next, output.Error = "failed", resolveErr.Error()
			case resolved.State == "blocked":
				next, output.Error = "blocked", "上游输出失败"
			case resolved.State == "waiting":
				next, output.Error = "waiting", ""
			default:
				next, output.Error = "ready", ""
			}
		}
		if next != output.Status || output.Error != previousError {
			output.Status = next
			updates = append(updates, *output)
		}
	}
	steps := changedWorkflowSteps(record.Steps, aggregateWorkflowSteps(record.Run.ID, record.Outputs))
	status, finishedAt := aggregateWorkflowRun(record.Run, record.Outputs)
	if len(updates) == 0 && len(steps) == 0 && status == record.Run.Status {
		return nil
	}
	err = repository.UpdateWorkflowEvaluation(record.Run.ID, record.Run.StateVersion, updates, steps, status, finishedAt, time.Now().UTC())
	if errors.Is(err, repository.ErrWorkflowRunStale) {
		return nil
	}
	return err
}

func changedWorkflowSteps(current, next []model.WorkflowStepExecution) []model.WorkflowStepExecution {
	byNode := map[string]model.WorkflowStepExecution{}
	for _, step := range current {
		byNode[step.NodeID] = step
	}
	changed := []model.WorkflowStepExecution{}
	for _, step := range next {
		before, found := byNode[step.NodeID]
		if !found || before.Status != step.Status || before.Error != step.Error {
			changed = append(changed, step)
		}
	}
	return changed
}

func aggregateWorkflowSteps(runID string, outputs []model.WorkflowOutputExecution) []model.WorkflowStepExecution {
	grouped := map[string][]model.WorkflowOutputExecution{}
	for _, output := range outputs {
		grouped[output.NodeID] = append(grouped[output.NodeID], output)
	}
	steps := make([]model.WorkflowStepExecution, 0, len(grouped))
	for nodeID, slots := range grouped {
		status, firstError := "succeeded", ""
		for _, slot := range slots {
			if firstError == "" && slot.Error != "" {
				firstError = slot.Error
			}
			switch slot.Status {
			case "uncertain":
				status = "uncertain"
			case "submitting", "running":
				if status != "uncertain" {
					status = "running"
				}
			case "waiting", "ready":
				if status != "uncertain" && status != "running" {
					status = "waiting"
				}
			case "failed", "blocked":
				if status == "succeeded" {
					status = slot.Status
				}
			case "stopped":
				if status == "succeeded" {
					status = "stopped"
				}
			}
		}
		steps = append(steps, model.WorkflowStepExecution{RunID: runID, NodeID: nodeID, Status: status, Error: firstError})
	}
	return steps
}

func aggregateWorkflowRun(run model.WorkflowRun, outputs []model.WorkflowOutputExecution) (string, *time.Time) {
	if len(outputs) == 0 {
		current := time.Now().UTC()
		return "completed", &current
	}
	success, active, pending, uncertain := 0, 0, 0, 0
	for _, output := range outputs {
		switch output.Status {
		case "succeeded":
			success++
		case "submitting", "running":
			active++
		case "waiting", "ready":
			pending++
		case "uncertain":
			uncertain++
		}
	}
	if uncertain > 0 {
		return "attention_required", nil
	}
	if active > 0 || pending > 0 {
		if run.StopRequested {
			return "stopping", nil
		}
		return "running", nil
	}
	current := time.Now().UTC()
	if run.StopRequested {
		return "stopped", &current
	}
	if success == len(outputs) {
		return "completed", &current
	}
	if success > 0 {
		return "partially_completed", &current
	}
	return "failed", &current
}

func processWorkflowAttempt(ctx context.Context, attempt model.WorkflowOutputAttempt) error {
	record, found, err := repository.GetWorkflowRun(attempt.OwnerUID, attempt.RunID)
	if err != nil || !found {
		return err
	}
	var graph model.WorkflowGraph
	if err := json.Unmarshal([]byte(record.Run.Snapshot), &graph); err != nil {
		return failWorkflowAttempt(attempt, err)
	}
	if attempt.TaskID == "" && attempt.Status == "claimed" {
		authorized, err := repository.AuthorizeWorkflowAttemptSubmission(attempt, workflowsEnabled(), time.Now().UTC())
		if err != nil || !authorized {
			return err
		}
		attempt.Status = "submitting"
	}
	var node model.WorkflowNode
	for _, candidate := range graph.Nodes {
		if candidate.ID == attempt.NodeID {
			node = candidate
			break
		}
	}
	if node.ID == "" {
		return failWorkflowAttempt(attempt, fmt.Errorf("workflow generation node not found"))
	}
	if node.Type == model.WorkflowNodeVideoGeneration {
		return processWorkflowVideoAttempt(ctx, attempt, record, graph, node)
	}
	if node.Type != model.WorkflowNodeImageGeneration {
		return failWorkflowAttempt(attempt, fmt.Errorf("workflow node is not a generation step"))
	}
	userContext := WithPortalUser(ctx, PortalUser{UID: attempt.OwnerUID})
	var view ImageTaskView
	if attempt.TaskID == "" {
		if found, lookupErr := recoverWorkflowTask(&attempt, "image"); lookupErr != nil {
			return deferWorkflowAttempt(attempt)
		} else if found {
			view, err = workflowGetImageTask(userContext, attempt.RequestID)
			if err != nil {
				return deferWorkflowAttempt(attempt)
			}
			return applyWorkflowImageView(attempt, view)
		}
		resolved, err := workflowAttemptInputs(attempt, graph, node.ID, record.Outputs)
		if err != nil {
			return failWorkflowAttempt(attempt, err)
		}
		request, err := workflowImageRequest(node, resolved, attempt.RequestID)
		if err != nil {
			return failWorkflowAttempt(attempt, err)
		}
		submitContext, cancel := context.WithTimeout(userContext, workflowCreateRequestTimeout)
		view, err = workflowCreateImageTask(submitContext, request)
		cancel()
		if err != nil {
			return workflowTaskCreationError(attempt, "image", err)
		}
		attempt.TaskID, attempt.TaskType = view.ID, "image"
		logWorkflowAttempt(attempt, "submitted")
	} else {
		view, err = workflowGetImageTask(userContext, attempt.RequestID)
		if err != nil {
			return deferWorkflowAttempt(attempt)
		}
	}
	return applyWorkflowImageView(attempt, view)
}

func processWorkflowVideoAttempt(ctx context.Context, attempt model.WorkflowOutputAttempt, record repository.WorkflowRunRecord, graph model.WorkflowGraph, node model.WorkflowNode) error {
	userContext := WithPortalUser(ctx, PortalUser{UID: attempt.OwnerUID})
	var view VideoTaskView
	var err error
	if attempt.TaskID == "" {
		if found, lookupErr := recoverWorkflowTask(&attempt, "video"); lookupErr != nil {
			return deferWorkflowAttempt(attempt)
		} else if found {
			view, err = workflowGetVideoTask(userContext, attempt.RequestID)
			if err != nil {
				return deferWorkflowAttempt(attempt)
			}
			return applyWorkflowVideoView(attempt, view)
		}
		resolved, err := workflowAttemptInputs(attempt, graph, node.ID, record.Outputs)
		if err != nil {
			return failWorkflowAttempt(attempt, err)
		}
		request, err := workflowVideoRequest(node, resolved, attempt.RequestID)
		if err != nil {
			return failWorkflowAttempt(attempt, err)
		}
		submitContext, cancel := context.WithTimeout(userContext, workflowCreateRequestTimeout)
		view, err = workflowCreateVideoTask(submitContext, request)
		cancel()
		if err != nil {
			return workflowTaskCreationError(attempt, "video", err)
		}
		attempt.TaskID, attempt.TaskType = view.ID, "video"
		logWorkflowAttempt(attempt, "submitted")
	} else {
		view, err = workflowGetVideoTask(userContext, attempt.RequestID)
		if err != nil {
			return deferWorkflowAttempt(attempt)
		}
	}
	return applyWorkflowVideoView(attempt, view)
}

// Both task kinds recover durable creation by client request ID before retrying.
// Their request construction and result publication keep their own media rules.
func recoverWorkflowTask(attempt *model.WorkflowOutputAttempt, kind string) (bool, error) {
	var id string
	var found bool
	var err error
	if kind == "image" {
		var task model.ImageGenerationTask
		task, found, err = repository.GetImageGenerationTaskByClientRequest(attempt.OwnerUID, attempt.RequestID)
		id = task.ID
	} else {
		var task model.VideoGenerationTask
		task, found, err = repository.GetVideoGenerationTaskByClient(attempt.OwnerUID, attempt.RequestID)
		id = task.ID
	}
	if err == nil && found {
		attempt.TaskID, attempt.TaskType = id, kind
		logWorkflowAttempt(*attempt, "recovered")
	}
	return found, err
}

func workflowAttemptInputs(attempt model.WorkflowOutputAttempt, graph model.WorkflowGraph, nodeID string, outputs []model.WorkflowOutputExecution) (workflowResolvedInputs, error) {
	if attempt.Error != "" && workflowTaskCreationExpired(attempt, time.Now().UTC()) {
		return workflowResolvedInputs{}, safeMessageError{message: "创建生成任务超时，尚未提交供应商；请检查参考素材或网络后重试"}
	}
	if err := requireEnabledWorkflowMember(attempt.OwnerUID); err != nil {
		return workflowResolvedInputs{}, err
	}
	resolved, err := resolveWorkflowInputs(graph, nodeID, outputs)
	if err == nil && resolved.State != "ready" {
		err = fmt.Errorf("workflow inputs are no longer ready")
	}
	return resolved, err
}

func workflowTaskCreationError(attempt model.WorkflowOutputAttempt, kind string, cause error) error {
	if found, err := recoverWorkflowTask(&attempt, kind); err != nil || found {
		return deferWorkflowAttempt(attempt)
	}
	if _, safe := SafeMessage(cause); safe {
		return failWorkflowAttempt(attempt, cause)
	}
	return retryWorkflowTaskCreation(attempt, cause)
}

func deferWorkflowAttempt(attempt model.WorkflowOutputAttempt) error {
	if attempt.Status == "uncertain" {
		return persistWorkflowAttempt(attempt, "uncertain", time.Now().UTC().Add(5*workflowPollDelay), false, "")
	}
	outputStatus := "running"
	if attempt.TaskID == "" {
		attempt.Status = "submitting"
		outputStatus = "submitting"
	} else {
		attempt.Status = "running"
	}
	attempt.Error = ""
	return persistWorkflowAttempt(attempt, outputStatus, time.Now().UTC().Add(2*workflowPollDelay), false, "")
}

func workflowImageRequest(node model.WorkflowNode, inputs workflowResolvedInputs, requestID string) (CreateImageTaskRequest, error) {
	if node.Config == nil {
		return CreateImageTaskRequest{}, workflowValidationError{message: "图片节点配置无效"}
	}
	options := ai.ImageRequestOptions{}
	for key, value := range node.Config.Options {
		encoded, err := json.Marshal(value)
		if err != nil {
			return CreateImageTaskRequest{}, workflowValidationError{message: "图片节点参数无效"}
		}
		options[key] = encoded
	}
	mode := ImageTaskModeGeneration
	if len(inputs.ImageMediaIDs) > 0 {
		mode = ImageTaskModeEdit
	}
	return CreateImageTaskRequest{
		ClientRequestID: requestID, ProviderID: node.Config.ProviderID, Mode: mode,
		Request:           ai.ImageRequest{Prompt: inputs.Prompt, Count: 1, Quality: node.Config.Quality, Size: node.Config.Size, Resolution: node.Config.Resolution, OutputFormat: node.Config.OutputFormat, Background: node.Config.Background, Options: options},
		ReferenceMediaIDs: append([]string{}, inputs.ImageMediaIDs...),
	}, nil
}

func workflowVideoRequest(node model.WorkflowNode, inputs workflowResolvedInputs, requestID string) (CreateVideoTaskRequest, error) {
	if node.Config == nil || node.Config.Seconds == nil {
		return CreateVideoTaskRequest{}, workflowValidationError{message: "视频节点配置无效"}
	}
	generateAudio := false
	if node.Config.GenerateAudio != nil {
		generateAudio = *node.Config.GenerateAudio
	}
	return CreateVideoTaskRequest{
		ClientRequestID: requestID, ProviderID: node.Config.ProviderID, Prompt: inputs.Prompt,
		Seconds: *node.Config.Seconds, Size: node.Config.Size, Resolution: node.Config.Resolution, GenerateAudio: generateAudio,
		ImageMediaIDs: append([]string{}, inputs.ImageMediaIDs...), VideoMediaIDs: append([]string{}, inputs.VideoMediaIDs...),
	}, nil
}

func applyWorkflowImageView(attempt model.WorkflowOutputAttempt, view ImageTaskView) error {
	nextPoll := time.Now().UTC().Add(workflowPollDelay)
	switch view.Status {
	case string(model.ImageTaskSucceeded):
		if len(view.Images) != 1 || strings.TrimSpace(view.Images[0].MediaID) == "" {
			return failWorkflowAttempt(attempt, errors.New("image task succeeded without one persisted media result"))
		}
		attempt.Status, attempt.MediaID, attempt.Error = "succeeded", view.Images[0].MediaID, ""
		return persistWorkflowAttempt(attempt, "succeeded", nextPoll, true, "succeeded")
	case string(model.ImageTaskFailed):
		attempt.Status, attempt.Error = "failed", strings.TrimSpace(view.Error)
		if attempt.Error == "" {
			attempt.Error = "图片生成失败"
		}
		return persistWorkflowAttempt(attempt, "failed", nextPoll, true, "failed")
	case string(model.ImageTaskUncertain), string(model.ImageTaskPaused):
		attempt.Status, attempt.Error = "uncertain", strings.TrimSpace(view.Error)
		return persistWorkflowAttempt(attempt, "uncertain", time.Now().UTC().Add(5*time.Second), false, "uncertain")
	default:
		attempt.Status, attempt.Error = "running", ""
		return persistWorkflowAttempt(attempt, "running", nextPoll, false, "")
	}
}

func applyWorkflowVideoView(attempt model.WorkflowOutputAttempt, view VideoTaskView) error {
	nextPoll := time.Now().UTC().Add(workflowPollDelay)
	switch view.Status {
	case "succeeded":
		if len(view.ResultMediaIDs) != 1 || strings.TrimSpace(view.ResultMediaIDs[0]) == "" {
			return failWorkflowAttempt(attempt, errors.New("video task succeeded without one persisted media result"))
		}
		attempt.Status, attempt.MediaID, attempt.Error = "succeeded", view.ResultMediaIDs[0], ""
		return persistWorkflowAttempt(attempt, "succeeded", nextPoll, true, "succeeded")
	case "failed":
		attempt.Status, attempt.Error = "failed", strings.TrimSpace(view.Error)
		if attempt.Error == "" {
			attempt.Error = "视频生成失败"
		}
		return persistWorkflowAttempt(attempt, "failed", nextPoll, true, "failed")
	case "uncertain", "paused":
		attempt.Status, attempt.Error = "uncertain", strings.TrimSpace(view.Error)
		return persistWorkflowAttempt(attempt, "uncertain", time.Now().UTC().Add(5*time.Second), false, "uncertain")
	case "queued", "submitting", "running", "saving":
		attempt.Status, attempt.Error = "running", ""
		return persistWorkflowAttempt(attempt, "running", nextPoll, false, "")
	default:
		attempt.Status, attempt.Error = "uncertain", "视频任务状态需要确认"
		return persistWorkflowAttempt(attempt, "uncertain", time.Now().UTC().Add(5*time.Second), false, "uncertain")
	}
}

func failWorkflowAttempt(attempt model.WorkflowOutputAttempt, err error) error {
	log.Printf("workflow failure run=%s node=%s slot=%s attempt=%d task=%s category=%s", attempt.RunID, attempt.NodeID, attempt.SlotID, attempt.Attempt, attempt.TaskID, TaskErrorCategory(err))
	attempt.Status, attempt.Error = "failed", workflowAttemptError(err)
	return persistWorkflowAttempt(attempt, "failed", time.Now().UTC(), true, "failed")
}

func persistWorkflowAttempt(attempt model.WorkflowOutputAttempt, outputStatus string, nextPollAt time.Time, terminal bool, logStatus string) error {
	if err := repository.UpdateClaimedWorkflowAttempt(attempt, outputStatus, nextPollAt, terminal); err != nil {
		return fmt.Errorf("persist workflow attempt task=%s type=%s status=%s: %w", attempt.TaskID, attempt.TaskType, attempt.Status, err)
	}
	if logStatus != "" {
		logWorkflowAttempt(attempt, logStatus)
	}
	return nil
}

func logWorkflowAttempt(attempt model.WorkflowOutputAttempt, status string) {
	log.Printf("workflow attempt run=%s node=%s slot=%s attempt=%d task=%s type=%s status=%s", attempt.RunID, attempt.NodeID, attempt.SlotID, attempt.Attempt, attempt.TaskID, attempt.TaskType, status)
}

func workflowAttemptError(err error) string {
	if err == nil {
		return "生成失败"
	}
	var safe interface{ SafeMessage() string }
	if errors.As(err, &safe) {
		return safe.SafeMessage()
	}
	return "生成任务处理失败"
}

// The deadline is persisted implicitly by CreatedAt, so restarts cannot restart
// an endless submission loop. Call only after verifying no durable task exists.
func workflowTaskCreationExpired(attempt model.WorkflowOutputAttempt, current time.Time) bool {
	return attempt.TaskID == "" && !attempt.CreatedAt.IsZero() && current.Sub(attempt.CreatedAt) >= workflowCreateRetryWindow
}

func retryWorkflowTaskCreation(attempt model.WorkflowOutputAttempt, err error) error {
	if workflowTaskCreationExpired(attempt, time.Now().UTC()) {
		return failWorkflowAttempt(attempt, safeMessageError{message: "创建生成任务超时，尚未提交供应商；请检查参考素材或网络后重试"})
	}
	log.Printf("workflow create retry run=%s node=%s slot=%s attempt=%d request=%s category=%s", attempt.RunID, attempt.NodeID, attempt.SlotID, attempt.Attempt, attempt.RequestID, TaskErrorCategory(err))
	attempt.Status = "submitting"
	attempt.Error = "创建生成任务暂时失败，正在重试（最多等待 60 秒）"
	return persistWorkflowAttempt(attempt, "submitting", time.Now().UTC().Add(workflowCreateRetryDelay), false, "")
}
