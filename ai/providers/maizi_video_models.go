package providers

import (
	"encoding/json"

	"github.com/basketikun/infinite-canvas/ai"
)

type maiziVideoModelDefinition struct {
	ID, Name, Model, OutputFormat string
	Schema                        ai.VideoRequestSchema
}

var maiziSeedanceVideoModel = maiziVideoModelDefinition{
	ID: "maizi-video-seedance", Name: "MaiziAiVideo Seedance",
	Schema: ai.VideoRequestSchema{
		MinDuration: 4, MaxDuration: 15, DefaultDuration: 5,
		MaxReferenceImages: 9, MaxReferenceVideos: 3, MaxReferenceVideoDuration: 15, SupportsAudio: true,
	},
}

var maiziSeedance25VideoModel = maiziVideoModelDefinition{
	ID: "maizi-video-seedance-2-5", Name: "MaiziAI Seedance 2.5", Model: "doubao-seedance-2.5", OutputFormat: "mp4",
	Schema: ai.VideoRequestSchema{
		MinDuration: 4, MaxDuration: 30, DefaultDuration: 5,
		MaxReferenceImages: 30, MaxReferenceVideos: 10, SupportsAudio: true, SupportsDraft: true,
		Resolutions: []ai.ImageRequestFieldOption{{Value: "480p", Label: "480p"}, {Value: "720p", Label: "720p"}, {Value: "1080p", Label: "1080p"}},
	},
}

var maiziSeedance25FlashVideoModel = maiziVideoModelDefinition{
	ID: "maizi-video-seedance-2-5-flash", Name: "MaiziAI Seedance 2.5 Flash", Model: "doubao-seedance-2.5-flash", OutputFormat: "mp4",
	Schema: ai.VideoRequestSchema{
		MinDuration: 4, MaxDuration: 30, DefaultDuration: 5,
		MaxReferenceImages: 6, MaxReferenceVideos: 3, MaxReferenceMedia: 6, MaxReferenceVideoDuration: 15, SupportsAudio: true,
		DefaultResolution: "480p", DefaultAspectRatio: "16:9",
		Resolutions:  []ai.ImageRequestFieldOption{{Value: "480p", Label: "480p"}, {Value: "720p", Label: "720p"}},
		AspectRatios: []string{"16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive"},
	},
}

func init() {
	for _, definition := range []maiziVideoModelDefinition{maiziSeedanceVideoModel, maiziSeedance25VideoModel, maiziSeedance25FlashVideoModel} {
		placeholder := definition.Model
		if placeholder == "" {
			placeholder = "doubao-seedance-2.0"
		}
		_ = ai.Register(ai.ProviderType{ID: definition.ID, Name: definition.Name, Capabilities: []ai.Capability{ai.CapabilityVideoGenerate}, ConfigFields: []ai.ConfigField{
			{Key: "apiKey", Label: "API Key", Type: "password", Required: true},
			{Key: "model", Label: "模型名称", Type: "text", Placeholder: placeholder, Required: true},
		}, VideoRequestSchema: &definition.Schema, New: func(raw json.RawMessage) (ai.Provider, error) {
			return newMaiziVideoProvider(raw, definition)
		}})
	}
}
