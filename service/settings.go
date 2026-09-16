package service

import (
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

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
	VideoRequestSchema *ai.VideoRequestSchema `json:"videoRequestSchema,omitempty"`
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
		if (capability == ai.CapabilityImageGenerate || capability == ai.CapabilityImageEdit) && (len(provider.ImagePrices) == 0 || (requiresImageAspectRatios(typeInfo) && len(provider.AspectRatios) == 0)) {
			continue
		}
		if capability == ai.CapabilityVideoGenerate && (len(provider.VideoPrices) == 0 || len(provider.AspectRatios) == 0) {
			continue
		}
		choice := AIModelChoice{ID: provider.ID, Name: provider.Name, Type: typeInfo.ID}
		if capability == ai.CapabilityImageGenerate && typeInfo.ImageRequestSchema != nil {
			schema := configuredImageRequestSchema(provider, *typeInfo.ImageRequestSchema)
			choice.ImageRequestSchema = &schema
		}
		if capability == ai.CapabilityVideoGenerate {
			choice.VideoRequestSchema = configuredVideoRequestSchema(provider, typeInfo)
		}
		choices = append(choices, choice)
	}
	return choices
}

func activeImageProviderSchema(settings model.AISettings) (string, *ai.ImageRequestSchema) {
	provider, ok := findProvider(settings, settings.ImageProviderID)
	if !ok || !providerAvailable(settings, provider.ID, ai.CapabilityImageGenerate) {
		return "", nil
	}
	typeInfo, ok := ai.Type(provider.Type)
	if !ok || !typeInfo.Supports(ai.CapabilityImageGenerate) || typeInfo.ImageRequestSchema == nil {
		return "", nil
	}
	schema := configuredImageRequestSchema(provider, *typeInfo.ImageRequestSchema)
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
		normalizeProviderImagePrices(provider)
		for j := range provider.VideoPrices {
			provider.VideoPrices[j].Resolution = strings.TrimSpace(provider.VideoPrices[j].Resolution)
		}
		for j := range provider.AspectRatios {
			provider.AspectRatios[j] = strings.TrimSpace(provider.AspectRatios[j])
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
		if err := validateProviderImagePrices(provider); err != nil {
			return err
		}
		if err := validateProviderVideoSettings(provider, typeInfo); err != nil {
			return err
		}
		if typeInfo.New != nil {
			if _, err := typeInfo.New(provider.Config); err != nil {
				return err
			}
		}
	}
	if settings.ImageProviderID != "" && !providerHasCapability(settings, settings.ImageProviderID, ai.CapabilityImageGenerate) {
		return errors.New("生图供应商不可用或不支持生图")
	}
	if settings.VideoProviderID != "" && !providerHasCapability(settings, settings.VideoProviderID, ai.CapabilityVideoGenerate) {
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

func normalizeProviderImagePrices(provider *model.AIProvider) {
	for index := range provider.ImagePrices {
		provider.ImagePrices[index].Resolution = strings.TrimSpace(provider.ImagePrices[index].Resolution)
	}
}

func validateProviderImagePrices(provider model.AIProvider) error {
	seen := make(map[string]struct{}, len(provider.ImagePrices))
	for _, price := range provider.ImagePrices {
		resolution := strings.TrimSpace(price.Resolution)
		if err := validateImageResolutionParameter(resolution); err != nil {
			return err
		}
		key := strings.ToLower(resolution)
		if _, exists := seen[key]; exists {
			return errors.New("图片分辨率价格重复")
		}
		seen[key] = struct{}{}
		if err := validateImageCallAmount(price.Amount); err != nil {
			return err
		}
	}
	return nil
}

func validateImageResolutionParameter(resolution string) error {
	if resolution == "" || utf8.RuneCountInString(resolution) > 64 {
		return errors.New("图片分辨率参数必须为 1 至 64 个字符")
	}
	for _, value := range resolution {
		if unicode.IsControl(value) {
			return errors.New("图片分辨率参数不能包含控制字符")
		}
	}
	return nil
}

func configuredImageRequestSchema(provider model.AIProvider, schema ai.ImageRequestSchema) ai.ImageRequestSchema {
	schema.Fields = append([]ai.ImageRequestField(nil), schema.Fields...)
	for index := range schema.Fields {
		field := &schema.Fields[index]
		if field.Key == "size" {
			field.Required = true
			field.Type = ai.ImageRequestFieldSelect
			field.Options = make([]ai.ImageRequestFieldOption, 0, len(provider.AspectRatios))
			for _, ratio := range provider.AspectRatios {
				field.Options = append(field.Options, ai.ImageRequestFieldOption{Value: ratio, Label: ratio})
			}
			field.Default = nil
			if len(provider.AspectRatios) > 0 {
				field.Default, _ = json.Marshal(provider.AspectRatios[0])
			}
		}
		if field.Key != "resolution" {
			continue
		}
		field.Type = ai.ImageRequestFieldSelect
		field.Required = true
		field.Options = make([]ai.ImageRequestFieldOption, 0, len(provider.ImagePrices))
		for _, price := range provider.ImagePrices {
			resolution := strings.TrimSpace(price.Resolution)
			field.Options = append(field.Options, ai.ImageRequestFieldOption{Value: resolution, Label: resolution, Price: price.Amount.String()})
		}
		if len(field.Options) > 0 {
			field.Default, _ = json.Marshal(field.Options[0].Value)
		} else {
			field.Default = nil
		}
	}
	return schema
}

func providerAvailable(settings model.AISettings, id string, capability ai.Capability) bool {
	provider, ok := findProvider(settings, id)
	if !ok || !provider.Enabled {
		return false
	}
	typeInfo, ok := ai.Type(provider.Type)
	if !ok || !typeInfo.Supports(capability) {
		return false
	}
	if capability == ai.CapabilityVideoGenerate {
		return len(provider.VideoPrices) > 0 && len(provider.AspectRatios) > 0
	}
	return (capability != ai.CapabilityImageGenerate && capability != ai.CapabilityImageEdit) || (len(provider.ImagePrices) > 0 && (!requiresImageAspectRatios(typeInfo) || len(provider.AspectRatios) > 0))
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

func configuredVideoRequestSchema(provider model.AIProvider, info ai.ProviderType) *ai.VideoRequestSchema {
	schema := ai.VideoRequestSchema{MinDuration: 4, MaxDuration: 15, DefaultDuration: 5, MaxReferenceImages: 9, MaxReferenceVideos: 3, MaxReferenceVideoDuration: 15, SupportsAudio: true}
	if info.VideoRequestSchema != nil {
		schema = *info.VideoRequestSchema
	}
	schema.AspectRatios = append([]string(nil), provider.AspectRatios...)
	schema.Resolutions = make([]ai.ImageRequestFieldOption, 0, len(provider.VideoPrices))
	for _, price := range provider.VideoPrices {
		schema.Resolutions = append(schema.Resolutions, ai.ImageRequestFieldOption{Value: price.Resolution, Label: price.Resolution, Price: price.Amount.String()})
	}
	return &schema
}

var aspectRatioParameter = regexp.MustCompile(`^[1-9][0-9]{0,3}:[1-9][0-9]{0,3}$`)

func validateProviderVideoSettings(provider model.AIProvider, info ai.ProviderType) error {
	if len(provider.AspectRatios) > 0 && !info.Supports(ai.CapabilityVideoGenerate) {
		supportsRatio := false
		if info.ImageRequestSchema != nil {
			for _, field := range info.ImageRequestSchema.Fields {
				if field.Key == "size" {
					supportsRatio = true
				}
			}
		}
		if !supportsRatio {
			return errors.New("当前图片供应商不支持独立比例参数，请通过分辨率配置尺寸")
		}
	}
	seenRatios := map[string]bool{}
	for _, ratio := range provider.AspectRatios {
		if !aspectRatioParameter.MatchString(ratio) && ratio != "auto" {
			return errors.New("比例必须为正整数比例（例如 16:9）或 auto")
		}
		if seenRatios[ratio] {
			return errors.New("比例参数重复")
		}
		seenRatios[ratio] = true
	}
	seen := map[string]bool{}
	for _, price := range provider.VideoPrices {
		if err := validateImageResolutionParameter(price.Resolution); err != nil {
			return errors.New("视频分辨率参数必须为 1 至 64 个非控制字符")
		}
		key := strings.ToLower(price.Resolution)
		if seen[key] {
			return errors.New("视频分辨率价格重复")
		}
		seen[key] = true
		if err := validateImageCallAmount(price.Amount); err != nil {
			return errors.New("视频每秒价格必须为非负金额，最多四位小数且不超过 99999999.9999")
		}
	}
	return nil
}

func requiresImageAspectRatios(info ai.ProviderType) bool {
	if info.ImageRequestSchema != nil {
		for _, field := range info.ImageRequestSchema.Fields {
			if field.Key == "size" {
				return true
			}
		}
	}
	return false
}

// A selected default may be incomplete while an administrator configures it.
func providerHasCapability(settings model.AISettings, id string, capability ai.Capability) bool {
	p, ok := findProvider(settings, id)
	if !ok || !p.Enabled {
		return false
	}
	info, ok := ai.Type(p.Type)
	return ok && info.Supports(capability)
}
