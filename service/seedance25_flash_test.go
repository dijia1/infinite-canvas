package service

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/basketikun/infinite-canvas/ai"
	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/shopspring/decimal"
)

func flashConfiguredProvider(t *testing.T) (model.AIProvider, ai.ProviderType) {
	t.Helper()
	info, ok := ai.Type("maizi-video-seedance-2-5-flash")
	if !ok {
		t.Fatal("Flash type missing")
	}
	return model.AIProvider{ID: "flash", Name: "Seedance 2.5 Flash", Type: info.ID, Enabled: true,
		Config: json.RawMessage(`{"apiKey":"fixture","model":"doubao-seedance-2.5-flash"}`), AspectRatios: []string{"16:9", "adaptive"},
		VideoPrices: []model.ImageResolutionPrice{{Resolution: "480p", Amount: decimal.RequireFromString("0.4")}, {Resolution: "720p", Amount: decimal.RequireFromString("0.9")}}}, info
}

func TestFlashSettingsAndAdmissionEnforceDefinitionAndOnlyRecordGeneratedSeconds(t *testing.T) {
	p, info := flashConfiguredProvider(t)
	if err := validateProviderVideoSettings(p, info); err != nil {
		t.Fatal(err)
	}
	schema := configuredVideoRequestSchema(p, info)
	if schema.SupportsDraft || schema.MaxReferenceMedia != 6 || schema.Resolutions[0].Price != "0.4" || schema.Resolutions[1].Price != "0.9" {
		t.Fatalf("%+v", schema)
	}
	request := CreateVideoTaskRequest{Seconds: 5, Size: "adaptive", Resolution: "480p", ImageMediaIDs: []string{"a", "a", "b"}, VideoMediaIDs: []string{"v1", "v2", "v3"}}
	if err := validateVideoRequestCapabilities(request, p, info); err != nil {
		t.Fatal(err)
	}
	amount, err := videoTaskAmount(p, request)
	if err != nil || !amount.Equal(decimal.NewFromInt(2)) {
		t.Fatal(amount, err)
	}
	request.Resolution = "720p"
	amount, err = videoTaskAmount(p, request)
	if err != nil || !amount.Equal(decimal.RequireFromString("4.5")) {
		t.Fatal(amount, err)
	}
	request.ImageMediaIDs = append(request.ImageMediaIDs, "c")
	if err := validateVideoRequestCapabilities(request, p, info); err == nil || !strings.Contains(err.Error(), "合计最多 6") {
		t.Fatal(err)
	}
	for _, mode := range []string{"draft", "final"} {
		request.Mode = mode
		if err := validateVideoRequestCapabilities(request, p, info); err == nil || !strings.Contains(err.Error(), "不支持样片") {
			t.Fatal(err)
		}
	}
	p.VideoPrices = append(p.VideoPrices, model.ImageResolutionPrice{Resolution: "1080p", Amount: decimal.NewFromInt(1)})
	if err := validateProviderVideoSettings(p, info); err == nil {
		t.Fatal("1080p settings accepted")
	}
	request.Mode, request.Resolution, request.ImageMediaIDs, request.VideoMediaIDs = "", "1080p", nil, nil
	if err := validateVideoRequestCapabilities(request, p, info); err == nil {
		t.Fatal("invalid stored config bypassed Flash limits")
	}
	if schema := configuredVideoRequestSchema(p, info); len(schema.Resolutions) != 2 {
		t.Fatal("public schema leaked unsupported resolution")
	}
	p, info = flashConfiguredProvider(t)
	p.AspectRatios = []string{"2:1"}
	if err := validateProviderVideoSettings(p, info); err == nil {
		t.Fatal("unsupported ratio saved")
	}
	p, info = flashConfiguredProvider(t)
	p.VideoPrices[0], p.VideoPrices[1] = p.VideoPrices[1], p.VideoPrices[0]
	p.AspectRatios = []string{"adaptive", "16:9"}
	schema = configuredVideoRequestSchema(p, info)
	if schema.DefaultResolution != "480p" || schema.DefaultAspectRatio != "16:9" {
		t.Fatal("model defaults changed with admin order")
	}
	p.VideoPrices = p.VideoPrices[:1]
	p.AspectRatios = p.AspectRatios[:1]
	schema = configuredVideoRequestSchema(p, info)
	if schema.DefaultResolution != "720p" || schema.DefaultAspectRatio != "adaptive" {
		t.Fatal("disabled defaults did not fall back to enabled options")
	}
}

func TestFlashWorkflowSharesMixedReferenceAndDurationLimits(t *testing.T) {
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
	config.Cfg.OSSRegion, config.Cfg.OSSBucket = "cn-test", "flash-test"
	config.Cfg.OSSInternalEndpoint, config.Cfg.OSSPublicEndpoint = "https://internal.example", "https://public.example"
	config.Cfg.OSSAccessKeyID, config.Cfg.OSSAccessKeySecret, config.Cfg.OSSSignedURLTTL = "fixture", "fixture", "15m"
	p, _ := flashConfiguredProvider(t)
	settings := previousSettings
	settings.AI = model.AISettings{Providers: []model.AIProvider{p}}
	if _, err := repository.SaveSettings(settings, now()); err != nil {
		t.Fatal(err)
	}
	owner := PortalUser{UID: newID("flash-workflow-owner")}
	seconds := 30
	graph := model.WorkflowGraph{Version: 1, Nodes: []model.WorkflowNode{
		{ID: "prompt", Type: model.WorkflowNodeTextInput, Text: "产品短片"},
		{ID: "generate", Type: model.WorkflowNodeVideoGeneration, Config: &model.WorkflowNodeConfig{ProviderID: p.ID, Resolution: "480p", Size: "16:9", Seconds: &seconds}, Outputs: []model.WorkflowOutputSlot{{ID: "output", Type: model.WorkflowPortVideo}}},
	}, Connections: []model.WorkflowConnection{{SourceNodeID: "prompt", TargetNodeID: "generate", TargetPortID: "prompt"}}}
	for i := 0; i < 7; i++ {
		id := fmt.Sprintf("input-%d", i)
		kind, mime, duration := model.WorkflowNodeImageInput, "image/png", 0.0
		if i >= 3 && i < 6 {
			kind, mime, duration = model.WorkflowNodeVideoInput, "video/mp4", 5
		}
		media := model.Media{ID: newID("flash-input"), OwnerUID: owner.UID, ObjectKey: id, ContentType: mime, Duration: duration, Width: 640, Height: 360, Bytes: 100}
		if _, err := repository.SaveMedia(media); err != nil {
			t.Fatal(err)
		}
		graph.Nodes = append(graph.Nodes, model.WorkflowNode{ID: id, Type: kind, MediaID: media.ID})
		graph.Connections = append(graph.Connections, model.WorkflowConnection{SourceNodeID: id, TargetNodeID: "generate", TargetPortID: "reference", Order: i + 1})
		if i == 5 {
			if err := validateWorkflowRunInputs(context.Background(), owner, graph); err != nil {
				t.Fatal("six mixed references should pass", err)
			}
		}
	}
	if err := validateWorkflowRunInputs(context.Background(), owner, graph); err == nil || !strings.Contains(err.Error(), "合计最多 6") {
		t.Fatal("seventh reference accepted", err)
	}
	graph.Connections = graph.Connections[:len(graph.Connections)-1]
	video := graph.Nodes[5]
	db, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.Media{}).Where("id = ?", video.MediaID).Update("duration", 5.1).Error; err != nil {
		t.Fatal(err)
	}
	if err := validateWorkflowRunInputs(context.Background(), owner, graph); err == nil || !strings.Contains(err.Error(), "15") {
		t.Fatal("excess reference duration accepted", err)
	}
}
