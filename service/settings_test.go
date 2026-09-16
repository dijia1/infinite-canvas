package service

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/basketikun/infinite-canvas/ai"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/shopspring/decimal"
)

func TestActiveImageProviderSchemaReturnsOnlyTheSelectedProviderSchema(t *testing.T) {
	const registeredType = "service-public-settings-test"
	_ = ai.Register(ai.ProviderType{
		ID:           registeredType,
		Name:         "Test provider",
		Capabilities: []ai.Capability{ai.CapabilityImageGenerate},
		ImageRequestSchema: &ai.ImageRequestSchema{
			Version: "v1", MaxReferenceImages: 10,
		},
	})
	settings := model.AISettings{
		ImageProviderID: "seedream",
		Providers:       []model.AIProvider{{ID: "seedream", Type: registeredType, Enabled: true, ImagePrices: []model.ImageResolutionPrice{{Resolution: "1k"}}}},
	}
	providerType, schema := activeImageProviderSchema(settings)
	if providerType != "service-public-settings-test" || schema == nil || schema.MaxReferenceImages != 10 {
		t.Fatalf("activeImageProviderSchema() = %q, %#v", providerType, schema)
	}
	providerType, schema = activeImageProviderSchema(model.AISettings{ImageProviderID: "missing", Providers: settings.Providers})
	if providerType != "" || schema != nil {
		t.Fatalf("activeImageProviderSchema() exposed unavailable provider = %q, %#v", providerType, schema)
	}
}

func TestPublicAIModelChoicesExposeOnlyEnabledInstancesWithoutConfig(t *testing.T) {
	const providerType = "service-public-model-choice-test"
	_ = ai.Register(ai.ProviderType{
		ID:           providerType,
		Name:         "Test image provider",
		Capabilities: []ai.Capability{ai.CapabilityImageGenerate, ai.CapabilityImageEdit},
		ImageRequestSchema: &ai.ImageRequestSchema{
			Version: "v1", MaxReferenceImages: 3,
		},
	})
	settings := model.AISettings{Providers: []model.AIProvider{
		{ID: "enabled", Name: "可选模型", Type: providerType, Enabled: true, ImagePrices: []model.ImageResolutionPrice{{Resolution: "1k"}}, Config: []byte(`{"apiKey":"secret","model":"internal-model"}`)},
		{ID: "disabled", Name: "不可选模型", Type: providerType, Enabled: false, Config: []byte(`{"apiKey":"secret"}`)},
	}}
	choices := publicAIModelChoices(settings, ai.CapabilityImageGenerate)
	if len(choices) != 1 || choices[0].ID != "enabled" || choices[0].Name != "可选模型" || choices[0].ImageRequestSchema == nil {
		t.Fatalf("publicAIModelChoices() = %#v", choices)
	}
}

func TestPublicAIModelChoicesExposeOnlyConfiguredResolutionPrices(t *testing.T) {
	const providerType = "service-public-model-prices-test"
	_ = ai.Register(ai.ProviderType{
		ID:           providerType,
		Name:         "Test priced image provider",
		Capabilities: []ai.Capability{ai.CapabilityImageGenerate},
		ImageRequestSchema: &ai.ImageRequestSchema{Version: "v1", Fields: []ai.ImageRequestField{{
			Key: "resolution", Label: "尺寸", Type: ai.ImageRequestFieldSelect,
			Default: json.RawMessage(`"1k"`),
			Options: []ai.ImageRequestFieldOption{{Value: "1k", Label: "1K"}, {Value: "2k", Label: "2K"}, {Value: "4k", Label: "4K"}},
		}}},
	})
	choices := publicAIModelChoices(model.AISettings{Providers: []model.AIProvider{{
		ID: "priced", Name: "定价模型", Type: providerType, Enabled: true,
		ImagePrices: []model.ImageResolutionPrice{{Resolution: "1k", Amount: decimal.RequireFromString("0.1200")}, {Resolution: "2k", Amount: decimal.RequireFromString("0.2400")}},
	}}}, ai.CapabilityImageGenerate)
	if len(choices) != 1 || choices[0].ImageRequestSchema == nil {
		t.Fatalf("choices = %#v", choices)
	}
	options := choices[0].ImageRequestSchema.Fields[0].Options
	if len(options) != 2 || options[0].Value != "1k" || options[0].Price != "0.12" || options[1].Value != "2k" || options[1].Price != "0.24" {
		t.Fatalf("resolution options = %#v", options)
	}
}

func TestPublicAIModelChoicesUseAdministratorResolutionParameters(t *testing.T) {
	const providerType = "service-custom-resolution-prices-test"
	_ = ai.Register(ai.ProviderType{
		ID: providerType, Name: "Custom resolution provider", Capabilities: []ai.Capability{ai.CapabilityImageGenerate},
		ImageRequestSchema: &ai.ImageRequestSchema{Version: "v1", Fields: []ai.ImageRequestField{{Key: "resolution", Label: "尺寸", Type: ai.ImageRequestFieldText, Required: true}}},
	})
	choices := publicAIModelChoices(model.AISettings{Providers: []model.AIProvider{{
		ID: "priced", Name: "定价模型", Type: providerType, Enabled: true,
		ImagePrices: []model.ImageResolutionPrice{{Resolution: "2K", Amount: decimal.RequireFromString("0.1200")}, {Resolution: "2048x1152", Amount: decimal.RequireFromString("0.2400")}},
	}}}, ai.CapabilityImageGenerate)
	if len(choices) != 1 || choices[0].ImageRequestSchema == nil {
		t.Fatalf("choices = %#v", choices)
	}
	field := choices[0].ImageRequestSchema.Fields[0]
	if field.Type != ai.ImageRequestFieldSelect || len(field.Options) != 2 || field.Options[0].Value != "2K" || field.Options[0].Label != "2K" || field.Options[1].Value != "2048x1152" {
		t.Fatalf("resolution field = %#v", field)
	}
}

func TestNormalizeSettingsDoesNotExpandLegacyImagePrice(t *testing.T) {
	const providerType = "service-legacy-image-prices-test"
	_ = ai.Register(ai.ProviderType{
		ID: providerType, Name: "Legacy pricing provider", Capabilities: []ai.Capability{ai.CapabilityImageGenerate},
		ImageRequestSchema: &ai.ImageRequestSchema{Fields: []ai.ImageRequestField{{Key: "resolution", Type: ai.ImageRequestFieldSelect, Options: []ai.ImageRequestFieldOption{{Value: "1k"}, {Value: "2k"}}}}},
	})
	settings := normalizeSettings(model.Settings{AI: model.AISettings{Providers: []model.AIProvider{{
		ID: "legacy", Name: "旧模型", Type: providerType, ImageCallAmount: decimal.RequireFromString("0.1234"), ImagePrices: nil,
	}}}})
	if prices := settings.AI.Providers[0].ImagePrices; prices != nil {
		t.Fatalf("legacy prices = %#v, want nil", prices)
	}
}

func TestValidateSettingsAllowsCustomResolutionPricesAndRejectsUnsafeRules(t *testing.T) {
	const providerType = "service-image-price-validation-test"
	_ = ai.Register(ai.ProviderType{
		ID: providerType, Name: "Validation provider", Capabilities: []ai.Capability{ai.CapabilityImageGenerate},
		ImageRequestSchema: &ai.ImageRequestSchema{Fields: []ai.ImageRequestField{{Key: "resolution", Type: ai.ImageRequestFieldSelect, Options: []ai.ImageRequestFieldOption{{Value: "1k"}, {Value: "2k"}}}}},
	})
	if err := validateSettings(model.AISettings{Providers: []model.AIProvider{{
		ID: "model", Name: "模型", Type: providerType,
		ImagePrices: []model.ImageResolutionPrice{{Resolution: "1536x1024", Amount: decimal.Zero}}, Config: []byte(`{}`),
	}}}); err != nil {
		t.Fatalf("validateSettings() rejected a custom price rule: %v", err)
	}
	for _, prices := range [][]model.ImageResolutionPrice{
		{{Resolution: "2K", Amount: decimal.Zero}, {Resolution: "2k", Amount: decimal.Zero}},
		{{Resolution: "", Amount: decimal.Zero}},
		{{Resolution: "2K\ninvalid", Amount: decimal.Zero}},
		{{Resolution: "2k", Amount: decimal.RequireFromString("0.00001")}},
	} {
		if err := validateSettings(model.AISettings{Providers: []model.AIProvider{{ID: "model", Name: "模型", Type: providerType, ImagePrices: prices, Config: []byte(`{}`)}}}); err == nil {
			t.Fatalf("validateSettings() accepted prices %#v", prices)
		}
	}
}

func TestVideoModelSettingsRequirePricesAndRatios(t *testing.T) {
	info := ai.ProviderType{ID: "video-settings-test", Name: "Video", Capabilities: []ai.Capability{ai.CapabilityVideoGenerate}, VideoRequestSchema: &ai.VideoRequestSchema{
		MinDuration: 5, MaxDuration: 15, DefaultDuration: 5, MaxReferenceImages: 9, MaxReferenceVideos: 0, SupportsAudio: false,
	}}
	_ = ai.Register(info)
	p := model.AIProvider{ID: "video", Name: "Video", Type: info.ID, Enabled: true, Config: json.RawMessage(`{}`)}
	if err := validateSettings(model.AISettings{Providers: []model.AIProvider{p}, VideoProviderID: p.ID}); err != nil {
		t.Fatal("incomplete settings should remain saveable", err)
	}
	if providerAvailable(model.AISettings{Providers: []model.AIProvider{p}}, p.ID, ai.CapabilityVideoGenerate) {
		t.Fatal("incomplete model available")
	}
	p.VideoPrices = []model.ImageResolutionPrice{{Resolution: "720p", Amount: decimal.RequireFromString("0.25")}}
	p.AspectRatios = []string{"16:9", "9:16"}
	if e := validateProviderVideoSettings(p, info); e != nil {
		t.Fatal(e)
	}
	choices := publicAIModelChoices(model.AISettings{Providers: []model.AIProvider{p}}, ai.CapabilityVideoGenerate)
	if len(choices) != 1 || choices[0].VideoRequestSchema == nil {
		t.Fatal(choices)
	}
	s := choices[0].VideoRequestSchema
	if s.MinDuration != 5 || s.MaxDuration != 15 || s.MaxReferenceImages != 9 || s.MaxReferenceVideos != 0 || s.SupportsAudio || s.Resolutions[0].Price != "0.25" || s.AspectRatios[0] != "16:9" {
		t.Fatalf("%+v", s)
	}
	p.AspectRatios = []string{"16:9", "16:9"}
	if validateProviderVideoSettings(p, info) == nil {
		t.Fatal("duplicate ratio accepted")
	}
	p.AspectRatios = []string{"portrait", "landscape", "square"}
	if err := validateProviderVideoSettings(p, info); err != nil {
		t.Fatalf("named upstream ratios rejected: %v", err)
	}
	configured := configuredVideoRequestSchema(p, info)
	if len(configured.AspectRatios) != 3 || configured.AspectRatios[0] != "portrait" || configured.AspectRatios[2] != "square" {
		t.Fatalf("configured ratios = %#v", configured.AspectRatios)
	}
	for _, invalidRatio := range []string{"", "bad\nratio", strings.Repeat("x", 65)} {
		p.AspectRatios = []string{invalidRatio}
		if validateProviderVideoSettings(p, info) == nil {
			t.Fatalf("unsafe video ratio accepted: %q", invalidRatio)
		}
	}
	p.AspectRatios = []string{"16:9"}
	p.VideoPrices[0].Amount = decimal.NewFromInt(-1)
	if validateProviderVideoSettings(p, info) == nil {
		t.Fatal("negative price accepted")
	}
}

func TestImageAspectRatiosRemainNumericOrAuto(t *testing.T) {
	info := ai.ProviderType{ID: "image-ratio-validation-test", Capabilities: []ai.Capability{ai.CapabilityImageGenerate}, ImageRequestSchema: &ai.ImageRequestSchema{Fields: []ai.ImageRequestField{{Key: "size"}}}}
	provider := model.AIProvider{AspectRatios: []string{"16:9", "auto"}}
	if err := validateProviderVideoSettings(provider, info); err != nil {
		t.Fatalf("valid image ratios rejected: %v", err)
	}
	provider.AspectRatios = []string{"portrait"}
	if validateProviderVideoSettings(provider, info) == nil {
		t.Fatal("named ratio accepted for image provider")
	}
}
func TestConfiguredImageAspectRatiosNoFallbackAndClone(t *testing.T) {
	schema := ai.ImageRequestSchema{Fields: []ai.ImageRequestField{{Key: "size", Options: []ai.ImageRequestFieldOption{{Value: "1:1"}}, Default: json.RawMessage(`"1:1"`)}}}
	legacy := configuredImageRequestSchema(model.AIProvider{}, schema)
	if len(legacy.Fields[0].Options) != 0 || legacy.Fields[0].Default != nil {
		t.Fatal(legacy)
	}
	configured := configuredImageRequestSchema(model.AIProvider{AspectRatios: []string{"16:9"}}, schema)
	if configured.Fields[0].Options[0].Value != "16:9" || schema.Fields[0].Options[0].Value != "1:1" {
		t.Fatal("aspect ratio override mutated source")
	}
}

func TestImageRatioConfigurationControlsAvailabilityAndSubmission(t *testing.T) {
	const id = "explicit-ratio-test"
	_ = ai.Register(ai.ProviderType{ID: id, Name: "Explicit ratios", Capabilities: []ai.Capability{ai.CapabilityImageGenerate}, ImageRequestSchema: &ai.ImageRequestSchema{Fields: []ai.ImageRequestField{{Key: "size"}}}})
	p := model.AIProvider{ID: "model", Name: "Model", Type: id, Enabled: true, Config: json.RawMessage(`{}`), ImagePrices: []model.ImageResolutionPrice{{Resolution: "1K"}}}
	settings := model.AISettings{Providers: []model.AIProvider{p}, ImageProviderID: p.ID}
	if err := validateSettings(settings); err != nil {
		t.Fatal(err)
	}
	if len(publicAIModelChoices(settings, ai.CapabilityImageGenerate)) != 0 {
		t.Fatal("unconfigured ratio exposed")
	}
	if _, err := configuredImageTaskProvider(settings, "generate", p.ID); err == nil {
		t.Fatal("unconfigured ratio accepted")
	}
	p.AspectRatios = []string{"5:4"}
	settings.Providers[0] = p
	if len(publicAIModelChoices(settings, ai.CapabilityImageGenerate)) != 1 {
		t.Fatal("configured provider unavailable")
	}
	if _, err := configuredImageTaskProvider(settings, "generate", p.ID); err != nil {
		t.Fatal(err)
	}
}
