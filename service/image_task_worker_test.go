package service

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/ai"
	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

type recoveredSubmittingImageProvider struct {
	calls  int
	result ai.ImageTask
	err    error
}

type transientPollingImageProvider struct {
	createCalls int
	pollCalls   int
}

type terminalPollingImageProvider struct {
	pollCalls int
	task      ai.ImageTask
}

type synchronousImageProvider struct {
	createCalls int
	pollCalls   int
	task        ai.ImageTask
}

func (provider *synchronousImageProvider) CreateImageTask(context.Context, ai.ImageTaskRequest) (ai.ImageTask, error) {
	provider.createCalls++
	return provider.task, nil
}

func (provider *synchronousImageProvider) GetImageTask(context.Context, string) (ai.ImageTask, error) {
	provider.pollCalls++
	return ai.ImageTask{}, errors.New("must not poll a synchronous terminal result")
}

func (provider *synchronousImageProvider) SummarizeImageTaskRequest(ai.ImageTaskRequest) (ai.ImageTaskRequestSummary, error) {
	return ai.ImageTaskRequestSummary{}, nil
}

func (provider *terminalPollingImageProvider) CreateImageTask(context.Context, ai.ImageTaskRequest) (ai.ImageTask, error) {
	return ai.ImageTask{}, errors.New("must not create a replacement task")
}

func (provider *terminalPollingImageProvider) GetImageTask(context.Context, string) (ai.ImageTask, error) {
	provider.pollCalls++
	return provider.task, nil
}

func (provider *terminalPollingImageProvider) SummarizeImageTaskRequest(ai.ImageTaskRequest) (ai.ImageTaskRequestSummary, error) {
	return ai.ImageTaskRequestSummary{}, nil
}

func (provider *transientPollingImageProvider) CreateImageTask(context.Context, ai.ImageTaskRequest) (ai.ImageTask, error) {
	provider.createCalls++
	return ai.ImageTask{}, errors.New("must not create a replacement task")
}

func (provider *transientPollingImageProvider) GetImageTask(context.Context, string) (ai.ImageTask, error) {
	provider.pollCalls++
	return ai.ImageTask{}, errors.New("temporary provider query failure")
}

func (provider *transientPollingImageProvider) SummarizeImageTaskRequest(ai.ImageTaskRequest) (ai.ImageTaskRequestSummary, error) {
	return ai.ImageTaskRequestSummary{}, nil
}

func (provider *recoveredSubmittingImageProvider) CreateImageTask(context.Context, ai.ImageTaskRequest) (ai.ImageTask, error) {
	provider.calls++
	return provider.result, provider.err
}

func (provider *recoveredSubmittingImageProvider) GetImageTask(context.Context, string) (ai.ImageTask, error) {
	provider.calls++
	return ai.ImageTask{}, errors.New("must not poll without an upstream task")
}

func (provider *recoveredSubmittingImageProvider) SummarizeImageTaskRequest(ai.ImageTaskRequest) (ai.ImageTaskRequestSummary, error) {
	return ai.ImageTaskRequestSummary{}, nil
}

func TestImageTaskWorkerConcurrencyDefaultsAndRejectsInvalidValues(t *testing.T) {
	if value, err := parseImageTaskWorkerConcurrency(0); err != nil || value != 4 {
		t.Fatalf("parseImageTaskWorkerConcurrency(0) = %d, %v", value, err)
	}
	if value, err := parseImageTaskWorkerConcurrency(7); err != nil || value != 7 {
		t.Fatalf("parseImageTaskWorkerConcurrency(7) = %d, %v", value, err)
	}
	if _, err := parseImageTaskWorkerConcurrency(-1); err == nil {
		t.Fatal("negative worker concurrency must be rejected")
	}
}

func TestImageTaskTimeoutDefaultsAndRejectsInvalidValues(t *testing.T) {
	if value, err := parseImageTaskTimeout(""); err != nil || value != 3*time.Minute {
		t.Fatalf("parseImageTaskTimeout(empty) = %s, %v", value, err)
	}
	if value, err := parseImageTaskTimeout("10m"); err != nil || value != 10*time.Minute {
		t.Fatalf("parseImageTaskTimeout(10m) = %s, %v", value, err)
	}
	for _, input := range []string{"invalid", "0s", "-1s"} {
		if _, err := parseImageTaskTimeout(input); err == nil {
			t.Errorf("parseImageTaskTimeout(%q) must reject an invalid duration", input)
		}
	}
}

func TestMaintainImageTaskLeaseRenewsUntilTheTaskContextEnds(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	renewed := make(chan struct{}, 1)
	done := make(chan struct{})
	go func() {
		defer close(done)
		maintainImageTaskLease(ctx, time.Millisecond, func() (bool, error) {
			select {
			case renewed <- struct{}{}:
			default:
			}
			return true, nil
		})
	}()

	select {
	case <-renewed:
	case <-time.After(100 * time.Millisecond):
		t.Fatal("lease was not renewed while the task was active")
	}

	cancel()
	select {
	case <-done:
	case <-time.After(100 * time.Millisecond):
		t.Fatal("lease heartbeat did not stop when the task context ended")
	}
}

func TestImageTaskTerminalResultHandlesDirectURLsAndProviderFailures(t *testing.T) {
	urls, failure, terminal := imageTaskTerminalResult(ai.ImageTask{Status: "completed", ResultURLs: []string{"https://cdn.example.com/result.png"}})
	if !terminal || failure != nil || len(urls) != 1 {
		t.Fatalf("completed direct result = %#v, %v, %t", urls, failure, terminal)
	}

	for _, status := range []string{ai.ImageTaskStatusFailed} {
		urls, failure, terminal = imageTaskTerminalResult(ai.ImageTask{Status: status, Error: "上游拒绝"})
		if !terminal || failure == nil || len(urls) != 0 {
			t.Errorf("%s result = %#v, %v, %t", status, urls, failure, terminal)
		}
	}

	urls, failure, terminal = imageTaskTerminalResult(ai.ImageTask{Status: ai.ImageTaskStatusRunning})
	if terminal || failure != nil || len(urls) != 0 {
		t.Fatalf("running result = %#v, %v, %t", urls, failure, terminal)
	}
}

func TestImageTaskWorkerPersistsReturnedProviderIDBeforeTerminalHandling(t *testing.T) {
	imageServer := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "image/png")
		_, _ = response.Write(tinyPNG)
	}))
	t.Cleanup(imageServer.Close)

	for _, fixture := range []struct {
		name                string
		providerTaskID      string
		status              string
		errorMessage        string
		wantTaskStatus      model.ImageGenerationTaskStatus
		wantOperationStatus model.OperationStatus
		wantOperationError  string
	}{
		{name: "completed with provider ID", providerTaskID: "upstream-completed", status: ai.ImageTaskStatusCompleted, wantTaskStatus: model.ImageTaskSucceeded, wantOperationStatus: model.OperationStatusSuccess},
		{name: "failed with provider ID", providerTaskID: "upstream-failed", status: ai.ImageTaskStatusFailed, errorMessage: "上游拒绝", wantTaskStatus: model.ImageTaskFailed, wantOperationStatus: model.OperationStatusFailure, wantOperationError: "上游拒绝"},
		{name: "uncertain with provider ID", providerTaskID: "upstream-uncertain", status: ai.ImageTaskStatusUncertain, wantTaskStatus: model.ImageTaskUncertain, wantOperationStatus: model.OperationStatusSubmitted, wantOperationError: "供应商图片任务结果不完整，请核对任务，系统不会自动重复生成"},
		{name: "completed without provider ID", status: ai.ImageTaskStatusCompleted, wantTaskStatus: model.ImageTaskSucceeded, wantOperationStatus: model.OperationStatusSuccess},
		{name: "failed without provider ID", status: ai.ImageTaskStatusFailed, errorMessage: "同步生成失败", wantTaskStatus: model.ImageTaskFailed, wantOperationStatus: model.OperationStatusFailure, wantOperationError: "同步生成失败"},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			resultURLs := []string(nil)
			if fixture.status == ai.ImageTaskStatusCompleted {
				resultURLs = []string{imageServer.URL + "/result.png"}
			}
			provider := &synchronousImageProvider{task: ai.ImageTask{
				ID: fixture.providerTaskID, Status: fixture.status, Progress: 100,
				ResultURLs: resultURLs, Error: fixture.errorMessage,
			}}
			providerType := newID("synchronous-image-provider")
			if err := ai.Register(ai.ProviderType{
				ID: providerType, Name: providerType, Capabilities: []ai.Capability{ai.CapabilityImageGenerate},
				New: func(json.RawMessage) (ai.Provider, error) { return provider, nil },
			}); err != nil {
				t.Fatal(err)
			}

			leaseUntil := time.Now().UTC().Add(time.Minute)
			item := model.ImageGenerationTask{
				ID: newID("synchronous-image-task"), OwnerUID: newID("synchronous-owner"), ClientRequestID: newID("synchronous-request"),
				Mode: ImageTaskModeGeneration, Status: model.ImageTaskQueued, ProviderType: providerType,
				ReferencesJSON: "[]", RequestSummary: "{}", OperationLogID: newID("synchronous-operation"),
				ClaimID: newID("synchronous-claim"), LeaseUntil: &leaseUntil, CreatedAt: now(), UpdatedAt: now(),
			}
			operation := model.OperationLog{
				ID: item.OperationLogID, ActorUID: item.OwnerUID, Action: "image_generate", Status: model.OperationStatusSubmitted,
				TargetType: "image_generation", TargetID: item.ID, CreatedAt: time.Now().UTC(),
			}
			fixtureDB, fixtureErr := repository.DB()
			if fixtureErr != nil {
				t.Fatal(fixtureErr)
			}
			if err := fixtureDB.Create(&item).Error; err != nil {
				t.Fatalf("create image task fixture: %v", err)
			}
			if err := fixtureDB.Create(&operation).Error; err != nil {
				t.Fatalf("create operation fixture: %v", err)
			}
			t.Cleanup(func() {
				_ = repository.DeleteImageGenerationTask(item.ID)
				_ = fixtureDB.Delete(&model.OperationLog{}, "id = ?", operation.ID).Error
			})

			executeImageTask(context.Background(), item)

			stored, found, err := repository.GetImageGenerationTask(item.ID)
			if err != nil || !found {
				t.Fatalf("GetImageGenerationTask() = %#v, %t, %v", stored, found, err)
			}
			if stored.Status != fixture.wantTaskStatus || stored.ProviderTaskID != fixture.providerTaskID {
				t.Fatalf("terminal task = %#v, want status %q provider task ID %q", stored, fixture.wantTaskStatus, fixture.providerTaskID)
			}
			var storedOperation model.OperationLog
			if err := fixtureDB.First(&storedOperation, "id = ?", operation.ID).Error; err != nil {
				t.Fatalf("load operation: %v", err)
			}
			if storedOperation.Status != fixture.wantOperationStatus || storedOperation.ProviderTaskID != fixture.providerTaskID || storedOperation.ErrorMessage != fixture.wantOperationError {
				t.Fatalf("terminal operation = %#v, want status %q provider task ID %q error %q", storedOperation, fixture.wantOperationStatus, fixture.providerTaskID, fixture.wantOperationError)
			}
			if provider.createCalls != 1 || provider.pollCalls != 0 {
				t.Fatalf("provider calls = create %d poll %d, want create 1 poll 0", provider.createCalls, provider.pollCalls)
			}
		})
	}
}

func TestImageTaskWorkerPersistsNormalizedProviderFailure(t *testing.T) {
	provider := &terminalPollingImageProvider{task: ai.ImageTask{Status: ai.ImageTaskStatusFailed, Error: "提交内容违反平台政策"}}
	providerType := newID("terminal-image-provider")
	if err := ai.Register(ai.ProviderType{
		ID: providerType, Name: providerType, Capabilities: []ai.Capability{ai.CapabilityImageGenerate},
		New: func(json.RawMessage) (ai.Provider, error) { return provider, nil },
	}); err != nil {
		t.Fatal(err)
	}
	leaseUntil := time.Now().UTC().Add(time.Minute)
	item := model.ImageGenerationTask{
		ID: newID("terminal-image-task"), OwnerUID: newID("terminal-owner"), ClientRequestID: newID("terminal-request"),
		Mode: ImageTaskModeGeneration, Status: model.ImageTaskRunning, ProviderType: providerType, ProviderTaskID: "original-upstream-task",
		ReferencesJSON: "[]", OperationLogID: newID("terminal-operation"), ClaimID: "terminal-claim", LeaseUntil: &leaseUntil,
		CreatedAt: now(), UpdatedAt: now(),
	}
	fixtureDB, fixtureErr := repository.DB()
	if fixtureErr != nil {
		t.Fatal(fixtureErr)
	}
	operation := model.OperationLog{ID: item.OperationLogID, ActorUID: item.OwnerUID, Status: model.OperationStatusSubmitted, TargetType: "image_generation", TargetID: item.ID, CreatedAt: time.Now().UTC()}
	if err := fixtureDB.Create(&item).Error; err != nil {
		t.Fatalf("create image task fixture: %v", err)
	}
	if err := fixtureDB.Create(&operation).Error; err != nil {
		t.Fatalf("create operation fixture: %v", err)
	}
	t.Cleanup(func() {
		_ = repository.DeleteImageGenerationTask(item.ID)
		_ = fixtureDB.Delete(&model.OperationLog{}, "id = ?", operation.ID).Error
	})

	executeImageTask(context.Background(), item)

	stored, found, err := repository.GetImageGenerationTask(item.ID)
	if err != nil || !found {
		t.Fatalf("GetImageGenerationTask() = %#v, %t, %v", stored, found, err)
	}
	if provider.pollCalls != 1 || stored.Status != model.ImageTaskFailed || stored.ErrorMessage != "提交内容违反平台政策" || stored.FinishedAt == "" || stored.ClaimID != "" || stored.LeaseUntil != nil {
		t.Fatalf("failed task = %#v, poll calls = %d", stored, provider.pollCalls)
	}
	var storedOperation model.OperationLog
	if err := fixtureDB.First(&storedOperation, "id = ?", operation.ID).Error; err != nil {
		t.Fatalf("load operation: %v", err)
	}
	if storedOperation.Status != model.OperationStatusFailure || storedOperation.ErrorMessage != "提交内容违反平台政策" {
		t.Fatalf("failed operation = %#v", storedOperation)
	}
}

func TestImageTaskWorkerStopsPollingUnknownNormalizedStatus(t *testing.T) {
	provider := &terminalPollingImageProvider{task: ai.ImageTask{Status: ai.ImageTaskStatusUncertain}}
	providerType := newID("uncertain-image-provider")
	if err := ai.Register(ai.ProviderType{
		ID: providerType, Name: providerType, Capabilities: []ai.Capability{ai.CapabilityImageGenerate},
		New: func(json.RawMessage) (ai.Provider, error) { return provider, nil },
	}); err != nil {
		t.Fatal(err)
	}
	leaseUntil := time.Now().UTC().Add(time.Minute)
	item := model.ImageGenerationTask{
		ID: newID("uncertain-image-task"), OwnerUID: newID("uncertain-owner"), ClientRequestID: newID("uncertain-request"),
		Mode: ImageTaskModeGeneration, Status: model.ImageTaskRunning, ProviderType: providerType, ProviderTaskID: "original-upstream-task",
		ReferencesJSON: "[]", ClaimID: "uncertain-claim", LeaseUntil: &leaseUntil, CreatedAt: now(), UpdatedAt: now(),
	}
	fixtureDB, fixtureErr := repository.DB()
	if fixtureErr != nil {
		t.Fatal(fixtureErr)
	}
	if err := fixtureDB.Create(&item).Error; err != nil {
		t.Fatalf("create image task fixture: %v", err)
	}
	t.Cleanup(func() { _ = repository.DeleteImageGenerationTask(item.ID) })

	executeImageTask(context.Background(), item)

	stored, found, err := repository.GetImageGenerationTask(item.ID)
	if err != nil || !found || provider.pollCalls != 1 || stored.Status != model.ImageTaskUncertain || stored.ProviderTaskID != item.ProviderTaskID || stored.ClaimID != "" || stored.LeaseUntil != nil {
		t.Fatalf("uncertain task = %#v, found = %t, poll calls = %d, err = %v", stored, found, provider.pollCalls, err)
	}
}

func TestRecoveredSubmittingImageTaskWithoutProviderIDBecomesUncertainWithoutResubmission(t *testing.T) {
	provider := &recoveredSubmittingImageProvider{err: errors.New("must not resubmit")}
	providerType := newID("recovered-image-provider")
	if err := ai.Register(ai.ProviderType{
		ID: providerType, Name: providerType, Capabilities: []ai.Capability{ai.CapabilityImageGenerate},
		New: func(json.RawMessage) (ai.Provider, error) { return provider, nil },
	}); err != nil {
		t.Fatal(err)
	}
	leaseUntil := time.Now().UTC().Add(time.Minute)
	item := model.ImageGenerationTask{
		ID: newID("recovered-image-task"), OwnerUID: "recovered-owner", ClientRequestID: newID("recovered-request"),
		Mode: ImageTaskModeGeneration, Status: model.ImageTaskSubmitting, ProviderType: providerType,
		ReferencesJSON: "[]", ClaimID: "recovered-claim", LeaseUntil: &leaseUntil,
		CreatedAt: now(), UpdatedAt: now(),
	}
	fixtureDB, fixtureErr := repository.DB()
	if fixtureErr != nil {
		t.Fatal(fixtureErr)
	}
	if err := fixtureDB.Create(&item).Error; err != nil {
		t.Fatalf("create image task fixture: %v", err)
	}
	t.Cleanup(func() { _ = repository.DeleteImageGenerationTask(item.ID) })

	executeImageTask(context.Background(), item)

	stored, found, err := repository.GetImageGenerationTask(item.ID)
	if err != nil || !found {
		t.Fatalf("GetImageGenerationTask() = %#v, %t, %v", stored, found, err)
	}
	if provider.calls != 0 || stored.Status != model.ImageTaskUncertain || stored.ClaimID != "" || stored.LeaseUntil != nil {
		t.Fatalf("recovered task = %#v, provider calls = %d", stored, provider.calls)
	}
}

func TestImageTaskSubmissionErrorOrMissingProviderIDBecomesUncertain(t *testing.T) {
	for _, fixture := range []struct {
		name     string
		provider *recoveredSubmittingImageProvider
	}{
		{name: "submission error", provider: &recoveredSubmittingImageProvider{err: errors.New("connection reset")}},
		{name: "missing provider task ID", provider: &recoveredSubmittingImageProvider{result: ai.ImageTask{Status: "processing"}}},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			providerType := newID("uncertain-image-provider")
			if err := ai.Register(ai.ProviderType{
				ID: providerType, Name: providerType, Capabilities: []ai.Capability{ai.CapabilityImageGenerate},
				New: func(json.RawMessage) (ai.Provider, error) { return fixture.provider, nil },
			}); err != nil {
				t.Fatal(err)
			}
			leaseUntil := time.Now().UTC().Add(time.Minute)
			item := model.ImageGenerationTask{
				ID: newID("uncertain-image-task"), OwnerUID: "uncertain-owner", ClientRequestID: newID("uncertain-request"),
				Mode: ImageTaskModeGeneration, Status: model.ImageTaskQueued, ProviderType: providerType,
				ReferencesJSON: "[]", RequestSummary: "{}", ClaimID: "uncertain-claim", LeaseUntil: &leaseUntil,
				CreatedAt: now(), UpdatedAt: now(),
			}
			fixtureDB, fixtureErr := repository.DB()
			if fixtureErr != nil {
				t.Fatal(fixtureErr)
			}
			if err := fixtureDB.Create(&item).Error; err != nil {
				t.Fatalf("create image task fixture: %v", err)
			}
			t.Cleanup(func() { _ = repository.DeleteImageGenerationTask(item.ID) })

			executeImageTask(context.Background(), item)

			stored, found, err := repository.GetImageGenerationTask(item.ID)
			if err != nil || !found || stored.Status != model.ImageTaskUncertain || fixture.provider.calls != 1 {
				t.Fatalf("submitted task = %#v, found = %t, provider calls = %d, err = %v", stored, found, fixture.provider.calls, err)
			}
		})
	}
}

func TestImageTaskPollingFailureKeepsOriginalProviderTaskForRetry(t *testing.T) {
	provider := &transientPollingImageProvider{}
	providerType := newID("polling-image-provider")
	if err := ai.Register(ai.ProviderType{
		ID: providerType, Name: providerType, Capabilities: []ai.Capability{ai.CapabilityImageGenerate},
		New: func(json.RawMessage) (ai.Provider, error) { return provider, nil },
	}); err != nil {
		t.Fatal(err)
	}
	leaseUntil := time.Now().UTC().Add(time.Minute)
	item := model.ImageGenerationTask{
		ID: newID("polling-image-task"), OwnerUID: newID("polling-owner"), ClientRequestID: newID("polling-request"),
		Mode: ImageTaskModeGeneration, Status: model.ImageTaskRunning, ProviderType: providerType, ProviderTaskID: "original-upstream-task",
		ReferencesJSON: "[]", ClaimID: "polling-claim", LeaseUntil: &leaseUntil, CreatedAt: now(), UpdatedAt: now(),
	}
	fixtureDB, fixtureErr := repository.DB()
	if fixtureErr != nil {
		t.Fatal(fixtureErr)
	}
	if err := fixtureDB.Create(&item).Error; err != nil {
		t.Fatalf("create image task fixture: %v", err)
	}
	t.Cleanup(func() { _ = repository.DeleteImageGenerationTask(item.ID) })

	executeImageTask(context.Background(), item)
	stored, found, err := repository.GetImageGenerationTask(item.ID)
	if err != nil || !found || stored.Status != model.ImageTaskRunning || stored.ProviderTaskID != item.ProviderTaskID || stored.ClaimID != "" || stored.LeaseUntil == nil || stored.FinishedAt != "" {
		t.Fatalf("task after transient poll failure = %#v, found=%t, err=%v", stored, found, err)
	}
	if provider.createCalls != 0 || provider.pollCalls != 1 {
		t.Fatalf("provider calls after first poll: create=%d poll=%d", provider.createCalls, provider.pollCalls)
	}
	next, claimed, err := repository.ClaimNextImageGenerationTask(stored.LeaseUntil.Add(time.Millisecond), imageTaskLeaseDuration)
	if err != nil || !claimed || next.ID != item.ID {
		t.Fatalf("replacement claim = %#v, claimed=%t, err=%v", next, claimed, err)
	}
	executeImageTask(context.Background(), next)
	if provider.createCalls != 0 || provider.pollCalls != 2 {
		t.Fatalf("provider calls after retry: create=%d poll=%d", provider.createCalls, provider.pollCalls)
	}
}

func TestExpiredImageTaskWorkerCleansPreparedResultWithoutPublishingMedia(t *testing.T) {
	owner := newID("expired-result-owner")
	past := time.Now().UTC().Add(-time.Minute)
	item := model.ImageGenerationTask{
		ID: newID("expired-result-task"), OwnerUID: owner, ClientRequestID: newID("expired-result-request"),
		Status: model.ImageTaskRunning, ProviderTaskID: "expired-upstream", ClaimID: "expired-result-claim", LeaseUntil: &past,
		CreatedAt: now(), UpdatedAt: now(),
	}
	fixtureDB, fixtureErr := repository.DB()
	if fixtureErr != nil {
		t.Fatal(fixtureErr)
	}
	if err := fixtureDB.Create(&item).Error; err != nil {
		t.Fatalf("create image task fixture: %v", err)
	}
	t.Cleanup(func() { _ = repository.DeleteImageGenerationTask(item.ID) })

	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	completeImageTaskResults(canceled, item, nil, []ai.ImageResult{{Data: tinyPNG, ContentType: "image/png"}})

	database, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	var mediaCount int64
	if err := database.Model(&model.Media{}).Where("owner_uid = ?", owner).Count(&mediaCount).Error; err != nil {
		t.Fatal(err)
	}
	if mediaCount != 0 {
		t.Fatalf("expired worker published %d media rows", mediaCount)
	}
	stored, found, err := repository.GetImageGenerationTask(item.ID)
	if err != nil || !found || stored.Status != model.ImageTaskRunning || stored.ClaimID != item.ClaimID {
		t.Fatalf("expired task mutated = %#v, found=%t, err=%v", stored, found, err)
	}
	files := 0
	root := filepath.Join(config.Cfg.MediaLocalDir, "images", "private", "generated", owner)
	if err := filepath.WalkDir(root, func(_ string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if !entry.IsDir() {
			files++
		}
		return nil
	}); err != nil && !errors.Is(err, fs.ErrNotExist) {
		t.Fatal(err)
	}
	if files != 0 {
		t.Fatalf("expired worker left %d unpublished result objects", files)
	}
}
