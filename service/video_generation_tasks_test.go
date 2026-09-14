package service

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/basketikun/infinite-canvas/ai"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/shopspring/decimal"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestVideoRequestBoundariesAndPriceSnapshot(t *testing.T) {
	request := CreateVideoTaskRequest{ClientRequestID: "client", Prompt: "test", Seconds: 4, Size: "16:9", Resolution: "720p"}
	for _, seconds := range []int{4, 15} {
		request.Seconds = seconds
		if err := validateVideoTaskRequest(request); err != nil {
			t.Fatal(err)
		}
	}
	for _, seconds := range []int{0, 3, 16} {
		request.Seconds = seconds
		if err := validateVideoTaskRequest(request); err == nil {
			t.Fatal("invalid seconds accepted")
		}
	}
	request.Seconds = 5
	request.ImageMediaIDs = make([]string, 9)
	for i := range request.ImageMediaIDs {
		request.ImageMediaIDs[i] = "image"
	}
	request.VideoMediaIDs = []string{"v1", "v2", "v3"}
	if err := validateVideoTaskRequest(request); err != nil {
		t.Fatal(err)
	}
	request.ImageMediaIDs = append(request.ImageMediaIDs, "tenth")
	if err := validateVideoTaskRequest(request); err == nil {
		t.Fatal("ten images accepted")
	}
	request.ImageMediaIDs = nil
	request.VideoMediaIDs = append(request.VideoMediaIDs, "fourth")
	if err := validateVideoTaskRequest(request); err == nil {
		t.Fatal("four videos accepted")
	}
	provider := model.AIProvider{AspectRatios: []string{"16:9"}, VideoPrices: []model.ImageResolutionPrice{{Resolution: "720p", Amount: decimal.RequireFromString("0.1234")}}}
	amount, err := videoTaskAmount(provider, request)
	if err != nil || !amount.Equal(decimal.RequireFromString("0.617")) {
		t.Fatal(amount, err)
	}
	provider.VideoPrices[0].Amount = decimal.NewFromInt(9)
	if !amount.Equal(decimal.RequireFromString("0.617")) {
		t.Fatal("snapshot changed")
	}
	request.Size = "3:1"
	if _, err := videoTaskAmount(provider, request); err == nil {
		t.Fatal("unconfigured ratio accepted")
	}
}

func TestNormalizeAndHashVideoTaskRequestUsesStableOrderedIdentity(t *testing.T) {
	request, err := normalizeVideoTaskRequest(CreateVideoTaskRequest{ClientRequestID: " client ", ProviderID: " provider ", Prompt: " make it move ", Seconds: 5, Size: " 16:9 ", Resolution: " 720p ", GenerateAudio: true, ImageMediaIDs: []string{" image-a ", "image-b"}, VideoMediaIDs: []string{" video-a "}})
	if err != nil {
		t.Fatal(err)
	}
	if request.ClientRequestID != "client" || request.ProviderID != "provider" || request.Prompt != "make it move" || request.Size != "16:9" || request.Resolution != "720p" || request.ImageMediaIDs[0] != "image-a" || request.VideoMediaIDs[0] != "video-a" {
		t.Fatalf("normalized video request = %#v", request)
	}
	first, err := videoTaskRequestHash(request)
	if err != nil || len(first) != 64 {
		t.Fatalf("videoTaskRequestHash() = %q, %v", first, err)
	}
	equivalent := request
	equivalent.ClientRequestID = "another-client"
	if got, err := videoTaskRequestHash(equivalent); err != nil || got != first {
		t.Fatalf("equivalent video hash = %q, %v; want %q", got, err, first)
	}
	for name, mutate := range map[string]func(*CreateVideoTaskRequest){
		"provider": func(request *CreateVideoTaskRequest) { request.ProviderID = "provider-b" },
		"prompt":   func(request *CreateVideoTaskRequest) { request.Prompt = "different" },
		"audio":    func(request *CreateVideoTaskRequest) { request.GenerateAudio = false },
		"media order": func(request *CreateVideoTaskRequest) {
			request.ImageMediaIDs = []string{"image-b", "image-a"}
		},
	} {
		changed := request
		changed.ImageMediaIDs = append([]string{}, request.ImageMediaIDs...)
		changed.VideoMediaIDs = append([]string{}, request.VideoMediaIDs...)
		mutate(&changed)
		if got, err := videoTaskRequestHash(changed); err != nil || got == first {
			t.Errorf("%s video hash = %q, %v; want different from %q", name, got, err, first)
		}
	}
}

type workerVideoProvider struct {
	task  ai.VideoTask
	err   error
	calls *int
}

func (p workerVideoProvider) CreateVideo(context.Context, ai.VideoRequest) (ai.VideoTask, error) {
	*p.calls++
	return p.task, p.err
}
func (p workerVideoProvider) GetVideo(context.Context, string) (ai.VideoTask, error) {
	*p.calls++
	return p.task, p.err
}
func (p workerVideoProvider) GetVideoContent(context.Context, string) (ai.VideoContent, error) {
	return ai.VideoContent{}, errors.New("not used")
}
func seedWorkerVideo(t *testing.T, status string, p workerVideoProvider) (model.VideoGenerationTask, time.Time) {
	t.Helper()
	current := time.Now().UTC().Truncate(time.Microsecond)
	id := newID("video-test")
	typ := id + "-provider"
	if err := ai.Register(ai.ProviderType{ID: typ, Name: typ, Capabilities: []ai.Capability{ai.CapabilityVideoGenerate}, New: func(json.RawMessage) (ai.Provider, error) { return p, nil }}); err != nil {
		t.Fatal(err)
	}
	leaseUntil := current.Add(2 * time.Minute)
	item := model.VideoGenerationTask{ID: id, OwnerUID: "video-test-owner", ClientRequestID: id, Status: status, ProviderType: typ, ProviderTaskID: "upstream", InputMediaIDsJSON: "[]", ResultMediaIDsJSON: "[]", ResultURLsJSON: "[]", OperationLogID: id + "-op", NextPollAt: current, Deadline: current.Add(time.Hour), ClaimID: "claim", LeaseUntil: &leaseUntil}
	db, _ := repository.DB()
	if err := db.Create(&item).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.OperationLog{ID: item.OperationLogID, Status: model.OperationStatusSubmitted, CreatedAt: current}).Error; err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		db.Delete(&model.VideoGenerationTask{}, "id = ?", id)
		db.Delete(&model.OperationLog{}, "id = ?", item.OperationLogID)
	})
	return item, current
}
func readWorkerVideo(t *testing.T, item model.VideoGenerationTask) model.VideoGenerationTask {
	t.Helper()
	got, found, err := repository.GetVideoGenerationTask(item.ID, item.OwnerUID)
	if err != nil || !found {
		t.Fatal(err)
	}
	return got
}
func TestVideoWorkerPollSchedulesTwelveSecondsWithoutSleep(t *testing.T) {
	calls := 0
	item, current := seedWorkerVideo(t, "running", workerVideoProvider{task: ai.VideoTask{Status: "processing", Progress: 27}, calls: &calls})
	if err := processVideoTaskStep(context.Background(), item, current); err != nil {
		t.Fatal(err)
	}
	got := readWorkerVideo(t, item)
	if calls != 1 || got.Progress != 27 || !got.NextPollAt.Equal(current.Add(12*time.Second)) || got.LeaseUntil != nil {
		t.Fatalf("%+v calls=%d", got, calls)
	}
}
func TestVideoWorkerCrashDuringSubmissionNeverResubmits(t *testing.T) {
	calls := 0
	item, current := seedWorkerVideo(t, "submitting", workerVideoProvider{calls: &calls})
	item.ProviderTaskID = ""
	db, _ := repository.DB()
	db.Model(&item).Update("provider_task_id", "")
	if err := processVideoTaskStep(context.Background(), item, current); err != nil {
		t.Fatal(err)
	}
	got := readWorkerVideo(t, item)
	if calls != 0 || got.Status != "uncertain" {
		t.Fatal(got.Status, calls)
	}
}
func TestVideoWorkerDownloadFailurePausesAndResumesOriginalTask(t *testing.T) {
	calls := 0
	item, current := seedWorkerVideo(t, "saving", workerVideoProvider{calls: &calls})
	item.Attempts = 4
	if err := processVideoTaskStep(context.Background(), item, current); err != nil {
		t.Fatal(err)
	}
	got := readWorkerVideo(t, item)
	if got.Status != "paused" || got.ProviderTaskID != "upstream" || calls != 0 {
		t.Fatal(got.Status, calls)
	}
	if err := repository.ResumeVideoGenerationTask(item.ID, item.OwnerUID, current, time.Hour); err != nil {
		t.Fatal(err)
	}
	got = readWorkerVideo(t, item)
	if got.ProviderTaskID != "upstream" || got.Attempts != 0 {
		t.Fatal("resume lost upstream identity")
	}
}
func TestVideoWorkerCompletionPersistsSavingBeforeDownload(t *testing.T) {
	calls := 0
	item, current := seedWorkerVideo(t, "running", workerVideoProvider{task: ai.VideoTask{Status: "completed", ResultURLs: []string{"https://example.com/video.mp4"}, Cost: "0.50", Currency: "USD"}, calls: &calls})
	if err := processVideoTaskStep(context.Background(), item, current); err != nil {
		t.Fatal(err)
	}
	got := readWorkerVideo(t, item)
	if got.Status != "saving" || got.UpstreamCost != "0.50" || got.UpstreamCurrency != "USD" {
		t.Fatalf("%+v", got)
	}
}
func TestVideoWorkerTimeoutPreservesTaskID(t *testing.T) {
	calls := 0
	item, current := seedWorkerVideo(t, "running", workerVideoProvider{calls: &calls})
	item.Deadline = current
	if err := processVideoTaskStep(context.Background(), item, current); err != nil {
		t.Fatal(err)
	}
	got := readWorkerVideo(t, item)
	if got.Status != "paused" || calls != 0 || got.ProviderTaskID != "upstream" {
		t.Fatal(got.Status, calls)
	}
}

func TestVideoOutputReservationSurvivesInterruptedSave(t *testing.T) {
	calls := 0
	item, current := seedWorkerVideo(t, "saving", workerVideoProvider{calls: &calls})
	item.ResultURLsJSON = `["http://invalid.example/video.mp4"]`
	db, _ := repository.DB()
	if err := db.Model(&item).Update("result_urls_json", item.ResultURLsJSON).Error; err != nil {
		t.Fatal(err)
	}
	if err := processVideoTaskStep(context.Background(), item, current); err != nil {
		t.Fatal(err)
	}
	first := readWorkerVideo(t, item)
	if first.PendingOutputsJSON == "" {
		t.Fatal("object write had no durable reservation")
	}
	reclaimed, found, err := repository.ClaimNextVideoGenerationTask(current.Add(12 * time.Second))
	if err != nil || !found || reclaimed.ID != first.ID {
		t.Fatalf("reclaim interrupted save = %#v, %v, %v", reclaimed, found, err)
	}
	if err := processVideoTaskStep(context.Background(), reclaimed, current.Add(12*time.Second)); err != nil {
		t.Fatal(err)
	}
	second := readWorkerVideo(t, item)
	if first.PendingOutputsJSON != second.PendingOutputsJSON {
		t.Fatal("retry allocated new untracked output")
	}
}

func TestVideoProbeRealMP4(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not installed; exercised in runtime container")
	}
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe not installed")
	}
	path := filepath.Join(t.TempDir(), "sample.mp4")
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if output, err := exec.CommandContext(ctx, "ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=160x90:r=10", "-t", "4", "-c:v", "mpeg4", path).CombinedOutput(); err != nil {
		t.Fatalf("create fixture: %v %s", err, output)
	}
	duration, width, height, err := probeVideoFile(ctx, path)
	if err != nil || duration != 4 || width != 160 || height != 90 {
		t.Fatalf("probe=%f,%d,%d,%v", duration, width, height, err)
	}
	store, err := newImageStore()
	if err != nil {
		t.Fatal(err)
	}
	key := "video-probe-result.mp4"
	fixture, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Put(ctx, key, fixture, "video/mp4"); err != nil {
		t.Fatal(err)
	}
	defer store.Delete(ctx, key)
	outputs, _ := json.Marshal([]videoOutputReservation{{ID: "probe-result", ObjectKey: key}})
	results, err := saveVideoTaskResults(ctx, model.VideoGenerationTask{OwnerUID: "probe", ResultURLsJSON: `["https://expired.invalid/video.mp4"]`, PendingOutputsJSON: string(outputs)})
	if err != nil || len(results) != 1 || results[0].ID != "probe-result" {
		t.Fatalf("reserved result recovery: %+v %v", results, err)
	}
	invalid := filepath.Join(t.TempDir(), "invalid.mp4")
	if err := os.WriteFile(invalid, []byte("not a video"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := probeVideoFile(ctx, invalid); err == nil {
		t.Fatal("invalid MP4 accepted")
	}
}
