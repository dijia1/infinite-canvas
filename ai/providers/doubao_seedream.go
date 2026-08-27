package providers

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/basketikun/infinite-canvas/ai"
)

const doubaoSeedreamBaseURL = "https://ark.cn-beijing.volces.com/api/v3"

type doubaoSeedreamConfig struct {
	APIKey string `json:"apiKey"`
	Model  string `json:"model"`
}

type doubaoSeedreamProvider struct {
	config doubaoSeedreamConfig
	client *http.Client
}

type doubaoSeedreamError struct{ message string }

func (err doubaoSeedreamError) Error() string       { return err.message }
func (err doubaoSeedreamError) SafeMessage() string { return err.message }

var doubaoSeedreamImageRequestSchema = ai.ImageRequestSchema{
	Version:            "v1",
	MaxReferenceImages: 10,
	SupportsMask:       false,
	Fields: []ai.ImageRequestField{
		{Key: "size", Label: "宽高比", Type: ai.ImageRequestFieldSelect, Default: json.RawMessage(`"1:1"`), Options: []ai.ImageRequestFieldOption{{Value: "1:1", Label: "1:1"}, {Value: "3:2", Label: "3:2"}, {Value: "2:3", Label: "2:3"}, {Value: "4:3", Label: "4:3"}, {Value: "3:4", Label: "3:4"}, {Value: "16:9", Label: "16:9"}, {Value: "9:16", Label: "9:16"}, {Value: "21:9", Label: "21:9"}, {Value: "auto", Label: "自动"}}},
		{Key: "resolution", Label: "尺寸", Type: ai.ImageRequestFieldSelect, Default: json.RawMessage(`"1k"`), Options: []ai.ImageRequestFieldOption{{Value: "1k", Label: "1K"}, {Value: "1.5k", Label: "1.5K"}, {Value: "2k", Label: "2K"}}},
		{Key: "outputFormat", Label: "输出格式", Type: ai.ImageRequestFieldSelect, Default: json.RawMessage(`"jpeg"`), Options: []ai.ImageRequestFieldOption{{Value: "jpeg", Label: "JPEG"}, {Value: "png", Label: "PNG"}}},
		{Key: "background", Label: "背景", Type: ai.ImageRequestFieldSelect, Default: json.RawMessage(`"opaque"`), Options: []ai.ImageRequestFieldOption{{Value: "opaque", Label: "不透明"}, {Value: "transparent", Label: "透明"}}},
	},
}

var doubaoSeedreamDimensions = map[string]map[string]string{
	"1k":   {"1:1": "1024x1024", "4:3": "1152x864", "3:4": "864x1152", "16:9": "1424x800", "9:16": "800x1424", "3:2": "1248x832", "2:3": "832x1248", "21:9": "1568x672"},
	"1.5k": {"1:1": "1536x1536", "4:3": "1792x1344", "3:4": "1344x1792", "16:9": "2048x1152", "9:16": "1152x2048", "3:2": "1872x1248", "2:3": "1248x1872", "21:9": "2352x1008"},
	"2k":   {"1:1": "2048x2048", "4:3": "2368x1776", "3:4": "1776x2368", "16:9": "2816x1584", "9:16": "1584x2816", "3:2": "2496x1664", "2:3": "1664x2496", "21:9": "3136x1344"},
}

func init() {
	_ = ai.Register(ai.ProviderType{
		ID:                 "doubao-seedream-5-pro",
		Name:               "Doubao Seedream 5.0 Pro",
		Capabilities:       []ai.Capability{ai.CapabilityImageGenerate, ai.CapabilityImageEdit},
		ImageRequestSchema: &doubaoSeedreamImageRequestSchema,
		ConfigFields: []ai.ConfigField{
			{Key: "apiKey", Label: "API Key", Type: "password", Required: true},
			{Key: "model", Label: "模型名称", Type: "text", Placeholder: "例如：doubao-seedream-5-0-pro-260628", Required: true},
		},
		New: newDoubaoSeedreamProvider,
	})
}

func newDoubaoSeedreamProvider(raw json.RawMessage) (ai.Provider, error) {
	var config doubaoSeedreamConfig
	if err := json.Unmarshal(raw, &config); err != nil {
		return nil, doubaoSeedreamError{message: "Doubao Seedream 配置无效"}
	}
	config.APIKey = strings.TrimSpace(config.APIKey)
	config.Model = strings.TrimSpace(config.Model)
	if config.APIKey == "" || config.Model == "" {
		return nil, doubaoSeedreamError{message: "请填写 Doubao Seedream API Key 和模型名称"}
	}
	return &doubaoSeedreamProvider{config: config, client: &http.Client{}}, nil
}

func (provider *doubaoSeedreamProvider) NormalizeImageTaskRequest(request ai.ImageTaskRequest) (ai.ImageTaskRequest, error) {
	if len(request.References) > doubaoSeedreamImageRequestSchema.MaxReferenceImages {
		return ai.ImageTaskRequest{}, doubaoSeedreamError{message: "Doubao Seedream 最多支持 10 张参考图"}
	}
	if request.Mask != nil {
		return ai.ImageTaskRequest{}, doubaoSeedreamError{message: "Doubao Seedream 暂不支持手绘遮罩编辑"}
	}
	options := cloneImageRequestOptions(request.Request.Options)
	delete(options, "watermark")
	setSeedreamLegacyOption(options, "size", request.Request.Size)
	setSeedreamLegacyOption(options, "resolution", request.Request.Resolution)
	setSeedreamLegacyOption(options, "outputFormat", request.Request.OutputFormat)
	if strings.TrimSpace(request.Request.Background) != "auto" {
		setSeedreamLegacyOption(options, "background", request.Request.Background)
	}
	normalized, err := ai.NormalizeImageRequestOptions(doubaoSeedreamImageRequestSchema, options)
	if err != nil {
		return ai.ImageTaskRequest{}, doubaoSeedreamError{message: err.Error()}
	}
	resolution := imageRequestOptionString(normalized, "resolution")
	ratio := imageRequestOptionString(normalized, "size")
	nativeSize, err := doubaoSeedreamSize(resolution, ratio)
	if err != nil {
		return ai.ImageTaskRequest{}, err
	}
	outputFormat := imageRequestOptionString(normalized, "outputFormat")
	background := imageRequestOptionString(normalized, "background")
	if background == "transparent" {
		if len(request.References) != 1 || !strings.EqualFold(strings.TrimSpace(request.References[0].ContentType), "image/png") {
			return ai.ImageTaskRequest{}, doubaoSeedreamError{message: "透明背景仅支持一张 PNG 参考图的图像编辑"}
		}
		if outputFormat != "png" {
			return ai.ImageTaskRequest{}, doubaoSeedreamError{message: "透明背景只能使用 PNG 输出格式"}
		}
	}
	request.Request.Options = normalized
	request.Request.Size = nativeSize
	request.Request.Resolution = resolution
	request.Request.OutputFormat = outputFormat
	request.Request.Background = background
	request.Request.Quality = ""
	return request, nil
}

func setSeedreamLegacyOption(options ai.ImageRequestOptions, key, value string) {
	value = strings.TrimSpace(strings.ToLower(value))
	if _, exists := options[key]; exists || value == "" {
		return
	}
	if key == "resolution" && value == "4k" {
		return
	}
	encoded, _ := json.Marshal(value)
	options[key] = encoded
}

func doubaoSeedreamSize(resolution, ratio string) (string, error) {
	if ratio == "auto" {
		return map[string]string{"1k": "1K", "1.5k": "1.5K", "2k": "2K"}[resolution], nil
	}
	if size := doubaoSeedreamDimensions[resolution][ratio]; size != "" {
		return size, nil
	}
	return "", doubaoSeedreamError{message: "Doubao Seedream 不支持当前尺寸与宽高比组合"}
}

func (provider *doubaoSeedreamProvider) GenerateImage(ctx context.Context, request ai.ImageRequest) ([]ai.ImageResult, error) {
	normalized, err := provider.NormalizeImageTaskRequest(ai.ImageTaskRequest{Request: request})
	if err != nil {
		return nil, err
	}
	task, err := provider.CreateImageTask(ctx, normalized)
	if err != nil {
		return nil, err
	}
	return imageResultsFromURLs(task.ResultURLs), nil
}

func (provider *doubaoSeedreamProvider) EditImage(ctx context.Context, request ai.ImageRequest, references []ai.ImageReference) ([]ai.ImageResult, error) {
	normalized, err := provider.NormalizeImageTaskRequest(ai.ImageTaskRequest{Request: request, References: references})
	if err != nil {
		return nil, err
	}
	task, err := provider.CreateImageTask(ctx, normalized)
	if err != nil {
		return nil, err
	}
	return imageResultsFromURLs(task.ResultURLs), nil
}

func imageResultsFromURLs(urls []string) []ai.ImageResult {
	result := make([]ai.ImageResult, 0, len(urls))
	for _, url := range urls {
		result = append(result, ai.ImageResult{URL: url})
	}
	return result
}

func (provider *doubaoSeedreamProvider) CreateImageTask(ctx context.Context, request ai.ImageTaskRequest) (ai.ImageTask, error) {
	body, err := provider.imageRequestBody(request, false)
	if err != nil {
		return ai.ImageTask{}, err
	}
	data, err := json.Marshal(body)
	if err != nil {
		return ai.ImageTask{}, err
	}
	httpRequest, err := http.NewRequestWithContext(ctx, http.MethodPost, doubaoSeedreamBaseURL+"/images/generations", bytes.NewReader(data))
	if err != nil {
		return ai.ImageTask{}, err
	}
	httpRequest.Header.Set("Authorization", "Bearer "+provider.config.APIKey)
	httpRequest.Header.Set("Content-Type", "application/json")
	response, err := provider.client.Do(httpRequest)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return ai.ImageTask{}, doubaoSeedreamError{message: "Doubao Seedream 请求超时"}
		}
		return ai.ImageTask{}, doubaoSeedreamError{message: "Doubao Seedream 请求失败"}
	}
	defer response.Body.Close()
	responseData, err := io.ReadAll(response.Body)
	if err != nil {
		return ai.ImageTask{}, err
	}
	return parseDoubaoSeedreamResponse(response.StatusCode, responseData)
}

func (provider *doubaoSeedreamProvider) GetImageTask(context.Context, string) (ai.ImageTask, error) {
	return ai.ImageTask{}, doubaoSeedreamError{message: "Doubao Seedream 不支持任务轮询"}
}

func (provider *doubaoSeedreamProvider) SummarizeImageTaskRequest(request ai.ImageTaskRequest) (ai.ImageTaskRequestSummary, error) {
	body, err := provider.imageRequestBody(request, true)
	if err != nil {
		return ai.ImageTaskRequestSummary{}, err
	}
	encoded, err := marshalMaiziRedactedJSON(body)
	if err != nil {
		return ai.ImageTaskRequestSummary{}, err
	}
	return ai.ImageTaskRequestSummary{Method: http.MethodPost, Endpoint: doubaoSeedreamBaseURL + "/images/generations", ContentType: "application/json", JSONBody: encoded}, nil
}

func (provider *doubaoSeedreamProvider) imageRequestBody(request ai.ImageTaskRequest, redacted bool) (map[string]any, error) {
	body := map[string]any{
		"model":           provider.config.Model,
		"prompt":          request.Request.Prompt,
		"size":            request.Request.Size,
		"output_format":   request.Request.OutputFormat,
		"background":      request.Request.Background,
		"response_format": "url",
		"watermark":       false,
	}
	if len(request.References) == 1 {
		body["image"] = doubaoSeedreamDataURL(request.References[0], redacted)
	} else if len(request.References) > 1 {
		images := make([]string, 0, len(request.References))
		for _, reference := range request.References {
			images = append(images, doubaoSeedreamDataURL(reference, redacted))
		}
		body["image"] = images
	}
	return body, nil
}

func doubaoSeedreamDataURL(reference ai.ImageReference, redacted bool) string {
	contentType := strings.ToLower(strings.TrimSpace(reference.ContentType))
	if contentType == "" {
		contentType = "image/png"
	}
	content := "<base64>"
	if !redacted {
		content = base64.StdEncoding.EncodeToString(reference.Data)
	}
	return "data:" + contentType + ";base64," + content
}

func parseDoubaoSeedreamResponse(status int, data []byte) (ai.ImageTask, error) {
	var response struct {
		Data []struct {
			URL   string          `json:"url"`
			Error json.RawMessage `json:"error"`
		} `json:"data"`
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(data, &response); err != nil {
		return ai.ImageTask{}, doubaoSeedreamError{message: "Doubao Seedream 响应无效"}
	}
	if status < http.StatusOK || status >= http.StatusMultipleChoices {
		message := strings.TrimSpace(response.Error.Message)
		if message == "" {
			message = fmt.Sprintf("Doubao Seedream 请求失败（HTTP %d）", status)
		}
		return ai.ImageTask{}, doubaoSeedreamError{message: message}
	}
	urls := make([]string, 0, len(response.Data))
	for _, item := range response.Data {
		if message := doubaoSeedreamResponseError(item.Error); message != "" {
			return ai.ImageTask{}, doubaoSeedreamError{message: message}
		}
		if url := strings.TrimSpace(item.URL); url != "" {
			urls = append(urls, url)
		}
	}
	if len(urls) == 0 {
		return ai.ImageTask{}, doubaoSeedreamError{message: "Doubao Seedream 未返回图片 URL"}
	}
	return ai.ImageTask{Status: "completed", Progress: 100, ResultURLs: urls}, nil
}

func doubaoSeedreamResponseError(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return strings.TrimSpace(text)
	}
	var item struct {
		Message string `json:"message"`
	}
	if json.Unmarshal(raw, &item) == nil {
		return strings.TrimSpace(item.Message)
	}
	return "Doubao Seedream 图片生成失败"
}
