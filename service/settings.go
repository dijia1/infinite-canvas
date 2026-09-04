package service

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"

	"github.com/basketikun/infinite-canvas/ai"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/shopspring/decimal"
)

type AIStatus struct {
	ImageAvailable      bool                   `json:"imageAvailable"`
	ImageEditable       bool                   `json:"imageEditable"`
	VideoAvailable      bool                   `json:"videoAvailable"`
	ImageProviderType   string                 `json:"imageProviderType,omitempty"`
	ImageRequestSchema  *ai.ImageRequestSchema `json:"imageRequestSchema,omitempty"`
	ImageModels         []AIModelChoice        `json:"imageModels"`
	VideoModels         []AIModelChoice        `json:"videoModels"`
	DefaultImageModelID string                 `json:"defaultImageModelId,omitempty"`
	DefaultVideoModelID string                 `json:"defaultVideoModelId,omitempty"`
}

// AIModelChoice is safe to return to ordinary users. It deliberately omits
// the provider configuration, including API keys and other private values.
type AIModelChoice struct {
	ID                 string                 `json:"id"`
	Name               string                 `json:"name"`
	Type               string                 `json:"type"`
	ImageRequestSchema *ai.ImageRequestSchema `json:"imageRequestSchema,omitempty"`
}

func PublicSettings() (AIStatus, error) {
	settings, err := AdminSettings()
	if err != nil {
		return AIStatus{}, err
	}
	imageProviderType, imageRequestSchema := activeImageProviderSchema(settings.AI)
	imageModels := publicAIModelChoices(settings.AI, ai.CapabilityImageGenerate)
	videoModels := publicAIModelChoices(settings.AI, ai.CapabilityVideoGenerate)
	return AIStatus{
		ImageAvailable:      len(imageModels) > 0,
		ImageEditable:       providerAvailable(settings.AI, settings.AI.ImageProviderID, ai.CapabilityImageEdit),
		VideoAvailable:      len(videoModels) > 0,
		ImageProviderType:   imageProviderType,
		ImageRequestSchema:  imageRequestSchema,
		ImageModels:         imageModels,
		VideoModels:         videoModels,
		DefaultImageModelID: settings.AI.ImageProviderID,
		DefaultVideoModelID: settings.AI.VideoProviderID,
	}, nil
}

func publicAIModelChoices(settings model.AISettings, capability ai.Capability) []AIModelChoice {
	choices := make([]AIModelChoice, 0)
	for _, provider := range settings.Providers {
		if !provider.Enabled {
			continue
		}
		typeInfo, ok := ai.Type(provider.Type)
		if !ok || !typeInfo.Supports(capability) {
			continue
		}
		choice := AIModelChoice{ID: provider.ID, Name: provider.Name, Type: typeInfo.ID}
		if capability == ai.CapabilityImageGenerate && typeInfo.ImageRequestSchema != nil {
			schema := *typeInfo.ImageRequestSchema
			schema.Fields = append([]ai.ImageRequestField(nil), typeInfo.ImageRequestSchema.Fields...)
			choice.ImageRequestSchema = &schema
		}
		choices = append(choices, choice)
	}
	return choices
}

func activeImageProviderSchema(settings model.AISettings) (string, *ai.ImageRequestSchema) {
	provider, ok := findProvider(settings, settings.ImageProviderID)
	if !ok || !provider.Enabled {
		return "", nil
	}
	typeInfo, ok := ai.Type(provider.Type)
	if !ok || !typeInfo.Supports(ai.CapabilityImageGenerate) || typeInfo.ImageRequestSchema == nil {
		return "", nil
	}
	schema := *typeInfo.ImageRequestSchema
	schema.Fields = append([]ai.ImageRequestField(nil), typeInfo.ImageRequestSchema.Fields...)
	return typeInfo.ID, &schema
}

func AdminSettings() (model.Settings, error) {
	settings, err := repository.GetSettings()
	return normalizeSettings(settings), err
}

func SaveSettings(settings model.Settings) (model.Settings, error) {
	settings = normalizeSettings(settings)
	if err := validateSettings(settings.AI); err != nil {
		return model.Settings{}, err
	}
	result, err := repository.SaveSettings(settings, now())
	return normalizeSettings(result), err
}

func AIProviderTypes() []ai.ProviderType { return ai.Types() }

func CreateVideo(ctx context.Context, request ai.VideoRequest) (ai.VideoTask, error) {
	provider, providerID, err := resolveProviderAndID(ai.CapabilityVideoGenerate, request.ProviderID)
	if err != nil {
		return ai.VideoTask{}, err
	}
	generator, ok := provider.(ai.VideoGenerator)
	if !ok {
		return ai.VideoTask{}, errors.New("当前生视频供应商未实现")
	}
	task, err := generator.CreateVideo(ctx, request)
	if err != nil {
		return ai.VideoTask{}, err
	}
	task.ID = encodeVideoTaskID(providerID, task.ID)
	return task, nil
}

func GetVideo(ctx context.Context, id string) (ai.VideoTask, error) {
	providerID, upstreamID, encoded := decodeVideoTaskID(id)
	if !encoded {
		upstreamID = id
	}
	provider, err := resolveProviderForID(ai.CapabilityVideoGenerate, providerID)
	if err != nil {
		return ai.VideoTask{}, err
	}
	generator, ok := provider.(ai.VideoGenerator)
	if !ok {
		return ai.VideoTask{}, errors.New("当前生视频供应商未实现")
	}
	task, err := generator.GetVideo(ctx, upstreamID)
	if err != nil {
		return ai.VideoTask{}, err
	}
	task.ID = id
	return task, nil
}

func GetVideoContent(ctx context.Context, id string) (ai.VideoContent, error) {
	providerID, upstreamID, encoded := decodeVideoTaskID(id)
	if !encoded {
		upstreamID = id
	}
	provider, err := resolveProviderForID(ai.CapabilityVideoGenerate, providerID)
	if err != nil {
		return ai.VideoContent{}, err
	}
	generator, ok := provider.(ai.VideoGenerator)
	if !ok {
		return ai.VideoContent{}, errors.New("当前生视频供应商未实现")
	}
	return generator.GetVideoContent(ctx, upstreamID)
}

func normalizeSettings(settings model.Settings) model.Settings {
	if settings.AI.Providers == nil {
		settings.AI.Providers = []model.AIProvider{}
	}
	for i := range settings.AI.Providers {
		provider := &settings.AI.Providers[i]
		provider.ID = strings.TrimSpace(provider.ID)
		provider.Name = strings.TrimSpace(provider.Name)
		provider.Type = strings.TrimSpace(provider.Type)
		if len(provider.Config) == 0 {
			provider.Config = json.RawMessage("{}")
		}
	}
	return settings
}

func validateSettings(settings model.AISettings) error {
	seen := map[string]bool{}
	for _, provider := range settings.Providers {
		if provider.ID == "" || provider.Name == "" || provider.Type == "" {
			return errors.New("供应商实例配置不完整")
		}
		if seen[provider.ID] {
			return errors.New("供应商实例 ID 重复")
		}
		seen[provider.ID] = true
		typeInfo, ok := ai.Type(provider.Type)
		if !ok {
			return errors.New("供应商类型未注册")
		}
		if !json.Valid(provider.Config) {
			return errors.New("供应商参数不是有效 JSON")
		}
		if err := validateImageCallAmount(provider.ImageCallAmount); err != nil {
			return err
		}
		if typeInfo.New != nil {
			if _, err := typeInfo.New(provider.Config); err != nil {
				return err
			}
		}
	}
	if settings.ImageProviderID != "" && !providerAvailable(settings, settings.ImageProviderID, ai.CapabilityImageGenerate) {
		return errors.New("生图供应商不可用或不支持生图")
	}
	if settings.VideoProviderID != "" && !providerAvailable(settings, settings.VideoProviderID, ai.CapabilityVideoGenerate) {
		return errors.New("生视频供应商不可用或不支持生视频")
	}
	return nil
}

var maximumImageCallAmount = decimal.RequireFromString("99999999.9999")

func validateImageCallAmount(amount decimal.Decimal) error {
	if amount.IsNegative() || amount.GreaterThan(maximumImageCallAmount) || amount.Exponent() < -4 {
		return errors.New("图片调用单价必须是 0 至 99999999.9999 之间、最多四位小数的金额")
	}
	return nil
}

func providerAvailable(settings model.AISettings, id string, capability ai.Capability) bool {
	provider, ok := findProvider(settings, id)
	if !ok || !provider.Enabled {
		return false
	}
	typeInfo, ok := ai.Type(provider.Type)
	return ok && typeInfo.Supports(capability)
}

func resolveProviderForID(capability ai.Capability, requestedProviderID string) (ai.Provider, error) {
	provider, _, err := resolveProviderAndID(capability, requestedProviderID)
	return provider, err
}

func resolveProviderAndID(capability ai.Capability, requestedProviderID string) (ai.Provider, string, error) {
	settings, err := AdminSettings()
	if err != nil {
		return nil, "", err
	}
	id := strings.TrimSpace(requestedProviderID)
	if id == "" {
		id = settings.AI.ImageProviderID
		if capability == ai.CapabilityVideoGenerate {
			id = settings.AI.VideoProviderID
		}
	}
	if id == "" {
		return nil, "", errors.New("管理员尚未配置可用供应商")
	}
	provider, ok := findProvider(settings.AI, id)
	if !ok || !provider.Enabled {
		return nil, "", errors.New("当前供应商不可用")
	}
	typeInfo, ok := ai.Type(provider.Type)
	if !ok || !typeInfo.Supports(capability) {
		if capability == ai.CapabilityImageEdit {
			return nil, "", errors.New("当前生图供应商不支持图像编辑")
		}
		return nil, "", errors.New("当前供应商不支持此能力")
	}
	if typeInfo.New == nil {
		return nil, "", errors.New("当前供应商未实现")
	}
	instance, err := typeInfo.New(provider.Config)
	if err != nil {
		return nil, "", err
	}
	return instance, provider.ID, nil
}

const videoTaskIDPrefix = "provider:"

func encodeVideoTaskID(providerID, upstreamID string) string {
	providerID = strings.TrimSpace(providerID)
	if providerID == "" || strings.TrimSpace(upstreamID) == "" {
		return upstreamID
	}
	payload, _ := json.Marshal([2]string{providerID, upstreamID})
	return videoTaskIDPrefix + base64.RawURLEncoding.EncodeToString(payload)
}

func decodeVideoTaskID(id string) (providerID, upstreamID string, ok bool) {
	if !strings.HasPrefix(id, videoTaskIDPrefix) {
		return "", "", false
	}
	payload, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(id, videoTaskIDPrefix))
	if err != nil {
		return "", "", false
	}
	var values [2]string
	if err := json.Unmarshal(payload, &values); err != nil || strings.TrimSpace(values[0]) == "" || strings.TrimSpace(values[1]) == "" {
		return "", "", false
	}
	return values[0], values[1], true
}

func findProvider(settings model.AISettings, id string) (model.AIProvider, bool) {
	for _, provider := range settings.Providers {
		if provider.ID == id {
			return provider, true
		}
	}
	return model.AIProvider{}, false
}

type safeMessageError struct{ message string }

func (err safeMessageError) Error() string       { return err.message }
func (err safeMessageError) SafeMessage() string { return err.message }
