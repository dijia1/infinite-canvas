package service

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/basketikun/infinite-canvas/ai"
	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/shopspring/decimal"
)

func TestWorkflowVideoAdmissionUsesTheSameProviderCapabilities(t *testing.T) {
	previousConfig := config.Cfg
	previousSettings, err := repository.GetSettings()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		config.Cfg = previousConfig
		current, err := repository.GetSettings()
		if err != nil {
			t.Error(err)
			return
		}
		previousSettings.Revision = current.Revision
		if _, err := repository.SaveSettings(previousSettings, now()); err != nil {
			t.Error(err)
		}
	})
	config.Cfg.MediaStorage = "oss"
	config.Cfg.OSSRegion, config.Cfg.OSSBucket = "cn-test", "workflow-test"
	config.Cfg.OSSInternalEndpoint, config.Cfg.OSSPublicEndpoint = "https://internal.example", "https://public.example"
	config.Cfg.OSSAccessKeyID, config.Cfg.OSSAccessKeySecret, config.Cfg.OSSSignedURLTTL = "test", "test", "15m"
	const kind = "workflow-capability-test"
	if err := ai.Register(ai.ProviderType{ID: kind, Name: "Video capability test", Capabilities: []ai.Capability{ai.CapabilityVideoGenerate}, VideoRequestSchema: &ai.VideoRequestSchema{MinDuration: 5, MaxDuration: 15, MaxReferenceImages: 9, MaxReferenceVideos: 0, SupportsAudio: false}, New: func(json.RawMessage) (ai.Provider, error) { return workerVideoProvider{}, nil }}); err != nil {
		t.Fatal(err)
	}
	settings := previousSettings
	settings.AI = model.AISettings{Providers: []model.AIProvider{{ID: "video", Type: kind, Enabled: true, Config: json.RawMessage(`{}`), AspectRatios: []string{"16:9"}, VideoPrices: []model.ImageResolutionPrice{{Resolution: "720p", Amount: decimal.RequireFromString("0.1")}}}}}
	if _, err := repository.SaveSettings(settings, now()); err != nil {
		t.Fatal(err)
	}
	seconds := 5
	video := &model.WorkflowNodeConfig{ProviderID: "video", Size: "16:9", Resolution: "720p", Seconds: &seconds}
	graph := model.WorkflowGraph{Version: 1, Nodes: []model.WorkflowNode{{ID: "prompt", Type: model.WorkflowNodeTextInput, Text: "make a video"}, {ID: "video", Type: model.WorkflowNodeVideoGeneration, Config: video, Outputs: []model.WorkflowOutputSlot{{ID: "output", Type: model.WorkflowPortVideo}}}}, Connections: []model.WorkflowConnection{{SourceNodeID: "prompt", TargetNodeID: "video", TargetPortID: "prompt"}}}
	if err := validateWorkflowRunInputs(context.Background(), PortalUser{UID: "owner"}, graph); err != nil {
		t.Fatal(err)
	}
	seconds = 4
	if err := validateWorkflowRunInputs(context.Background(), PortalUser{UID: "owner"}, graph); err == nil || !strings.Contains(err.Error(), "时长") {
		t.Fatalf("unsupported duration accepted: %v", err)
	}
	seconds = 5
	audio := true
	video.GenerateAudio = &audio
	if err := validateWorkflowRunInputs(context.Background(), PortalUser{UID: "owner"}, graph); err == nil || !strings.Contains(err.Error(), "音频") {
		t.Fatalf("unsupported audio accepted: %v", err)
	}
}
