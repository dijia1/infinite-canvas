package service

import (
	"context"
	"encoding/json"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/ai"
	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

type drainingProvider struct {
	started   chan struct{}
	release   chan struct{}
	cancelled atomic.Bool
	calls     atomic.Int32
}

func (p *drainingProvider) await(ctx context.Context) {
	p.calls.Add(1)
	close(p.started)
	select {
	case <-p.release:
	case <-ctx.Done():
		p.cancelled.Store(true)
	}
}
func (p *drainingProvider) CreateImageTask(context.Context, ai.ImageTaskRequest) (ai.ImageTask, error) {
	return ai.ImageTask{}, errors.New("must not resubmit")
}
func (p *drainingProvider) SummarizeImageTaskRequest(ai.ImageTaskRequest) (ai.ImageTaskRequestSummary, error) {
	return ai.ImageTaskRequestSummary{}, nil
}
func (p *drainingProvider) GetImageTask(ctx context.Context, _ string) (ai.ImageTask, error) {
	p.await(ctx)
	return ai.ImageTask{Status: ai.ImageTaskStatusFailed, Error: "fixture terminal result"}, nil
}
func (p *drainingProvider) CreateVideo(context.Context, ai.VideoRequest) (ai.VideoTask, error) {
	return ai.VideoTask{}, errors.New("must not resubmit")
}
func (p *drainingProvider) GetVideo(ctx context.Context, _ string) (ai.VideoTask, error) {
	p.await(ctx)
	return ai.VideoTask{Status: "running"}, nil
}
func (p *drainingProvider) GetVideoContent(context.Context, string) (ai.VideoContent, error) {
	return ai.VideoContent{}, errors.New("unused")
}

func TestImageWorkerDrainRetainsLeaseAndCompletesCurrentProviderCall(t *testing.T) {
	workerShutdown.Store(false)
	t.Cleanup(func() { workerShutdown.Store(false) })
	p := &drainingProvider{started: make(chan struct{}), release: make(chan struct{})}
	kind := newID("drain-image-provider")
	if err := ai.Register(ai.ProviderType{ID: kind, Name: kind, Capabilities: []ai.Capability{ai.CapabilityImageGenerate}, New: func(json.RawMessage) (ai.Provider, error) { return p, nil }}); err != nil {
		t.Fatal(err)
	}
	db, _ := repository.DB()
	item := model.ImageGenerationTask{ID: newID("drain-image"), OwnerUID: newID("owner"), ClientRequestID: newID("request"), Mode: ImageTaskModeGeneration, Status: model.ImageTaskRunning, ProviderType: kind, ProviderTaskID: "original", ReferencesJSON: "[]", CreatedAt: "2000-01-01T00:00:00Z", UpdatedAt: now()}
	if err := db.Create(&item).Error; err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Delete(&model.ImageGenerationTask{}, "id = ?", item.ID) })
	before := config.Cfg.AITaskWorkerConcurrency
	config.Cfg.AITaskWorkerConcurrency = 1
	t.Cleanup(func() { config.Cfg.AITaskWorkerConcurrency = before })
	parent, cancel := context.WithCancel(context.Background())
	defer cancel()
	stop, err := StartImageTaskWorker(parent)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-p.started:
	case <-time.After(5 * time.Second):
		t.Fatal("provider not started")
	}
	claimed, _, _ := repository.GetImageGenerationTask(item.ID)
	BeginWorkerShutdown()
	done := make(chan struct{})
	go func() { stop(); stop(); close(done) }()
	// Actual 10-second lease heartbeat must continue throughout graceful drain.
	deadline := time.Now().Add(12 * time.Second)
	renewed := false
	for time.Now().Before(deadline) {
		stored, _, _ := repository.GetImageGenerationTask(item.ID)
		if stored.LeaseUntil != nil && stored.LeaseUntil.After(*claimed.LeaseUntil) {
			renewed = true
			break
		}
		select {
		case <-done:
			t.Fatal("worker stopped while provider active")
		default:
		}
		time.Sleep(50 * time.Millisecond)
	}
	close(p.release)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("worker did not finish")
	}
	if !renewed || p.cancelled.Load() || p.calls.Load() != 1 {
		t.Fatalf("renewed=%t cancelled=%t calls=%d", renewed, p.cancelled.Load(), p.calls.Load())
	}
	stored, _, _ := repository.GetImageGenerationTask(item.ID)
	if stored.ProviderTaskID != "original" || stored.ClaimID != "" {
		t.Fatal("original provider task or claim release lost")
	}
}

func TestVideoWorkerDrainFinishesCurrentStepWithoutCancellingProvider(t *testing.T) {
	workerShutdown.Store(false)
	t.Cleanup(func() { workerShutdown.Store(false) })
	p := &drainingProvider{started: make(chan struct{}), release: make(chan struct{})}
	kind := newID("drain-video-provider")
	if err := ai.Register(ai.ProviderType{ID: kind, Name: kind, Capabilities: []ai.Capability{ai.CapabilityVideoGenerate}, New: func(json.RawMessage) (ai.Provider, error) { return p, nil }}); err != nil {
		t.Fatal(err)
	}
	db, _ := repository.DB()
	current := time.Now().UTC()
	item := model.VideoGenerationTask{ID: newID("drain-video"), OwnerUID: newID("owner"), ClientRequestID: newID("request"), Status: "running", ProviderType: kind, ProviderTaskID: "original", InputMediaIDsJSON: "[]", ResultMediaIDsJSON: "[]", ResultURLsJSON: "[]", NextPollAt: current, Deadline: current.Add(time.Hour)}
	if err := db.Create(&item).Error; err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Delete(&model.VideoGenerationTask{}, "id = ?", item.ID) })
	parent, cancel := context.WithCancel(context.Background())
	defer cancel()
	stop, err := StartVideoTaskWorker(parent)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-p.started:
	case <-time.After(5 * time.Second):
		t.Fatal("provider not started")
	}
	BeginWorkerShutdown()
	done := make(chan struct{})
	go func() { stop(); stop(); close(done) }()
	select {
	case <-done:
		t.Fatal("step abandoned")
	case <-time.After(50 * time.Millisecond):
	}
	close(p.release)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("worker did not finish")
	}
	if p.cancelled.Load() || p.calls.Load() != 1 {
		t.Fatal("current provider call cancelled or repeated")
	}
	var stored model.VideoGenerationTask
	db.First(&stored, "id = ?", item.ID)
	if stored.ProviderTaskID != "original" || stored.LeaseUntil != nil {
		t.Fatal("provider ID or claim release lost")
	}
}
