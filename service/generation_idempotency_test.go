package service

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/ai"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/shopspring/decimal"
)

type generationIdempotencyProvider struct{}

type generationIdempotencyInputStore struct {
	mu      sync.Mutex
	objects map[string][]byte
	puts    int
	ready   chan struct{}
}

func newGenerationIdempotencyInputStore() *generationIdempotencyInputStore {
	return &generationIdempotencyInputStore{objects: map[string][]byte{}, ready: make(chan struct{})}
}

func (store *generationIdempotencyInputStore) Put(ctx context.Context, key string, data []byte, _ string) error {
	store.mu.Lock()
	store.objects[key] = append([]byte{}, data...)
	store.puts++
	if store.puts == 2 {
		close(store.ready)
	}
	ready := store.ready
	store.mu.Unlock()
	select {
	case <-ready:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (store *generationIdempotencyInputStore) Get(_ context.Context, key string) (io.ReadCloser, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	return io.NopCloser(strings.NewReader(string(store.objects[key]))), nil
}

func (store *generationIdempotencyInputStore) Delete(_ context.Context, key string) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	delete(store.objects, key)
	return nil
}

func (*generationIdempotencyInputStore) SignedURL(context.Context, string, string) (string, time.Time, error) {
	return "", time.Time{}, nil
}

func (*generationIdempotencyInputStore) PresignPut(context.Context, string, string) (string, time.Time, error) {
	return "", time.Time{}, errDirectUploadUnsupported
}

func (*generationIdempotencyInputStore) Head(context.Context, string) (imageObjectMetadata, error) {
	return imageObjectMetadata{}, errDirectUploadUnsupported
}

func (*generationIdempotencyInputStore) ReadPrefix(context.Context, string, int64) ([]byte, error) {
	return nil, errDirectUploadUnsupported
}

func (generationIdempotencyProvider) NormalizeImageTaskRequest(request ai.ImageTaskRequest) (ai.ImageTaskRequest, error) {
	request.Request.Quality = "provider-default"
	request.Request.Options = ai.ImageRequestOptions{"providerDefault": json.RawMessage(`true`)}
	return request, nil
}

func (generationIdempotencyProvider) SummarizeImageTaskRequest(ai.ImageTaskRequest) (ai.ImageTaskRequestSummary, error) {
	return ai.ImageTaskRequestSummary{Method: "POST", Endpoint: "/test"}, nil
}

func (generationIdempotencyProvider) CreateImageTask(context.Context, ai.ImageTaskRequest) (ai.ImageTask, error) {
	return ai.ImageTask{}, errors.New("not used")
}

func (generationIdempotencyProvider) GetImageTask(context.Context, string) (ai.ImageTask, error) {
	return ai.ImageTask{}, errors.New("not used")
}

func (generationIdempotencyProvider) CreateVideo(context.Context, ai.VideoRequest) (ai.VideoTask, error) {
	return ai.VideoTask{}, errors.New("not used")
}

func (generationIdempotencyProvider) GetVideo(context.Context, string) (ai.VideoTask, error) {
	return ai.VideoTask{}, errors.New("not used")
}

func (generationIdempotencyProvider) GetVideoContent(context.Context, string) (ai.VideoContent, error) {
	return ai.VideoContent{}, errors.New("not used")
}

func TestGenerationServicesReplayExactPayloadAndRejectChangedPayload(t *testing.T) {
	const providerType = "generation-idempotency-test"
	if _, found := ai.Type(providerType); !found {
		if err := ai.Register(ai.ProviderType{
			ID: providerType, Name: providerType,
			Capabilities: []ai.Capability{ai.CapabilityImageGenerate, ai.CapabilityVideoGenerate},
			New:          func(json.RawMessage) (ai.Provider, error) { return generationIdempotencyProvider{}, nil },
		}); err != nil {
			t.Fatal(err)
		}
	}
	previous, err := repository.GetSettings()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = repository.SaveSettings(previous, now())
	})
	provider := model.AIProvider{
		ID: "generation-idempotency-model", Name: "Idempotency Model", Type: providerType, Enabled: true,
		AspectRatios: []string{"16:9"},
		ImagePrices:  []model.ImageResolutionPrice{{Resolution: "1k", Amount: decimal.NewFromInt(1)}},
		VideoPrices:  []model.ImageResolutionPrice{{Resolution: "720p", Amount: decimal.NewFromInt(1)}},
		Config:       json.RawMessage(`{}`),
	}
	if _, err := repository.SaveSettings(model.Settings{AI: model.AISettings{
		Providers: []model.AIProvider{provider}, ImageProviderID: provider.ID, VideoProviderID: provider.ID,
	}}, now()); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(WithPortalUser(context.Background(), PortalUser{UID: "generation-idempotency-owner"}), 5*time.Second)
	defer cancel()
	database, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = database.Where("owner_uid = ?", "generation-idempotency-owner").Delete(&model.ImageGenerationTask{}).Error
		_ = database.Where("owner_uid = ?", "generation-idempotency-owner").Delete(&model.VideoGenerationTask{}).Error
		_ = database.Where("actor_uid = ?", "generation-idempotency-owner").Delete(&model.OperationLog{}).Error
	})

	imageRequest := CreateImageTaskRequest{
		ClientRequestID: "generation-idempotency-image", Mode: ImageTaskModeGeneration,
		Request: ai.ImageRequest{Prompt: "draw a forest", Count: 1, Resolution: "1k", OutputFormat: "jpeg", Background: "auto"},
	}
	image, err := CreateImageTask(ctx, imageRequest)
	if err != nil {
		t.Fatal(err)
	}
	hashRequest, err := normalizeImageTaskRequest(imageRequest)
	if err != nil {
		t.Fatal(err)
	}
	hashRequest.ProviderID = provider.ID
	expectedImageHash, err := imageTaskRequestHash(hashRequest)
	if err != nil {
		t.Fatal(err)
	}
	persistedImage, found, err := repository.GetImageGenerationTaskByClientRequest("generation-idempotency-owner", imageRequest.ClientRequestID)
	if err != nil || !found || persistedImage.RequestHash != expectedImageHash || persistedImage.Quality != "provider-default" {
		t.Fatalf("persisted image identity = %#v, found=%t, err=%v, expected hash=%s", persistedImage, found, err, expectedImageHash)
	}
	replayedImage, err := CreateImageTask(ctx, imageRequest)
	if err != nil || replayedImage.ID != image.ID {
		t.Fatalf("exact image replay = %#v, err=%v; original=%s", replayedImage, err, image.ID)
	}
	changedImage := imageRequest
	changedImage.Request.Prompt = "draw a mountain"
	if _, err := CreateImageTask(ctx, changedImage); !errors.Is(err, ErrGenerationRequestConflict) {
		t.Fatalf("changed image replay err=%v", err)
	}

	store := newGenerationIdempotencyInputStore()
	previousStoreFactory := taskInputStoreFactory
	taskInputStoreFactory = func() (imageStore, error) { return store, nil }
	t.Cleanup(func() { taskInputStoreFactory = previousStoreFactory })
	racingImageRequest := CreateImageTaskRequest{
		ClientRequestID: "generation-idempotency-image-race", Mode: ImageTaskModeGeneration,
		Request:    ai.ImageRequest{Prompt: "first payload", Count: 1, Resolution: "1k", OutputFormat: "jpeg", Background: "auto"},
		References: []ai.ImageReference{{Name: "reference.png", ContentType: "image/png", Data: tinyPNG}},
	}
	racingResults := make(chan error, 2)
	for _, prompt := range []string{"first payload", "second payload"} {
		request := racingImageRequest
		request.Request.Prompt = prompt
		go func() {
			_, err := CreateImageTask(ctx, request)
			racingResults <- err
		}()
	}
	var succeeded, conflicted int
	for range 2 {
		switch err := <-racingResults; {
		case err == nil:
			succeeded++
		case errors.Is(err, ErrGenerationRequestConflict):
			conflicted++
		default:
			t.Fatalf("concurrent image create err=%v", err)
		}
	}
	if succeeded != 1 || conflicted != 1 {
		t.Fatalf("concurrent image results succeeded=%d conflicted=%d", succeeded, conflicted)
	}
	racingTask, found, err := repository.GetImageGenerationTaskByClientRequest("generation-idempotency-owner", racingImageRequest.ClientRequestID)
	if err != nil || !found {
		t.Fatalf("concurrent image winner = %#v, found=%t, err=%v", racingTask, found, err)
	}
	var winnerInputs []ImageTaskInput
	if err := json.Unmarshal([]byte(racingTask.ReferencesJSON), &winnerInputs); err != nil || len(winnerInputs) != 1 {
		t.Fatalf("winner inputs = %#v, err=%v", winnerInputs, err)
	}
	store.mu.Lock()
	_, winnerInputExists := store.objects[winnerInputs[0].ObjectKey]
	remainingInputs := len(store.objects)
	store.mu.Unlock()
	if !winnerInputExists || remainingInputs != 1 {
		t.Fatalf("temporary input cleanup kept winner=%t remaining=%d", winnerInputExists, remainingInputs)
	}

	videoRequest := CreateVideoTaskRequest{
		ClientRequestID: "generation-idempotency-video", Prompt: "animate a forest",
		Seconds: 5, Size: "16:9", Resolution: "720p",
	}
	normalizedVideo, err := normalizeVideoTaskRequest(videoRequest)
	if err != nil {
		t.Fatal(err)
	}
	normalizedVideo.ProviderID = provider.ID
	videoHash, err := videoTaskRequestHash(normalizedVideo)
	if err != nil {
		t.Fatal(err)
	}
	videoItem := model.VideoGenerationTask{
		ID: "generation-idempotency-video-task", OwnerUID: "generation-idempotency-owner",
		ClientRequestID: videoRequest.ClientRequestID, RequestHash: videoHash, Status: "queued",
		ProviderID: provider.ID, ProviderName: provider.Name, ProviderType: provider.Type, ProviderConfig: string(provider.Config),
		InputMediaIDsJSON: "[]", ResultMediaIDsJSON: "[]", ResultURLsJSON: "[]", OperationLogID: "generation-idempotency-video-operation",
	}
	if _, err := repository.CreateVideoGenerationTask(videoItem, model.OperationLog{
		ID: videoItem.OperationLogID, ActorUID: videoItem.OwnerUID, Status: model.OperationStatusSubmitted,
	}, nil); err != nil {
		t.Fatal(err)
	}
	video, err := CreateVideoGenerationTask(ctx, videoRequest)
	if err != nil {
		t.Fatal(err)
	}
	replayedVideo, err := CreateVideoGenerationTask(ctx, videoRequest)
	if err != nil || replayedVideo.ID != video.ID || video.ID != videoItem.ID {
		t.Fatalf("exact video replay = %#v, err=%v; original=%s", replayedVideo, err, video.ID)
	}
	changedVideo := videoRequest
	changedVideo.GenerateAudio = true
	if _, err := CreateVideoGenerationTask(ctx, changedVideo); !errors.Is(err, ErrGenerationRequestConflict) {
		t.Fatalf("changed video replay err=%v", err)
	}

	var imageTasks, videoTasks, operations int64
	if err := database.Model(&model.ImageGenerationTask{}).Where("owner_uid = ?", "generation-idempotency-owner").Count(&imageTasks).Error; err != nil {
		t.Fatal(err)
	}
	if err := database.Model(&model.VideoGenerationTask{}).Where("owner_uid = ?", "generation-idempotency-owner").Count(&videoTasks).Error; err != nil {
		t.Fatal(err)
	}
	if err := database.Model(&model.OperationLog{}).Where("actor_uid = ?", "generation-idempotency-owner").Count(&operations).Error; err != nil {
		t.Fatal(err)
	}
	if imageTasks != 2 || videoTasks != 1 || operations != 3 {
		t.Fatalf("service replays persisted image tasks=%d video tasks=%d operations=%d", imageTasks, videoTasks, operations)
	}
}

func TestGenerationServicesReplayHashedTaskBeforeCurrentMediaOrProviderValidation(t *testing.T) {
	const owner = "retired-generation-owner"
	previous, err := repository.GetSettings()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repository.SaveSettings(model.Settings{}, now()); err != nil {
		t.Fatal(err)
	}
	database, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = database.Where("owner_uid = ?", owner).Delete(&model.ImageGenerationTask{}).Error
		_ = database.Where("owner_uid = ?", owner).Delete(&model.VideoGenerationTask{}).Error
		_ = database.Where("actor_uid = ?", owner).Delete(&model.OperationLog{}).Error
		_, _ = repository.SaveSettings(previous, now())
	})
	ctx := WithPortalUser(context.Background(), PortalUser{UID: owner})

	imageRequest, err := normalizeImageTaskRequest(CreateImageTaskRequest{
		ClientRequestID: "retired-image-request", Mode: ImageTaskModeEdit,
		Request:           ai.ImageRequest{Prompt: "restore exact image", Count: 1, Resolution: "1k"},
		ReferenceMediaIDs: []string{"missing-retired-image"},
	})
	if err != nil {
		t.Fatal(err)
	}
	imageHashRequest := imageRequest
	imageHashRequest.ProviderID = "retired-image-provider"
	imageHash, err := imageTaskRequestHash(imageHashRequest)
	if err != nil {
		t.Fatal(err)
	}
	imageItem := model.ImageGenerationTask{
		ID: "retired-image-task", OwnerUID: owner, ClientRequestID: imageRequest.ClientRequestID,
		RequestHash: imageHash, Mode: imageRequest.Mode, Status: model.ImageTaskQueued,
		ProviderID: "retired-image-provider", ReferencesJSON: "[]", OperationLogID: "retired-image-operation",
	}
	if _, inserted, err := repository.CreateImageGenerationTaskWithOperationLog(imageItem, model.OperationLog{
		ID: imageItem.OperationLogID, ActorUID: owner, Status: model.OperationStatusSubmitted,
	}); err != nil || !inserted {
		t.Fatalf("seed retired image task inserted=%t, err=%v", inserted, err)
	}
	image, err := CreateImageTask(ctx, imageRequest)
	if err != nil || image.ID != imageItem.ID {
		t.Fatalf("retired image exact replay = %#v, err=%v", image, err)
	}
	changedImage := imageRequest
	changedImage.Request.Prompt = "changed image"
	if _, err := CreateImageTask(ctx, changedImage); !errors.Is(err, ErrGenerationRequestConflict) {
		t.Fatalf("retired image changed replay err=%v", err)
	}

	videoRequest, err := normalizeVideoTaskRequest(CreateVideoTaskRequest{
		ClientRequestID: "retired-video-request", Prompt: "restore exact video",
		Seconds: 5, Size: "16:9", Resolution: "720p", ImageMediaIDs: []string{"missing-retired-video-image"},
	})
	if err != nil {
		t.Fatal(err)
	}
	videoHashRequest := videoRequest
	videoHashRequest.ProviderID = "retired-video-provider"
	videoHash, err := videoTaskRequestHash(videoHashRequest)
	if err != nil {
		t.Fatal(err)
	}
	videoItem := model.VideoGenerationTask{
		ID: "retired-video-task", OwnerUID: owner, ClientRequestID: videoRequest.ClientRequestID,
		RequestHash: videoHash, Status: "queued", ProviderID: "retired-video-provider",
		InputMediaIDsJSON: `["missing-retired-video-image"]`, ResultMediaIDsJSON: "[]", ResultURLsJSON: "[]",
		OperationLogID: "retired-video-operation",
	}
	if _, err := repository.CreateVideoGenerationTask(videoItem, model.OperationLog{
		ID: videoItem.OperationLogID, ActorUID: owner, Status: model.OperationStatusSubmitted,
	}, nil); err != nil {
		t.Fatal(err)
	}
	video, err := CreateVideoGenerationTask(ctx, videoRequest)
	if err != nil || video.ID != videoItem.ID {
		t.Fatalf("retired video exact replay = %#v, err=%v", video, err)
	}
	changedVideo := videoRequest
	changedVideo.GenerateAudio = true
	if _, err := CreateVideoGenerationTask(ctx, changedVideo); !errors.Is(err, ErrGenerationRequestConflict) {
		t.Fatalf("retired video changed replay err=%v", err)
	}
}
