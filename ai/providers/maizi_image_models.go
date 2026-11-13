package providers

import (
	"encoding/json"
	"strings"

	"github.com/basketikun/infinite-canvas/ai"
)

// Model differences stay here; HTTP submission, polling and error handling stay in maizi.go.
// Legacy canonicalizers are retained so persisted request hashes remain replayable.
type maiziImageModel struct {
	ID, Name, ModelPlaceholder, BaseURL string
	Schema                              *ai.ImageRequestSchema
	Canonicalize                        func(ai.ImageTaskRequest) (ai.ImageTaskRequest, error)
	Normalize                           func(ai.ImageTaskRequest) (ai.ImageTaskRequest, error)
	ExtraBody                           map[string]any
	OmitBodyFields                      []string
}

var maiziGenericModel = &maiziImageModel{
	ID: "maizi-image", Name: "MaiziAI", ModelPlaceholder: "例如：gpt-image-2", BaseURL: maiziBaseURL,
	Schema: &maiziImageRequestSchema, Canonicalize: canonicalizeMaiziImageTaskRequest,
	Normalize: func(request ai.ImageTaskRequest) (ai.ImageTaskRequest, error) {
		if len(request.References) > maiziImageRequestSchema.MaxReferenceImages {
			return ai.ImageTaskRequest{}, maiziError{message: "MaiziAI 图像编辑最多支持 7 张参考图"}
		}
		if request.Mask != nil && len(request.References) == 0 {
			return ai.ImageTaskRequest{}, maiziError{message: "遮罩编辑需要参考图"}
		}
		return canonicalizeMaiziImageTaskRequest(request)
	},
}

var maiziSeedreamNSFWModel = &maiziImageModel{
	ID: "maizi-seedream-5-pro-nsfw", Name: "MaiziAI Seedream 5.0 Pro NSFW", ModelPlaceholder: "例如：doubao-seedream-5-0-pro", BaseURL: maiziSeedreamNSFWBaseURL,
	Schema: &maiziSeedreamNSFWRequestSchema, Canonicalize: canonicalizeMaiziSeedreamNSFWRequest, Normalize: normalizeMaiziSeedreamNSFWRequest,
	ExtraBody: map[string]any{"nsfw_check": false}, OmitBodyFields: []string{"background", "quality"},
}

func registerMaiziImageModel(definition *maiziImageModel) {
	_ = ai.Register(ai.ProviderType{
		ID: definition.ID, Name: definition.Name,
		Capabilities:       []ai.Capability{ai.CapabilityImageGenerate, ai.CapabilityImageEdit},
		ImageRequestSchema: definition.Schema, CanonicalizeImageTaskRequest: definition.Canonicalize,
		ConfigFields: []ai.ConfigField{
			{Key: "apiKey", Label: "API Key", Type: "password", Required: true},
			{Key: "model", Label: "模型名称", Type: "text", Placeholder: definition.ModelPlaceholder, Required: true},
		},
		New: func(raw json.RawMessage) (ai.Provider, error) {
			instance, err := newMaiziProvider(raw)
			if err != nil {
				return nil, err
			}
			provider := instance.(*maiziProvider)
			provider.model = definition
			return provider, nil
		},
	})
}

var maiziSeedream55Schema = ai.ImageRequestSchema{
	Version: "v1", MaxReferenceImages: 10, SupportsMask: false,
	Fields: []ai.ImageRequestField{
		{Key: "size", Label: "宽高比", Type: ai.ImageRequestFieldSelect, FixedOptions: true, Default: json.RawMessage(`"1:1"`), Options: imageOptions("1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9", "2:1", "1:2")},
		{Key: "resolution", Label: "尺寸", Type: ai.ImageRequestFieldSelect, FixedOptions: true, Required: true, Default: json.RawMessage(`"2K"`), Options: imageOptions("1K", "1.5K", "2K")},
		{Key: "outputFormat", Label: "输出格式", Type: ai.ImageRequestFieldSelect, Default: json.RawMessage(`"png"`), Options: []ai.ImageRequestFieldOption{{Value: "png", Label: "PNG"}, {Value: "jpeg", Label: "JPEG"}}},
		{Key: "background", Label: "背景", Type: ai.ImageRequestFieldSelect, Default: json.RawMessage(`"auto"`), Options: []ai.ImageRequestFieldOption{{Value: "auto", Label: "自动"}, {Value: "opaque", Label: "不透明"}, {Value: "transparent", Label: "透明"}}},
	},
}

func imageOptions(values ...string) []ai.ImageRequestFieldOption {
	options := make([]ai.ImageRequestFieldOption, 0, len(values))
	for _, value := range values {
		options = append(options, ai.ImageRequestFieldOption{Value: value, Label: value})
	}
	return options
}

var maiziSeedream55Model = &maiziImageModel{
	ID: "maizi-seedream-5-5", Name: "MaiziAI Seedream 5.5", ModelPlaceholder: "seedream-5-5", BaseURL: "https://www.maizitech.ai/v1",
	Schema: &maiziSeedream55Schema, Canonicalize: canonicalizeMaiziSeedream55Request, Normalize: canonicalizeMaiziSeedream55Request,
	ExtraBody: map[string]any{"n": 1}, OmitBodyFields: []string{"quality"},
}

func init() { registerMaiziImageModel(maiziSeedream55Model) }

func canonicalizeMaiziSeedream55Request(request ai.ImageTaskRequest) (ai.ImageTaskRequest, error) {
	if strings.TrimSpace(request.Request.Prompt) == "" {
		return ai.ImageTaskRequest{}, maiziError{message: "提示词不能为空"}
	}
	if len(request.References) > maiziSeedream55Schema.MaxReferenceImages {
		return ai.ImageTaskRequest{}, maiziError{message: "Seedream 5.5 最多支持 10 张参考图"}
	}
	if request.Mask != nil {
		return ai.ImageTaskRequest{}, maiziError{message: "Seedream 5.5 不支持遮罩编辑"}
	}
	// Common legacy fields can carry quality=auto; it is never part of this model's options or wire body.
	request.Request.Quality = ""
	if request.RequestSchema == nil {
		request.RequestSchema = &maiziSeedream55Schema
	}
	return canonicalizeMaiziImageTaskRequest(request)
}
