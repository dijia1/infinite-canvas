package service

import (
	"encoding/json"
	"testing"

	"github.com/basketikun/infinite-canvas/ai"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/shopspring/decimal"
)

func TestNormalizeImageTaskRequestDefaultsAndValidatesImageAndMaskCounts(t *testing.T) {
	request, err := normalizeImageTaskRequest(CreateImageTaskRequest{
		ClientRequestID: "request-defaults",
		Mode:            ImageTaskModeGeneration,
		Request:         ai.ImageRequest{Prompt: "生成图", Count: 1},
	})
	if err != nil {
		t.Fatalf("normalizeImageTaskRequest() error = %v", err)
	}
	if request.Request.OutputFormat != "jpeg" || request.Request.Background != "auto" {
		t.Fatalf("defaults = %q/%q, want jpeg/auto", request.Request.OutputFormat, request.Request.Background)
	}

	for _, item := range []ai.ImageRequest{
		{Prompt: "生成图", Count: 1, OutputFormat: "jpeg", Background: "auto"},
		{Prompt: "生成图", Count: 1, OutputFormat: "png", Background: "auto"},
		{Prompt: "生成图", Count: 1, OutputFormat: "png", Background: "opaque"},
		{Prompt: "生成图", Count: 1, OutputFormat: "png", Background: "transparent"},
	} {
		if _, err := normalizeImageTaskRequest(CreateImageTaskRequest{ClientRequestID: "request-background-" + item.OutputFormat + "-" + item.Background, Mode: ImageTaskModeGeneration, Request: item}); err != nil {
			t.Fatalf("normalizeImageTaskRequest(%s/%s) error = %v", item.OutputFormat, item.Background, err)
		}
	}

	invalidFormat := CreateImageTaskRequest{ClientRequestID: "request-invalid-format", Mode: ImageTaskModeGeneration, Request: ai.ImageRequest{Prompt: "生成图", Count: 1, OutputFormat: "jpeg", Background: "transparent"}}
	if _, err := normalizeImageTaskRequest(invalidFormat); err == nil {
		t.Fatal("normalizeImageTaskRequest() accepted jpeg/transparent")
	}

	maskWithoutReference := CreateImageTaskRequest{ClientRequestID: "request-no-image", Mode: ImageTaskModeEdit, Request: ai.ImageRequest{Prompt: "编辑", Count: 1}, Mask: &ai.ImageReference{ContentType: "image/png", Data: tinyPNG}}
	if _, err := normalizeImageTaskRequest(maskWithoutReference); err == nil {
		t.Fatal("normalizeImageTaskRequest() accepted a mask without an image")
	}

	sevenReferences := make([]ai.ImageReference, 7)
	for index := range sevenReferences {
		sevenReferences[index] = ai.ImageReference{ContentType: "image/png", Data: tinyPNG}
	}
	maskedMultiReference := CreateImageTaskRequest{ClientRequestID: "request-many-images", Mode: ImageTaskModeEdit, Request: ai.ImageRequest{Prompt: "编辑", Count: 1}, References: sevenReferences, Mask: &ai.ImageReference{ContentType: "image/png", Data: tinyPNG}}
	if _, err := normalizeImageTaskRequest(maskedMultiReference); err != nil {
		t.Fatalf("normalizeImageTaskRequest() rejected seven ordered images with one mask: %v", err)
	}

	eightReferences := append(sevenReferences, ai.ImageReference{ContentType: "image/png", Data: tinyPNG})
	providerSizedRequest := CreateImageTaskRequest{ClientRequestID: "request-eight-images", Mode: ImageTaskModeEdit, Request: ai.ImageRequest{Prompt: "编辑", Count: 1}, References: eightReferences}
	if _, err := normalizeImageTaskRequest(providerSizedRequest); err != nil {
		t.Fatalf("normalizeImageTaskRequest() rejected an image count that a provider may support: %v", err)
	}

	if _, err := normalizeImageTaskRequest(CreateImageTaskRequest{ClientRequestID: "request-media-reference", Mode: ImageTaskModeEdit, Request: ai.ImageRequest{Prompt: "编辑", Count: 1}, ReferenceMediaIDs: []string{"media-a"}}); err != nil {
		t.Fatalf("normalizeImageTaskRequest() rejected a stable media reference: %v", err)
	}
	if _, err := normalizeImageTaskRequest(CreateImageTaskRequest{ClientRequestID: "request-mixed-reference", Mode: ImageTaskModeEdit, Request: ai.ImageRequest{Prompt: "编辑", Count: 1}, References: []ai.ImageReference{{ContentType: "image/png", Data: tinyPNG}}, ReferenceMediaIDs: []string{"media-a"}}); err == nil {
		t.Fatal("normalizeImageTaskRequest() accepted mixed uploaded and stable media references")
	}
}

func TestImageTaskRequestRestoresPersistedProviderOptions(t *testing.T) {
	request := imageTaskRequest(model.ImageGenerationTask{Prompt: "生成图", Count: 1, OutputFormat: "png", Background: "opaque", ProviderOptionsJSON: `{"watermark":false}`})
	if got := string(request.Options["watermark"]); got != "false" {
		t.Fatalf("restored watermark = %s, want false", got)
	}
	if _, err := json.Marshal(request.Options); err != nil {
		t.Fatalf("provider options must stay JSON serializable: %v", err)
	}
}

func TestConfiguredImageTaskProviderUsesAnEnabledRequestedModel(t *testing.T) {
	const providerType = "service-task-selection-test"
	_ = ai.Register(ai.ProviderType{ID: providerType, Name: "Task selection test", Capabilities: []ai.Capability{ai.CapabilityImageGenerate, ai.CapabilityImageEdit}})
	settings := model.AISettings{
		ImageProviderID: "default",
		Providers: []model.AIProvider{
			{ID: "default", Type: providerType, Enabled: true},
			{ID: "chosen", Type: providerType, Enabled: true},
			{ID: "disabled", Type: providerType, Enabled: false},
		},
	}
	provider, err := configuredImageTaskProvider(settings, ImageTaskModeGeneration, "chosen")
	if err != nil || provider.ID != "chosen" {
		t.Fatalf("configuredImageTaskProvider() = %#v, %v", provider, err)
	}
	provider, err = configuredImageTaskProvider(settings, ImageTaskModeGeneration, "")
	if err != nil || provider.ID != "default" {
		t.Fatalf("configuredImageTaskProvider() default = %#v, %v", provider, err)
	}
	if _, err := configuredImageTaskProvider(settings, ImageTaskModeGeneration, "disabled"); err == nil {
		t.Fatal("configuredImageTaskProvider() accepted a disabled model")
	}
}

func TestImageTaskAmountUsesConfiguredResolutionPrice(t *testing.T) {
	provider := model.AIProvider{ImagePrices: []model.ImageResolutionPrice{
		{Resolution: "1k", Amount: decimal.RequireFromString("0.1200")},
		{Resolution: "2k", Amount: decimal.RequireFromString("0.2400")},
	}}
	amount, err := imageTaskAmount(provider, "2k")
	if err != nil || !amount.Equal(decimal.RequireFromString("0.2400")) {
		t.Fatalf("imageTaskAmount() = %s, %v", amount, err)
	}
	if _, err := imageTaskAmount(provider, "4k"); err == nil {
		t.Fatal("imageTaskAmount() accepted an unpriced resolution")
	}
}

func TestImageTaskRequestHashUsesNormalizedPayloadIdentity(t *testing.T) {
	base := CreateImageTaskRequest{
		ClientRequestID: "client-a",
		ProviderID:      "provider-a",
		Mode:            ImageTaskModeEdit,
		Request: ai.ImageRequest{
			Prompt: "编辑商品图", Count: 1, Quality: "high", Size: "1:1", Resolution: "2k", OutputFormat: "png", Background: "opaque",
			Options: ai.ImageRequestOptions{"style": json.RawMessage(`{"tone":"warm"}`), "seed": json.RawMessage(`7`)},
		},
		ReferenceMediaIDs: []string{"media-a", "media-b"},
	}
	first, err := imageTaskRequestHash(base)
	if err != nil || len(first) != 64 {
		t.Fatalf("imageTaskRequestHash() = %q, %v", first, err)
	}
	equivalent := base
	equivalent.ClientRequestID = "client-b"
	equivalent.Request.Options = ai.ImageRequestOptions{"seed": json.RawMessage("7"), "style": json.RawMessage(`{ "tone": "warm" }`)}
	if got, err := imageTaskRequestHash(equivalent); err != nil || got != first {
		t.Fatalf("equivalent payload hash = %q, %v; want %q", got, err, first)
	}
	for name, mutate := range map[string]func(*CreateImageTaskRequest){
		"provider": func(request *CreateImageTaskRequest) { request.ProviderID = "provider-b" },
		"prompt":   func(request *CreateImageTaskRequest) { request.Request.Prompt = "编辑另一张商品图" },
		"options": func(request *CreateImageTaskRequest) {
			request.Request.Options = ai.ImageRequestOptions{"seed": json.RawMessage(`8`)}
		},
		"media order": func(request *CreateImageTaskRequest) {
			request.ReferenceMediaIDs = []string{"media-b", "media-a"}
		},
	} {
		changed := base
		changed.Request.Options = cloneImageRequestOptionsForTest(base.Request.Options)
		changed.ReferenceMediaIDs = append([]string{}, base.ReferenceMediaIDs...)
		mutate(&changed)
		if got, err := imageTaskRequestHash(changed); err != nil || got == first {
			t.Errorf("%s payload hash = %q, %v; want different from %q", name, got, err, first)
		}
	}
}

func TestImageTaskRequestHashIncludesOrderedUploadedContentWithoutTemporaryPaths(t *testing.T) {
	base := CreateImageTaskRequest{ProviderID: "provider", Mode: ImageTaskModeEdit, Request: ai.ImageRequest{Prompt: "编辑", Count: 1, OutputFormat: "png", Background: "opaque"}, References: []ai.ImageReference{{Name: "folder/reference.png", ContentType: "image/png", Data: tinyPNG}}}
	first, err := imageTaskRequestHash(base)
	if err != nil {
		t.Fatal(err)
	}
	changed := base
	changed.References = []ai.ImageReference{{Name: "reference.png", ContentType: "image/png", Data: append(append([]byte{}, tinyPNG...), 0)}}
	if got, err := imageTaskRequestHash(changed); err != nil || got == first {
		t.Fatalf("changed uploaded bytes hash = %q, %v; want different", got, err)
	}
}

func cloneImageRequestOptionsForTest(options ai.ImageRequestOptions) ai.ImageRequestOptions {
	result := make(ai.ImageRequestOptions, len(options))
	for key, value := range options {
		result[key] = append(json.RawMessage(nil), value...)
	}
	return result
}
