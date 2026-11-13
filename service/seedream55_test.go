package service

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/basketikun/infinite-canvas/ai"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/shopspring/decimal"
)

func TestSeedream55ConfigurationDefaultsAndTaskSnapshot(t *testing.T) {
	original, err := AdminSettings()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := saveGenerationSettingsForTest(t, original); err != nil {
			t.Error(err)
		}
	})
	provider := model.AIProvider{ID: newID("seedream55"), Name: "Seedream 5.5", Type: "maizi-seedream-5-5", Enabled: true, Config: json.RawMessage(`{"apiKey":"fixture-key","model":"seedream-5-5"}`), AspectRatios: []string{"9:16", "1:1"}, ImagePrices: []model.ImageResolutionPrice{{Resolution: "1K", Amount: decimal.RequireFromString("0.1")}, {Resolution: "1.5K", Amount: decimal.RequireFromString("0.15")}, {Resolution: "2K", Amount: decimal.RequireFromString("0.2")}}}
	settings := original
	settings.AI = model.AISettings{ImageProviderID: provider.ID, Providers: []model.AIProvider{provider}}
	if _, err := SaveSettings(settings); err != nil {
		t.Fatal(err)
	}
	info, _ := ai.Type(provider.Type)
	schema := configuredImageRequestSchema(provider, *info.ImageRequestSchema)
	defaults := map[string]string{}
	for _, field := range schema.Fields {
		var value string
		_ = json.Unmarshal(field.Default, &value)
		defaults[field.Key] = value
	}
	if defaults["resolution"] != "2K" || defaults["size"] != "1:1" || defaults["outputFormat"] != "png" {
		t.Fatalf("defaults=%v", defaults)
	}
	provider.AspectRatios = []string{"9:16"}
	provider.ImagePrices = provider.ImagePrices[:1]
	subset := configuredImageRequestSchema(provider, *info.ImageRequestSchema)
	if string(subset.Fields[0].Default) != `"9:16"` || string(subset.Fields[1].Default) != `"1K"` {
		t.Fatalf("subset=%+v", subset)
	}
	for _, key := range []string{"size", "resolution"} {
		bad := provider
		if key == "size" {
			bad.AspectRatios = []string{"auto"}
		} else {
			bad.ImagePrices = []model.ImageResolutionPrice{{Resolution: "4K"}}
		}
		if err := validateConfiguredImageOptions(bad, info); err == nil {
			t.Fatal("accepted invalid " + key)
		}
	}
	ctx := WithPortalUser(context.Background(), PortalUser{UID: newID("seedream55-owner")})
	request := CreateImageTaskRequest{ClientRequestID: newID("client"), ProviderID: provider.ID, Mode: ImageTaskModeGeneration, Request: ai.ImageRequest{Prompt: "产品图", Count: 1}}
	task, err := CreateImageTask(ctx, request)
	if err != nil {
		t.Fatal(err)
	}
	saved, found, err := repository.GetImageGenerationTask(task.ID)
	if err != nil || !found || saved.Resolution != "2K" || saved.OutputFormat != "png" {
		t.Fatalf("saved=%+v err=%v", saved, err)
	}
	// Administrative changes cannot alter an accepted task or its idempotency key.
	settings, err = AdminSettings()
	if err != nil {
		t.Fatal(err)
	}
	settings.AI.Providers[0].AspectRatios = []string{"9:16"}
	settings.AI.Providers[0].ImagePrices = settings.AI.Providers[0].ImagePrices[:1]
	settings.AI.Providers[0].Config = json.RawMessage(`{"apiKey":"changed-key","model":"changed-model"}`)
	if _, err := SaveSettings(settings); err != nil {
		t.Fatal(err)
	}
	replay, err := CreateImageTask(ctx, request)
	if err != nil || replay.ID != task.ID {
		t.Fatalf("replay=%+v err=%v", replay, err)
	}
}

func TestWorkflowTenImagesAndPromptBoundary(t *testing.T) {
	graph := validWorkflowGraph()
	target := &graph.Nodes[2]
	for i := 1; i < 10; i++ {
		id := fmt.Sprintf("image-%d", i)
		target.InputPorts = append(target.InputPorts, model.WorkflowInputPort{ID: id, Type: model.WorkflowPortImage})
		graph.Connections = append(graph.Connections, model.WorkflowConnection{SourceNodeID: id, SourceSlotID: "output", TargetNodeID: target.ID, TargetPortID: id, Order: i + 1})
	}
	for i := 1; i < 10; i++ {
		graph.Nodes = append(graph.Nodes, model.WorkflowNode{ID: fmt.Sprintf("image-%d", i), Type: model.WorkflowNodeImageInput})
	}
	if _, err := normalizeWorkflowGraph(graph); err != nil {
		t.Fatal(err)
	}
	graph.Nodes[2].InputPorts = append(graph.Nodes[2].InputPorts, model.WorkflowInputPort{ID: "too-many", Type: model.WorkflowPortImage})
	if _, err := normalizeWorkflowGraph(graph); err == nil {
		t.Fatal("accepted 12 inputs")
	}
}

func TestLegacyMaiziRequestDefaultsKeepSnapshotHashes(t *testing.T) {
	for _, providerType := range []string{"maizi-image", "maizi-seedream-5-pro-nsfw"} {
		t.Run(providerType, func(t *testing.T) {
			info, _ := ai.Type(providerType)
			encoded, err := json.Marshal(info.ImageRequestSchema)
			if err != nil {
				t.Fatal(err)
			}
			snapshot, err := decodeImageTaskRequestSchema(string(encoded))
			if err != nil {
				t.Fatal(err)
			}
			request := CreateImageTaskRequest{ClientRequestID: "legacy-replay", ProviderID: "legacy", Mode: ImageTaskModeGeneration, Request: ai.ImageRequest{Prompt: "产品图", Count: 1, Resolution: "1K"}}
			// Before this change the service filled these common fields before canonicalization.
			oldRequest := request
			oldRequest.Request.OutputFormat, oldRequest.Request.Background = "jpeg", "auto"
			oldCanonical, err := canonicalizeImageTaskRequestForHash(providerType, snapshot, oldRequest)
			if err != nil {
				t.Fatal(err)
			}
			current, err := normalizeImageTaskRequest(request)
			if err != nil {
				t.Fatal(err)
			}
			current, err = canonicalizeImageTaskRequestForHash(providerType, snapshot, current)
			if err != nil {
				t.Fatal(err)
			}
			oldHash, err := imageTaskRequestHash(oldCanonical)
			if err != nil {
				t.Fatal(err)
			}
			newHash, err := imageTaskRequestHash(current)
			if err != nil || oldHash != newHash {
				t.Fatalf("legacy hash %s != %s: %v", oldHash, newHash, err)
			}
		})
	}
}
