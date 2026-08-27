package service

import (
	"testing"

	"github.com/basketikun/infinite-canvas/ai"
	"github.com/basketikun/infinite-canvas/model"
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
		Providers:       []model.AIProvider{{ID: "seedream", Type: registeredType, Enabled: true}},
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
		{ID: "enabled", Name: "可选模型", Type: providerType, Enabled: true, Config: []byte(`{"apiKey":"secret","model":"internal-model"}`)},
		{ID: "disabled", Name: "不可选模型", Type: providerType, Enabled: false, Config: []byte(`{"apiKey":"secret"}`)},
	}}
	choices := publicAIModelChoices(settings, ai.CapabilityImageGenerate)
	if len(choices) != 1 || choices[0].ID != "enabled" || choices[0].Name != "可选模型" || choices[0].ImageRequestSchema == nil {
		t.Fatalf("publicAIModelChoices() = %#v", choices)
	}
}
