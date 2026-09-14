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
	imageTaskPollInterval   = 2 * time.Second
	defaultImageTaskTimeout = 3 * time.Minute
	imageTaskLeaseDuration  = 45 * time.Second
	imageTaskLeaseInterval  = 10 * time.Second
	imageTaskRetention      = 30 * 24 * time.Hour
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

func parseImageTaskTimeout(value string) (time.Duration, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return defaultImageTaskTimeout, nil
	}
	timeout, err := time.ParseDuration(value)
	if err != nil || timeout <= 0 {
		return 0, errors.New("AI_IMAGE_TASK_TIMEOUT 必须是大于 0 的有效时间，例如 10m")
	}
	return timeout, nil
}

// StartImageTaskWorker starts a bounded in-process worker pool. It holds no
// database transaction while contacting a provider or OSS, so polling does not
// occupy a database connection.
func StartImageTaskWorker(parent context.Context) (func(), error) {
	concurrency, err := parseImageTaskWorkerConcurrency(config.Cfg.AITaskWorkerConcurrency)
	if err != nil {
		return nil, err
	}
	timeout, err := parseImageTaskTimeout(config.Cfg.AIImageTaskTimeout)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(parent)
	var waitGroup sync.WaitGroup
	for index := 0; index < concurrency; index++ {
		waitGroup.Add(1)
		go func(workerID int) {
			defer waitGroup.Done()
			runImageTaskWorker(ctx, workerID, timeout)
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

func runImageTaskWorker(ctx context.Context, workerID int, timeout time.Duration) {
	for {
		if ctx.Err() != nil {
			return
		}
		item, claimed, err := repository.ClaimNextImageGenerationTask(time.Now().UTC(), imageTaskLeaseDuration)
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
		workerContext, cancel := context.WithTimeout(ctx, timeout)
		stopLease := startImageTaskLeaseHeartbeat(workerContext, item)
		executeImageTask(workerContext, item)
		stopLease()
		cancel()
	}
}

func startImageTaskLeaseHeartbeat(ctx context.Context, item model.ImageGenerationTask) func() {
	heartbeatContext, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		maintainImageTaskLease(heartbeatContext, imageTaskLeaseInterval, func() (bool, error) {
			return repository.RenewImageGenerationTaskLease(item, time.Now().UTC(), imageTaskLeaseDuration)
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
	providerTaskID := strings.TrimSpace(item.ProviderTaskID)
	if item.Status == model.ImageTaskSubmitting && providerTaskID == "" {
		markImageTaskUncertain(item, "图片提交结果不确定，请核对供应商任务，系统不会自动重复生成")
		return
	}
	inputs, err := imageTaskInputs(item)
	if err != nil {
		if providerTaskID == "" {
			failImageTask(ctx, item, err)
		} else {
			releaseImageTaskForRetry(item, "图片任务数据暂时不可用，系统将继续查询原任务")
		}
		return
	}
	provider, summarizer, err := imageTaskProvider(item)
	if err != nil {
		if providerTaskID == "" {
			failImageTask(ctx, item, err)
		} else {
			releaseImageTaskForRetry(item, "图片供应商暂时不可用，系统将继续查询原任务")
		}
		return
	}
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
			if err := repository.UpdateClaimedImageGenerationTask(item, map[string]any{"request_summary": item.RequestSummary, "updated_at": now()}); err != nil {
				failImageTask(ctx, item, err)
				return
			}
		}
		if err := repository.UpdateClaimedImageGenerationTask(item, map[string]any{"status": model.ImageTaskSubmitting, "updated_at": now()}); err != nil {
			log.Printf("image task %s enter submitting state failed: %v", item.ID, err)
			return
		}
		item.Status = model.ImageTaskSubmitting
		created, createErr := provider.CreateImageTask(ctx, providerRequest)
		if createErr != nil {
			markImageTaskUncertain(item, "图片提交结果不确定，请核对供应商任务，系统不会自动重复生成")
			return
		}
		providerTaskID = strings.TrimSpace(created.ID)
		if providerTaskID != "" {
			if err := repository.SetImageGenerationTaskProviderTaskID(item, providerTaskID, now()); err != nil {
				log.Printf("image task %s save provider task ID failed: %v", item.ID, err)
				return
			}
			item.ProviderTaskID = providerTaskID
			item.Status = model.ImageTaskRunning
		}
		if urls, failure, terminal := imageTaskTerminalResult(created); terminal {
			if failure != nil {
				if imageTaskProviderFailed(created) {
					failImageTask(ctx, item, failure)
				} else {
					markImageTaskUncertain(item, "供应商图片任务结果不完整，请核对任务，系统不会自动重复生成")
				}
				return
			}
			completeImageTask(ctx, item, inputs, urls)
			return
		}
		if providerTaskID == "" {
			markImageTaskUncertain(item, "供应商未返回图片任务 ID，请核对任务，系统不会自动重复生成")
			return
		}
		if err := repository.UpdateClaimedImageGenerationTask(item, map[string]any{"progress": clampTaskProgress(created.Progress), "updated_at": now()}); err != nil {
			log.Printf("image task %s save initial progress failed: %v", item.ID, err)
			return
		}
	}

	for {
		if ctx.Err() != nil {
			releaseImageTaskForRetry(item, "图片任务等待中断，系统将继续查询原任务")
			return
		}
		remote, pollErr := provider.GetImageTask(ctx, providerTaskID)
		if pollErr != nil {
			releaseImageTaskForRetry(item, "图片任务查询失败，系统将继续查询原任务")
			return
		}
		if urls, failure, terminal := imageTaskTerminalResult(remote); terminal {
			if failure != nil {
				if imageTaskProviderFailed(remote) {
					failImageTask(ctx, item, failure)
				} else if strings.ToLower(strings.TrimSpace(remote.Status)) == ai.ImageTaskStatusUncertain {
					markImageTaskUncertain(item, imageTaskFailureMessage(failure))
				} else {
					releaseImageTaskForRetry(item, "供应商图片结果不完整，系统将继续查询原任务")
				}
				return
			}
			completeImageTask(ctx, item, inputs, urls)
			return
		}
		if err := repository.UpdateClaimedImageGenerationTask(item, map[string]any{"status": model.ImageTaskRunning, "progress": clampTaskProgress(remote.Progress), "updated_at": now()}); err != nil {
			log.Printf("image task %s progress update failed: %v", item.ID, err)
			return
		}
		if !waitForImageTask(ctx, imageTaskPollInterval) {
			return
		}
	}
}

func imageTaskProviderFailed(task ai.ImageTask) bool {
	return strings.ToLower(strings.TrimSpace(task.Status)) == ai.ImageTaskStatusFailed
}

func imageTaskTerminalResult(task ai.ImageTask) ([]string, error, bool) {
	status := strings.ToLower(strings.TrimSpace(task.Status))
	switch status {
	case ai.ImageTaskStatusCompleted:
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
	case ai.ImageTaskStatusFailed:
		message := strings.TrimSpace(task.Error)
		if message == "" {
			message = "供应商任务失败"
		}
		return nil, safeMessageError{message: message}, true
	case ai.ImageTaskStatusPending, ai.ImageTaskStatusRunning:
		return nil, nil, false
	case ai.ImageTaskStatusUncertain:
		return nil, safeMessageError{message: "供应商返回未知任务状态，请核对原任务"}, true
	default:
		return nil, safeMessageError{message: "供应商返回不支持的任务状态，请核对原任务"}, true
	}
}

func completeImageTask(ctx context.Context, item model.ImageGenerationTask, inputs []ImageTaskInput, urls []string) {
	completeImageTaskResults(ctx, item, inputs, providerImageResults(urls))
}

func completeImageTaskResults(ctx context.Context, item model.ImageGenerationTask, inputs []ImageTaskInput, results []ai.ImageResult) {
	userContext := WithPortalUser(ctx, PortalUser{UID: item.OwnerUID})
	prepared, err := prepareImageTaskResultMedia(userContext, results)
	if err != nil {
		if strings.TrimSpace(item.ProviderTaskID) == "" {
			markImageTaskUncertain(item, "图片结果保存失败，请核对供应商任务，系统不会自动重复生成")
		} else {
			releaseImageTaskForRetry(item, "图片结果保存失败，系统将继续获取原任务结果")
		}
		return
	}
	if err := repository.CompleteImageGenerationTask(item, prepared.media); err != nil {
		prepared.cleanup(ctx)
		log.Printf("image task %s completion update failed: %v", item.ID, err)
		if !errors.Is(err, repository.ErrImageLeaseLost) {
			if strings.TrimSpace(item.ProviderTaskID) == "" {
				markImageTaskUncertain(item, "图片结果保存失败，请核对供应商任务，系统不会自动重复生成")
			} else {
				releaseImageTaskForRetry(item, "图片结果保存失败，系统将继续获取原任务结果")
			}
		}
		return
	}
	if err := DeleteImageTaskInputs(ctx, inputs); err != nil {
		log.Printf("image task %s input cleanup failed: %v", item.ID, err)
	}
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
	if err := repository.UpdateClaimedImageGenerationTask(item, map[string]any{
		"status": model.ImageTaskFailed, "error_message": message, "claim_id": "", "lease_until": nil, "updated_at": now(), "finished_at": now(),
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

func markImageTaskUncertain(item model.ImageGenerationTask, message string) {
	if err := repository.UpdateClaimedImageGenerationTask(item, map[string]any{
		"status": model.ImageTaskUncertain, "error_message": message, "claim_id": "", "lease_until": nil, "updated_at": now(),
	}); err != nil {
		log.Printf("image task %s uncertain update failed: %v", item.ID, err)
	}
}

func releaseImageTaskForRetry(item model.ImageGenerationTask, message string) {
	current := time.Now().UTC()
	if err := repository.UpdateClaimedImageGenerationTask(item, map[string]any{
		"status": model.ImageTaskRunning, "error_message": message, "claim_id": "", "lease_until": current.Add(imageTaskPollInterval), "updated_at": current.Format(time.RFC3339Nano),
	}); err != nil {
		log.Printf("image task %s release for retry failed: %v", item.ID, err)
	}
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
