package service

import (
	"context"
	"encoding/json"
	"errors"
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
	imageTaskPollInterval  = 2 * time.Second
	imageTaskTimeout       = 3 * time.Minute
	imageTaskStaleAfter    = 45 * time.Second
	imageTaskLeaseInterval = 10 * time.Second
	imageTaskRetention     = 30 * 24 * time.Hour
)

func parseImageTaskWorkerConcurrency(value int) (int, error) {
	if value == 0 {
		return 4, nil
	}
	if value < 0 {
		return 0, errors.New("AI_TASK_WORKER_CONCURRENCY 必须大于 0")
	}
	return value, nil
}

// StartImageTaskWorker starts a bounded in-process worker pool. It holds no
// database transaction while contacting a provider or OSS, so polling does not
// occupy a database connection.
func StartImageTaskWorker(parent context.Context) (func(), error) {
	concurrency, err := parseImageTaskWorkerConcurrency(config.Cfg.AITaskWorkerConcurrency)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(parent)
	var waitGroup sync.WaitGroup
	for index := 0; index < concurrency; index++ {
		waitGroup.Add(1)
		go func(workerID int) {
			defer waitGroup.Done()
			runImageTaskWorker(ctx, workerID)
		}(index + 1)
	}
	waitGroup.Add(1)
	go func() {
		defer waitGroup.Done()
		runImageTaskRetention(ctx)
	}()
	var stopOnce sync.Once
	return func() {
		stopOnce.Do(func() {
			cancel()
			waitGroup.Wait()
		})
	}, nil
}

func runImageTaskWorker(ctx context.Context, workerID int) {
	for {
		if ctx.Err() != nil {
			return
		}
		item, claimed, err := repository.ClaimNextImageGenerationTask(time.Now().Add(-imageTaskStaleAfter).Format(time.RFC3339), now())
		if err != nil {
			log.Printf("image task worker %d claim failed: %v", workerID, err)
			if !waitForImageTask(ctx, time.Second) {
				return
			}
			continue
		}
		if !claimed {
			if !waitForImageTask(ctx, 500*time.Millisecond) {
				return
			}
			continue
		}
		workerContext, cancel := context.WithTimeout(ctx, imageTaskTimeout)
		stopLease := startImageTaskLeaseHeartbeat(workerContext, item.ID)
		executeImageTask(workerContext, item)
		stopLease()
		cancel()
	}
}

func startImageTaskLeaseHeartbeat(ctx context.Context, taskID string) func() {
	heartbeatContext, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		maintainImageTaskLease(heartbeatContext, imageTaskLeaseInterval, func() (bool, error) {
			return repository.RenewImageGenerationTaskLease(taskID, now())
		})
	}()
	return func() {
		cancel()
		<-done
	}
}

func maintainImageTaskLease(ctx context.Context, interval time.Duration, renew func() (bool, error)) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			renewed, err := renew()
			if err != nil {
				log.Printf("image task lease renewal failed: %v", err)
				continue
			}
			if !renewed {
				return
			}
		}
	}
}

func waitForImageTask(ctx context.Context, duration time.Duration) bool {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func executeImageTask(ctx context.Context, item model.ImageGenerationTask) {
	inputs, err := imageTaskInputs(item)
	if err != nil {
		failImageTask(ctx, item, err)
		return
	}
	provider, summarizer, err := imageTaskProvider(item)
	if err != nil {
		failImageTask(ctx, item, err)
		return
	}
	providerTaskID := strings.TrimSpace(item.ProviderTaskID)
	if providerTaskID == "" {
		loaded, readErr := ReadImageTaskInputs(ctx, inputs)
		if readErr != nil {
			failImageTask(ctx, item, readErr)
			return
		}
		providerRequest := ai.ImageTaskRequest{Request: imageTaskRequest(item), References: loaded.References, Mask: loaded.Mask}
		if strings.TrimSpace(item.RequestSummary) == "" {
			summary, summaryErr := summarizer.SummarizeImageTaskRequest(providerRequest)
			if summaryErr != nil {
				failImageTask(ctx, item, summaryErr)
				return
			}
			encoded, encodeErr := json.Marshal(summary)
			if encodeErr != nil {
				failImageTask(ctx, item, encodeErr)
				return
			}
			item.RequestSummary = string(encoded)
			if err := repository.UpdateImageGenerationTask(item.ID, map[string]any{"request_summary": item.RequestSummary, "updated_at": now()}); err != nil {
				failImageTask(ctx, item, err)
				return
			}
		}
		created, createErr := provider.CreateImageTask(ctx, providerRequest)
		if createErr != nil {
			failImageTask(ctx, item, createErr)
			return
		}
		if urls, failure, terminal := imageTaskTerminalResult(created); terminal {
			if failure != nil {
				failImageTask(ctx, item, failure)
				return
			}
			completeImageTask(ctx, item, inputs, urls)
			return
		}
		providerTaskID = strings.TrimSpace(created.ID)
		if providerTaskID == "" {
			failImageTask(ctx, item, errors.New("供应商未返回任务 ID"))
			return
		}
		if err := repository.UpdateImageGenerationTask(item.ID, map[string]any{"provider_task_id": providerTaskID, "status": model.ImageTaskRunning, "progress": clampTaskProgress(created.Progress), "updated_at": now()}); err != nil {
			log.Printf("image task %s save provider task ID failed: %v", item.ID, err)
			return
		}
		item.ProviderTaskID = providerTaskID
	}

	for {
		if ctx.Err() != nil {
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				failImageTask(context.Background(), item, errors.New("图片生成超时"))
			}
			return
		}
		remote, pollErr := provider.GetImageTask(ctx, providerTaskID)
		if pollErr != nil {
			failImageTask(ctx, item, pollErr)
			return
		}
		if urls, failure, terminal := imageTaskTerminalResult(remote); terminal {
			if failure != nil {
				failImageTask(ctx, item, failure)
				return
			}
			completeImageTask(ctx, item, inputs, urls)
			return
		}
		if err := repository.UpdateImageGenerationTask(item.ID, map[string]any{"status": model.ImageTaskRunning, "progress": clampTaskProgress(remote.Progress), "updated_at": now()}); err != nil {
			log.Printf("image task %s progress update failed: %v", item.ID, err)
			return
		}
		if !waitForImageTask(ctx, imageTaskPollInterval) {
			return
		}
	}
}

func imageTaskTerminalResult(task ai.ImageTask) ([]string, error, bool) {
	status := strings.ToLower(strings.TrimSpace(task.Status))
	switch status {
	case "completed", "succeeded", "success":
		urls := make([]string, 0, len(task.ResultURLs))
		for _, url := range task.ResultURLs {
			if url = strings.TrimSpace(url); url != "" {
				urls = append(urls, url)
			}
		}
		if len(urls) == 0 {
			return nil, errors.New("供应商任务完成但未返回图片"), true
		}
		return urls, nil, true
	case "failed", "error", "cancelled", "canceled", "violated", "rejected":
		message := strings.TrimSpace(task.Error)
		if message == "" {
			message = "供应商任务失败"
		}
		return nil, safeMessageError{message: message}, true
	default:
		return nil, nil, false
	}
}

func completeImageTask(ctx context.Context, item model.ImageGenerationTask, inputs []ImageTaskInput, urls []string) {
	userContext := WithPortalUser(ctx, PortalUser{UID: item.OwnerUID})
	images, err := persistGeneratedImages(userContext, providerImageResults(urls))
	if err != nil {
		failImageTask(ctx, item, err)
		return
	}
	mediaIDs := make([]string, 0, len(images))
	for _, image := range images {
		if strings.TrimSpace(image.MediaID) != "" {
			mediaIDs = append(mediaIDs, image.MediaID)
		}
	}
	if len(mediaIDs) == 0 {
		failImageTask(ctx, item, errors.New("生成图片保存失败"))
		return
	}
	encoded, err := json.Marshal(mediaIDs)
	if err != nil {
		failImageTask(ctx, item, err)
		return
	}
	if err := repository.UpdateImageGenerationTask(item.ID, map[string]any{
		"status": model.ImageTaskSucceeded, "progress": 100, "result_media_ids_json": string(encoded), "error_message": "", "updated_at": now(), "finished_at": now(),
	}); err != nil {
		log.Printf("image task %s completion update failed: %v", item.ID, err)
		return
	}
	if err := DeleteImageTaskInputs(ctx, inputs); err != nil {
		log.Printf("image task %s input cleanup failed: %v", item.ID, err)
	}
	updateImageTaskOperationLog(item, model.OperationStatusSuccess, mediaIDs, "")
}

func providerImageResults(urls []string) []ai.ImageResult {
	images := make([]ai.ImageResult, 0, len(urls))
	for _, url := range urls {
		if url = strings.TrimSpace(url); url != "" {
			images = append(images, ai.ImageResult{URL: url})
		}
	}
	return images
}

func failImageTask(ctx context.Context, item model.ImageGenerationTask, reason error) {
	message := imageTaskFailureMessage(reason)
	if err := repository.UpdateImageGenerationTask(item.ID, map[string]any{
		"status": model.ImageTaskFailed, "error_message": message, "updated_at": now(), "finished_at": now(),
	}); err != nil {
		log.Printf("image task %s failure update failed: %v", item.ID, err)
		return
	}
	inputs, inputErr := imageTaskInputs(item)
	if inputErr == nil {
		if err := DeleteImageTaskInputs(ctx, inputs); err != nil {
			log.Printf("image task %s input cleanup failed: %v", item.ID, err)
		}
	}
	updateImageTaskOperationLog(item, model.OperationStatusFailure, nil, message)
}

func updateImageTaskOperationLog(item model.ImageGenerationTask, status model.OperationStatus, mediaIDs []string, errorMessage string) {
	if strings.TrimSpace(item.OperationLogID) == "" {
		return
	}
	if err := repository.UpdateOperationLog(item.OperationLogID, map[string]any{
		"status":        status,
		"media_ids":     append([]string{}, mediaIDs...),
		"error_message": safeAuditError(errorMessage),
	}); err != nil {
		log.Printf("image task %s operation log update failed: %v", item.ID, err)
	}
}

func imageTaskFailureMessage(err error) string {
	if err == nil {
		return "图片生成失败"
	}
	if safe, ok := err.(interface{ SafeMessage() string }); ok {
		if message := strings.TrimSpace(safe.SafeMessage()); message != "" {
			return message
		}
	}
	return "图片生成失败"
}

func imageTaskAction(item model.ImageGenerationTask) string {
	if item.Mode == ImageTaskModeEdit {
		return "image_edit"
	}
	return "image_generate"
}

func clampTaskProgress(value int) int {
	if value < 0 {
		return 0
	}
	if value > 100 {
		return 100
	}
	return value
}

func runImageTaskRetention(ctx context.Context) {
	cleanupImageTasks(time.Now())
	ticker := time.NewTicker(24 * time.Hour)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case current := <-ticker.C:
			cleanupImageTasks(current)
		}
	}
}

func cleanupImageTasks(current time.Time) {
	items, err := repository.ListExpiredTerminalImageGenerationTasks(current.Add(-imageTaskRetention).Format(time.RFC3339))
	if err != nil {
		log.Printf("image task retention query failed: %v", err)
		return
	}
	for _, item := range items {
		inputs, inputErr := imageTaskInputs(item)
		if inputErr == nil {
			if err := DeleteImageTaskInputs(context.Background(), inputs); err != nil {
				log.Printf("image task %s retention input cleanup failed: %v", item.ID, err)
				continue
			}
		}
		if err := repository.DeleteImageGenerationTask(item.ID); err != nil {
			log.Printf("image task %s retention delete failed: %v", item.ID, err)
		}
	}
}
