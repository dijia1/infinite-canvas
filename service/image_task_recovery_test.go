package service

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/ai"
	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

type recoveryImageProvider struct {
	transientPollingImageProvider
	query func(context.Context, string) (ai.ImageTask, error)
}

func (provider *recoveryImageProvider) GetImageTask(ctx context.Context, id string) (ai.ImageTask, error) {
	provider.pollCalls++
	return provider.query(ctx, id)
}

func recoveryImageFixture(t *testing.T, provider *recoveryImageProvider) model.ImageGenerationTask {
	t.Helper()
	providerType := newID("recovery-image-provider")
	if err := ai.Register(ai.ProviderType{ID: providerType, Name: providerType, Capabilities: []ai.Capability{ai.CapabilityImageGenerate}, New: func(json.RawMessage) (ai.Provider, error) { return provider, nil }}); err != nil {
		t.Fatal(err)
	}
	leaseUntil := time.Now().UTC().Add(time.Minute)
	item := model.ImageGenerationTask{ID: newID("recovery-image-task"), OwnerUID: newID("owner"), ClientRequestID: newID("request"), Mode: ImageTaskModeGeneration, Status: model.ImageTaskRunning, ProviderType: providerType, ProviderTaskID: "original-upstream", ReferencesJSON: "[]", ClaimID: "claim", LeaseUntil: &leaseUntil, CreatedAt: now(), UpdatedAt: now()}
	db, _ := repository.DB()
	if err := db.Create(&item).Error; err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = repository.DeleteImageGenerationTask(item.ID) })
	return item
}

func TestImageTaskPausesAfterFiveFailuresAndResumesOnlyOriginalTask(t *testing.T) {
	provider := &recoveryImageProvider{query: func(_ context.Context, id string) (ai.ImageTask, error) {
		if id != "original-upstream" {
			t.Fatalf("queried replacement task %q", id)
		}
		return ai.ImageTask{}, errors.New("temporary query failure")
	}}
	item := recoveryImageFixture(t, provider)
	db, _ := repository.DB()
	for failure := 1; failure <= 5; failure++ {
		executeImageTask(context.Background(), item)
		stored, _, err := repository.GetImageGenerationTask(item.ID)
		if err != nil || stored.PollFailures != failure || stored.ProviderTaskID != item.ProviderTaskID || stored.FinishedAt != "" {
			t.Fatalf("failure %d task=%+v err=%v", failure, stored, err)
		}
		if failure == 5 {
			if stored.Status != model.ImageTaskPaused || stored.LeaseUntil != nil {
				t.Fatalf("task did not pause: %+v", stored)
			}
			break
		}
		if stored.Status != model.ImageTaskRunning || stored.LeaseUntil == nil {
			t.Fatalf("retry state=%+v", stored)
		}
		lease := time.Now().UTC().Add(time.Minute)
		if err := db.Model(&stored).Updates(map[string]any{"claim_id": "retry-claim", "lease_until": lease}).Error; err != nil {
			t.Fatal(err)
		}
		stored.ClaimID, stored.LeaseUntil = "retry-claim", &lease
		item = stored
	}
	ctx := WithPortalUser(context.Background(), PortalUser{UID: item.OwnerUID})
	view, err := ResumeImageGenerationTask(ctx, item.ID)
	if err != nil || view.Status != "running" || view.ID != item.ID {
		t.Fatalf("resume=%+v err=%v", view, err)
	}
	stored, _, _ := repository.GetImageGenerationTask(item.ID)
	if stored.PollFailures != 0 || stored.ProviderTaskID != "original-upstream" || stored.Deadline == nil || stored.ClaimID != "" {
		t.Fatalf("resumed task=%+v", stored)
	}
	if _, err := ResumeImageGenerationTask(WithPortalUser(context.Background(), PortalUser{UID: "another-owner"}), item.ID); err == nil {
		t.Fatal("another owner resumed the task")
	}
	if provider.createCalls != 0 || provider.pollCalls != 5 {
		t.Fatalf("create=%d query=%d", provider.createCalls, provider.pollCalls)
	}
}

func TestSuccessfulImagePollResetsConsecutiveFailures(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	provider := &recoveryImageProvider{query: func(context.Context, string) (ai.ImageTask, error) {
		cancel()
		return ai.ImageTask{Status: ai.ImageTaskStatusRunning, Progress: 40}, nil
	}}
	item := recoveryImageFixture(t, provider)
	item.PollFailures = 4
	executeImageTask(ctx, item)
	stored, _, err := repository.GetImageGenerationTask(item.ID)
	if err != nil || stored.Status != model.ImageTaskRunning || stored.PollFailures != 0 || stored.Progress != 40 {
		t.Fatalf("successful poll did not reset failures: %+v err=%v", stored, err)
	}
}

func TestImageTaskDeadlineUsesLegacyCreationTimeAndKeepsSubmissionAmbiguity(t *testing.T) {
	for _, fixture := range []struct {
		status   model.ImageGenerationTaskStatus
		upstream string
		want     model.ImageGenerationTaskStatus
	}{
		{model.ImageTaskQueued, "", model.ImageTaskFailed},
		{model.ImageTaskRunning, "original-upstream", model.ImageTaskPaused},
		{model.ImageTaskSubmitting, "", model.ImageTaskUncertain},
	} {
		t.Run(string(fixture.status), func(t *testing.T) {
			provider := &recoveryImageProvider{query: func(context.Context, string) (ai.ImageTask, error) {
				t.Fatal("expired task contacted provider")
				return ai.ImageTask{}, nil
			}}
			item := recoveryImageFixture(t, provider)
			item.Status, item.ProviderTaskID, item.CreatedAt = fixture.status, fixture.upstream, time.Now().UTC().Add(-time.Hour).Format(time.RFC3339Nano)
			executeImageTask(context.Background(), item)
			stored, _, err := repository.GetImageGenerationTask(item.ID)
			if err != nil || stored.Status != fixture.want || provider.createCalls != 0 {
				t.Fatalf("deadline state=%+v err=%v", stored, err)
			}
		})
	}
}

func TestImageTaskWaitBudgetConfiguration(t *testing.T) {
	previous := config.Cfg
	t.Cleanup(func() { config.Cfg = previous })
	for _, value := range []string{"", "45m", "0", "-1m", "invalid"} {
		config.Cfg.AIImageTaskWaitTimeout = value
		duration, err := imageTaskWaitTimeout()
		if value == "" && (err != nil || duration != 30*time.Minute) || value == "45m" && (err != nil || duration != 45*time.Minute) || value != "" && value != "45m" && err == nil {
			t.Fatalf("value=%q duration=%v err=%v", value, duration, err)
		}
	}
}
