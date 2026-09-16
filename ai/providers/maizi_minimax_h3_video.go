package providers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/basketikun/infinite-canvas/ai"
)

var maiziMiniMaxH3VideoRequestSchema = ai.VideoRequestSchema{
	MinDuration: 5, MaxDuration: 15, DefaultDuration: 5,
	MaxReferenceImages: 9, MaxReferenceVideos: 0, MaxReferenceVideoDuration: 0,
	SupportsAudio: false,
}

type maiziMiniMaxH3VideoProvider struct {
	config maiziConfig
	client *http.Client
}

func init() {
	_ = ai.Register(ai.ProviderType{
		ID: "maizi-video-minimax-h3", Name: "MaiziAI MiniMax H3", Capabilities: []ai.Capability{ai.CapabilityVideoGenerate},
		ConfigFields: []ai.ConfigField{
			{Key: "apiKey", Label: "API Key", Type: "password", Required: true},
			{Key: "model", Label: "模型名称", Type: "text", Placeholder: "minimax-h3", Required: true},
		},
		VideoRequestSchema: &maiziMiniMaxH3VideoRequestSchema,
		New:                newMaiziMiniMaxH3VideoProvider,
	})
}

func newMaiziMiniMaxH3VideoProvider(raw json.RawMessage) (ai.Provider, error) {
	var config maiziConfig
	if json.Unmarshal(raw, &config) != nil {
		return nil, maiziError{"MiniMax H3 视频供应商配置无效"}
	}
	config.APIKey = strings.TrimSpace(config.APIKey)
	config.Model = strings.TrimSpace(config.Model)
	if config.APIKey == "" || config.Model == "" {
		return nil, maiziError{"请填写 MiniMax H3 API Key 和模型名称"}
	}
	return &maiziMiniMaxH3VideoProvider{config: config, client: newMaiziVideoHTTPClient()}, nil
}

func (provider *maiziMiniMaxH3VideoProvider) CreateVideo(ctx context.Context, request ai.VideoRequest) (ai.VideoTask, error) {
	model := strings.TrimSpace(provider.config.Model)
	if model == "" {
		return ai.VideoTask{}, &ai.VideoSubmissionError{Message: "MiniMax H3 模型名称不能为空"}
	}
	duration, err := strconv.Atoi(request.Seconds)
	if err != nil || duration < maiziMiniMaxH3VideoRequestSchema.MinDuration || duration > maiziMiniMaxH3VideoRequestSchema.MaxDuration {
		return ai.VideoTask{}, &ai.VideoSubmissionError{Message: "MiniMax H3 视频时长必须为 5 至 15 秒整数"}
	}
	prompt := strings.TrimSpace(request.Prompt)
	size := strings.TrimSpace(request.Size)
	resolution := strings.TrimSpace(request.Resolution)
	if prompt == "" || size == "" || resolution == "" {
		return ai.VideoTask{}, &ai.VideoSubmissionError{Message: "MiniMax H3 视频提示词、比例和分辨率不能为空"}
	}
	if request.GenerateAudio || len(request.VideoURLs) > 0 || len(request.References) > 0 {
		return ai.VideoTask{}, &ai.VideoSubmissionError{Message: "MiniMax H3 当前仅支持文本和图片参考输入"}
	}
	if len(request.ImageURLs) > maiziMiniMaxH3VideoRequestSchema.MaxReferenceImages {
		return ai.VideoTask{}, &ai.VideoSubmissionError{Message: "MiniMax H3 最多支持 9 张参考图片"}
	}
	for _, rawURL := range request.ImageURLs {
		parsed, parseErr := url.Parse(rawURL)
		if parseErr != nil || parsed.Host == "" || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.User != nil {
			return ai.VideoTask{}, &ai.VideoSubmissionError{Message: "MiniMax H3 参考图片地址无效"}
		}
	}
	payload := struct {
		Model      string   `json:"model"`
		Prompt     string   `json:"prompt"`
		Duration   int      `json:"duration"`
		Resolution string   `json:"resolution"`
		Size       string   `json:"size"`
		ImageURLs  []string `json:"image_urls,omitempty"`
	}{model, prompt, duration, resolution, size, request.ImageURLs}
	body, _ := json.Marshal(payload)
	return provider.transport().request(ctx, http.MethodPost, "/videos/generations", body, true)
}

func (provider *maiziMiniMaxH3VideoProvider) GetVideo(ctx context.Context, id string) (ai.VideoTask, error) {
	return provider.transport().GetVideo(ctx, id)
}

func (provider *maiziMiniMaxH3VideoProvider) GetVideoContent(ctx context.Context, id string) (ai.VideoContent, error) {
	return provider.transport().GetVideoContent(ctx, id)
}

func (provider *maiziMiniMaxH3VideoProvider) transport() *maiziVideoProvider {
	return &maiziVideoProvider{config: provider.config, client: provider.client}
}

var _ ai.VideoGenerator = (*maiziMiniMaxH3VideoProvider)(nil)
