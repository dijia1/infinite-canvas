package service

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/basketikun/infinite-canvas/ai"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

type AIStatus struct {
	ImageAvailable bool `json:"imageAvailable"`
	ImageEditable  bool `json:"imageEditable"`
	VideoAvailable bool `json:"videoAvailable"`
}

func PublicSettings() (AIStatus, error) {
	settings, err := AdminSettings()
	if err != nil {
		return AIStatus{}, err
	}
	return AIStatus{
		ImageAvailable: providerAvailable(settings.AI, settings.AI.ImageProviderID, ai.CapabilityImageGenerate),
		ImageEditable:  providerAvailable(settings.AI, settings.AI.ImageProviderID, ai.CapabilityImageEdit),
		VideoAvailable: providerAvailable(settings.AI, settings.AI.VideoProviderID, ai.CapabilityVideoGenerate),
	}, nil
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

func GenerateImages(ctx context.Context, request ai.ImageRequest) ([]ai.ImageResult, error) {
	provider, err := resolveProvider(ai.CapabilityImageGenerate)
	if err != nil {
		return nil, err
	}
	generator, ok := provider.(ai.ImageGenerator)
	if !ok {
		return nil, errors.New("当前生图供应商未实现文生图")
	}
	images, err := generator.GenerateImage(ctx, request)
	if err != nil {
		return nil, err
	}
	return persistGeneratedImages(ctx, images)
}

func EditImages(ctx context.Context, request ai.ImageRequest, references []ai.ImageReference) ([]ai.ImageResult, error) {
	provider, err := resolveProvider(ai.CapabilityImageEdit)
	if err != nil {
		return nil, err
	}
	editor, ok := provider.(ai.ImageEditor)
	if !ok {
		return nil, errors.New("当前生图供应商不支持图像编辑")
	}
	images, err := editor.EditImage(ctx, request, references)
	if err != nil {
		return nil, err
	}
	return persistGeneratedImages(ctx, images)
}

func CreateVideo(ctx context.Context, request ai.VideoRequest) (ai.VideoTask, error) {
	provider, err := resolveProvider(ai.CapabilityVideoGenerate)
	if err != nil {
		return ai.VideoTask{}, err
	}
	generator, ok := provider.(ai.VideoGenerator)
	if !ok {
		return ai.VideoTask{}, errors.New("当前生视频供应商未实现")
	}
	return generator.CreateVideo(ctx, request)
}

func GetVideo(ctx context.Context, id string) (ai.VideoTask, error) {
	provider, err := resolveProvider(ai.CapabilityVideoGenerate)
	if err != nil {
		return ai.VideoTask{}, err
	}
	generator, ok := provider.(ai.VideoGenerator)
	if !ok {
		return ai.VideoTask{}, errors.New("当前生视频供应商未实现")
	}
	return generator.GetVideo(ctx, id)
}

func GetVideoContent(ctx context.Context, id string) (ai.VideoContent, error) {
	provider, err := resolveProvider(ai.CapabilityVideoGenerate)
	if err != nil {
		return ai.VideoContent{}, err
	}
	generator, ok := provider.(ai.VideoGenerator)
	if !ok {
		return ai.VideoContent{}, errors.New("当前生视频供应商未实现")
	}
	return generator.GetVideoContent(ctx, id)
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

func providerAvailable(settings model.AISettings, id string, capability ai.Capability) bool {
	provider, ok := findProvider(settings, id)
	if !ok || !provider.Enabled {
		return false
	}
	typeInfo, ok := ai.Type(provider.Type)
	return ok && typeInfo.Supports(capability)
}

func resolveProvider(capability ai.Capability) (ai.Provider, error) {
	settings, err := AdminSettings()
	if err != nil {
		return nil, err
	}
	id := settings.AI.ImageProviderID
	if capability == ai.CapabilityVideoGenerate {
		id = settings.AI.VideoProviderID
	}
	if id == "" {
		return nil, errors.New("管理员尚未配置可用供应商")
	}
	provider, ok := findProvider(settings.AI, id)
	if !ok || !provider.Enabled {
		return nil, errors.New("当前供应商不可用")
	}
	typeInfo, ok := ai.Type(provider.Type)
	if !ok || !typeInfo.Supports(capability) {
		if capability == ai.CapabilityImageEdit {
			return nil, errors.New("当前生图供应商不支持图像编辑")
		}
		return nil, errors.New("当前供应商不支持此能力")
	}
	if typeInfo.New == nil {
		return nil, errors.New("当前供应商未实现")
	}
	return typeInfo.New(provider.Config)
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
