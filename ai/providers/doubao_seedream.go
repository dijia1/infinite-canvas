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
		{Key: "resolution", Label: "尺寸", Type: ai.ImageRequestFieldText, Required: true},
		{Key: "outputFormat", Label: "输出格式", Type: ai.ImageRequestFieldSelect, Default: json.RawMessage(`"jpeg"`), Options: []ai.ImageRequestFieldOption{{Value: "jpeg", Label: "JPEG"}, {Value: "png", Label: "PNG"}}},
		{Key: "background", Label: "背景", Type: ai.ImageRequestFieldSelect, Default: json.RawMessage(`"opaque"`), Options: []ai.ImageRequestFieldOption{{Value: "opaque", Label: "不透明"}, {Value: "transparent", Label: "透明"}}},
	},
}

func init() {
	_ = ai.Register(ai.ProviderType{
		ID:                           "doubao-seedream-5-pro",
		Name:                         "Doubao Seedream 5.0 Pro",
		Capabilities:                 []ai.Capability{ai.CapabilityImageGenerate, ai.CapabilityImageEdit},
		ImageRequestSchema:           &doubaoSeedreamImageRequestSchema,
		CanonicalizeImageTaskRequest: canonicalizeDoubaoSeedreamImageTaskRequest,
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
	request, err := canonicalizeDoubaoSeedreamImageTaskRequest(request)
	if err != nil {
		return ai.ImageTaskRequest{}, err
	}
	background := request.Request.Background
	outputFormat := request.Request.OutputFormat
	if background == "transparent" {
		if len(request.References) != 1 || !strings.EqualFold(strings.TrimSpace(request.References[0].ContentType), "image/png") {
			return ai.ImageTaskRequest{}, doubaoSeedreamError{message: "透明背景仅支持一张 PNG 参考图的图像编辑"}
		}
		if outputFormat != "png" {
			return ai.ImageTaskRequest{}, doubaoSeedreamError{message: "透明背景只能使用 PNG 输出格式"}
		}
	}
	return request, nil
}

func canonicalizeDoubaoSeedreamImageTaskRequest(request ai.ImageTaskRequest) (ai.ImageTaskRequest, error) {
	options := cloneImageRequestOptions(request.Request.Options)
	delete(options, "watermark")
	setSeedreamLegacyOption(options, "resolution", request.Request.Resolution)
	setSeedreamLegacyOption(options, "outputFormat", request.Request.OutputFormat)
	if strings.TrimSpace(request.Request.Background) != "auto" {
		setSeedreamLegacyOption(options, "background", request.Request.Background)
	}
	schema := doubaoSeedreamImageRequestSchema
	if request.RequestSchema != nil {
		schema = *request.RequestSchema
	}
	normalized, err := ai.NormalizeImageRequestOptions(schema, options)
	if err != nil {
		return ai.ImageTaskRequest{}, doubaoSeedreamError{message: err.Error()}
	}
	resolution := imageRequestOptionString(normalized, "resolution")
	outputFormat := imageRequestOptionString(normalized, "outputFormat")
	background := imageRequestOptionString(normalized, "background")
	request.Request.Options = normalized
	request.Request.Size = resolution
	request.Request.Resolution = resolution
	request.Request.OutputFormat = outputFormat
	request.Request.Background = background
	request.Request.Quality = ""
	return request, nil
}

func setSeedreamLegacyOption(options ai.ImageRequestOptions, key, value string) {
	value = strings.TrimSpace(value)
	if _, exists := options[key]; exists || value == "" {
		return
	}
	encoded, _ := json.Marshal(value)
	options[key] = encoded
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
	encoded, err := marshalRedactedJSON(body)
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
	return ai.ImageTask{Status: ai.ImageTaskStatusCompleted, Progress: 100, ResultURLs: urls}, nil
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
