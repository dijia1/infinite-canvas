package providers

import (
	"encoding/json"
	"strings"

	"github.com/basketikun/infinite-canvas/ai"
)

const maiziSeedreamNSFWBaseURL = "https://www.maizitech.ai/v1"

var maiziSeedreamNSFWRequestSchema = ai.ImageRequestSchema{
	Version:            "v1",
	MaxReferenceImages: 10,
	SupportsMask:       false,
	Fields: []ai.ImageRequestField{
		{Key: "size", Label: "宽高比", Type: ai.ImageRequestFieldSelect, Default: json.RawMessage(`"1:1"`), Options: []ai.ImageRequestFieldOption{
			{Value: "1:1", Label: "1:1"}, {Value: "3:2", Label: "3:2"}, {Value: "2:3", Label: "2:3"}, {Value: "4:3", Label: "4:3"}, {Value: "3:4", Label: "3:4"}, {Value: "16:9", Label: "16:9"}, {Value: "9:16", Label: "9:16"}, {Value: "21:9", Label: "21:9"}, {Value: "auto", Label: "自动"},
		}},
		{Key: "resolution", Label: "尺寸", Type: ai.ImageRequestFieldText, Required: true},
		{Key: "outputFormat", Label: "输出格式", Type: ai.ImageRequestFieldSelect, Default: json.RawMessage(`"jpeg"`), Options: []ai.ImageRequestFieldOption{{Value: "jpeg", Label: "JPEG"}, {Value: "png", Label: "PNG"}}},
	},
}

func init() {
	_ = ai.Register(ai.ProviderType{
		ID:                           "maizi-seedream-5-pro-nsfw",
		Name:                         "MaiziAI Seedream 5.0 Pro NSFW",
		Capabilities:                 []ai.Capability{ai.CapabilityImageGenerate, ai.CapabilityImageEdit},
		ImageRequestSchema:           &maiziSeedreamNSFWRequestSchema,
		CanonicalizeImageTaskRequest: canonicalizeMaiziSeedreamNSFWRequest,
		ConfigFields: []ai.ConfigField{
			{Key: "apiKey", Label: "API Key", Type: "password", Required: true},
			{Key: "model", Label: "模型名称", Type: "text", Placeholder: "例如：doubao-seedream-5-0-pro", Required: true},
		},
		New: newMaiziSeedreamNSFWProvider,
	})
}

func newMaiziSeedreamNSFWProvider(raw json.RawMessage) (ai.Provider, error) {
	instance, err := newMaiziProvider(raw)
	if err != nil {
		return nil, err
	}
	provider := instance.(*maiziProvider)
	provider.seedreamNSFW = true
	return provider, nil
}

func normalizeMaiziSeedreamNSFWRequest(request ai.ImageTaskRequest) (ai.ImageTaskRequest, error) {
	if len(request.References) > maiziSeedreamNSFWRequestSchema.MaxReferenceImages {
		return ai.ImageTaskRequest{}, maiziError{message: "MaiziAI Seedream Pro 最多支持 10 张参考图"}
	}
	if request.Mask != nil {
		return ai.ImageTaskRequest{}, maiziError{message: "MaiziAI Seedream Pro 不支持遮罩编辑"}
	}
	return canonicalizeMaiziSeedreamNSFWRequest(request)
}

func canonicalizeMaiziSeedreamNSFWRequest(request ai.ImageTaskRequest) (ai.ImageTaskRequest, error) {
	if strings.TrimSpace(request.Request.Background) == "transparent" {
		return ai.ImageTaskRequest{}, maiziError{message: "MaiziAI Seedream Pro 不支持透明背景"}
	}
	options := cloneImageRequestOptions(request.Request.Options)
	setImageRequestOption(options, "size", request.Request.Size)
	setImageRequestOption(options, "resolution", request.Request.Resolution)
	setImageRequestOption(options, "outputFormat", request.Request.OutputFormat)
	schema := maiziSeedreamNSFWRequestSchema
	if request.RequestSchema != nil {
		schema = *request.RequestSchema
	}
	normalized, err := ai.NormalizeImageRequestOptions(schema, options)
	if err != nil {
		return ai.ImageTaskRequest{}, maiziError{message: err.Error()}
	}
	request.Request.Options = normalized
	request.Request.Size = imageRequestOptionString(normalized, "size")
	request.Request.Resolution = imageRequestOptionString(normalized, "resolution")
	request.Request.OutputFormat = imageRequestOptionString(normalized, "outputFormat")
	request.Request.Quality = ""
	request.Request.Background = "opaque"
	return request, nil
}
