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
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/basketikun/infinite-canvas/ai"
)

const maiziBaseURL = "https://www.maizitech.xyz/v1"

var maiziPollInterval = 2 * time.Second

type maiziConfig struct {
	APIKey string `json:"apiKey"`
	Model  string `json:"model"`
}

type maiziProvider struct {
	config maiziConfig
	client *http.Client
}

type maiziTaskCreateResponse struct {
	Data []struct {
		TaskID string `json:"task_id"`
		Status string `json:"status"`
	} `json:"data"`
}

type maiziTaskResponse struct {
	ID         string   `json:"id"`
	Status     string   `json:"status"`
	Progress   int      `json:"progress"`
	ResultURLs []string `json:"result_urls"`
	Error      string   `json:"error_msg"`
}

type maiziError struct{ message string }

func (err maiziError) Error() string       { return err.message }
func (err maiziError) SafeMessage() string { return err.message }

func init() {
	_ = ai.Register(ai.ProviderType{
		ID:           "maizi-image",
		Name:         "MaiziAI",
		Capabilities: []ai.Capability{ai.CapabilityImageGenerate, ai.CapabilityImageEdit},
		ConfigFields: []ai.ConfigField{
			{Key: "apiKey", Label: "API Key", Type: "password", Required: true},
			{Key: "model", Label: "模型名称", Type: "text", Placeholder: "例如：gpt-image-2", Required: true},
		},
		New: newMaiziProvider,
	})
}

func newMaiziProvider(raw json.RawMessage) (ai.Provider, error) {
	var config maiziConfig
	if err := json.Unmarshal(raw, &config); err != nil {
		return nil, maiziError{message: "MaiziAI 配置无效"}
	}
	config.APIKey = strings.TrimSpace(config.APIKey)
	config.Model = strings.TrimSpace(config.Model)
	if config.APIKey == "" || config.Model == "" {
		return nil, maiziError{message: "请填写 MaiziAI API Key 和模型名称"}
	}
	return &maiziProvider{config: config, client: &http.Client{Timeout: 30 * time.Second}}, nil
}

func (provider *maiziProvider) GenerateImage(ctx context.Context, request ai.ImageRequest) ([]ai.ImageResult, error) {
	return provider.generate(ctx, request, nil)
}

func (provider *maiziProvider) EditImage(ctx context.Context, request ai.ImageRequest, references []ai.ImageReference) ([]ai.ImageResult, error) {
	if len(references) == 0 {
		return nil, maiziError{message: "图像编辑需要参考图"}
	}
	return provider.generate(ctx, request, references)
}

func (provider *maiziProvider) CreateImageTask(ctx context.Context, request ai.ImageTaskRequest) (ai.ImageTask, error) {
	if len(request.References) > 0 && strings.TrimSpace(request.Request.Prompt) == "" {
		return ai.ImageTask{}, maiziError{message: "提示词不能为空"}
	}
	return provider.createAsyncTask(ctx, request.Request, request.References)
}

func (provider *maiziProvider) GetImageTask(ctx context.Context, id string) (ai.ImageTask, error) {
	var result maiziTaskResponse
	if err := provider.doJSON(ctx, http.MethodGet, maiziBaseURL+"/tasks/"+id, nil, &result); err != nil {
		return ai.ImageTask{}, err
	}
	return ai.ImageTask{ID: firstNonEmpty(result.ID, id), Status: strings.ToLower(strings.TrimSpace(result.Status)), Progress: result.Progress, ResultURLs: result.ResultURLs, Error: strings.TrimSpace(result.Error)}, nil
}

func (provider *maiziProvider) generate(ctx context.Context, request ai.ImageRequest, references []ai.ImageReference) ([]ai.ImageResult, error) {
	count := request.Count
	if count < 1 {
		count = 1
	}
	if count > 15 {
		count = 15
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	results := make([][]ai.ImageResult, count)
	var once sync.Once
	var firstErr error
	var group sync.WaitGroup
	for index := range results {
		group.Add(1)
		go func(index int) {
			defer group.Done()
			taskID, err := provider.createTask(ctx, request, references)
			if err == nil {
				results[index], err = provider.waitTask(ctx, taskID)
			}
			if err != nil {
				once.Do(func() {
					firstErr = err
					cancel()
				})
			}
		}(index)
	}
	group.Wait()
	if firstErr != nil {
		return nil, firstErr
	}
	var images []ai.ImageResult
	for _, item := range results {
		images = append(images, item...)
	}
	return images, nil
}

func (provider *maiziProvider) createTask(ctx context.Context, request ai.ImageRequest, references []ai.ImageReference) (string, error) {
	task, err := provider.createAsyncTask(ctx, request, references)
	return task.ID, err
}

func (provider *maiziProvider) createAsyncTask(ctx context.Context, request ai.ImageRequest, references []ai.ImageReference) (ai.ImageTask, error) {
	body := map[string]any{"model": provider.config.Model, "prompt": request.Prompt}
	if request.Size != "" {
		body["size"] = request.Size
	}
	if request.Resolution != "" {
		body["resolution"] = maiziResolution(request.Resolution)
	}
	if request.Quality != "" && request.Quality != "auto" {
		body["quality"] = request.Quality
	}
	if len(references) > 0 {
		images := make([]string, 0, len(references))
		for _, reference := range references {
			contentType := reference.ContentType
			if contentType == "" {
				contentType = "application/octet-stream"
			}
			images = append(images, "data:"+contentType+";base64,"+base64.StdEncoding.EncodeToString(reference.Data))
		}
		body["images"] = images
	}
	data, err := json.Marshal(body)
	if err != nil {
		return ai.ImageTask{}, err
	}
	var result maiziTaskCreateResponse
	if err := provider.doJSON(ctx, http.MethodPost, maiziBaseURL+"/images/generations", data, &result); err != nil {
		return ai.ImageTask{}, err
	}
	if len(result.Data) == 0 || result.Data[0].TaskID == "" {
		return ai.ImageTask{}, maiziError{message: "MaiziAI 未返回任务 ID"}
	}
	return ai.ImageTask{ID: result.Data[0].TaskID, Status: strings.ToLower(strings.TrimSpace(result.Data[0].Status))}, nil
}

func maiziResolution(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "1k" || value == "2k" || value == "4k" {
		return value
	}
	parts := strings.Split(value, "x")
	if len(parts) != 2 {
		return "1k"
	}
	width, widthErr := strconv.Atoi(parts[0])
	height, heightErr := strconv.Atoi(parts[1])
	if widthErr != nil || heightErr != nil {
		return "1k"
	}
	largest := max(width, height)
	if largest <= 1792 {
		return "1k"
	}
	if largest <= 2048 {
		return "2k"
	}
	return "4k"
}

func (provider *maiziProvider) waitTask(ctx context.Context, taskID string) ([]ai.ImageResult, error) {
	for {
		task, err := provider.GetImageTask(ctx, taskID)
		if err != nil {
			return nil, err
		}
		switch task.Status {
		case "completed":
			if len(task.ResultURLs) == 0 {
				return nil, maiziError{message: "MaiziAI 任务完成但未返回图片"}
			}
			result := make([]ai.ImageResult, 0, len(task.ResultURLs))
			for _, url := range task.ResultURLs {
				result = append(result, ai.ImageResult{URL: url})
			}
			return result, nil
		case "failed", "cancelled", "canceled", "error":
			if task.Error != "" {
				return nil, maiziError{message: "MaiziAI 任务失败：" + task.Error}
			}
			return nil, maiziError{message: "MaiziAI 任务失败"}
		}
		select {
		case <-ctx.Done():
			return nil, maiziError{message: "MaiziAI 任务等待超时"}
		case <-time.After(maiziPollInterval):
		}
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}

func (provider *maiziProvider) doJSON(ctx context.Context, method, url string, body []byte, result any) error {
	request, err := http.NewRequestWithContext(ctx, method, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+provider.config.APIKey)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := provider.client.Do(request)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return maiziError{message: "MaiziAI 任务等待超时"}
		}
		return maiziError{message: "MaiziAI 请求失败"}
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		return err
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return maiziUpstreamError(response.StatusCode, data)
	}
	if err := json.Unmarshal(data, result); err != nil {
		return maiziError{message: "MaiziAI 响应无效"}
	}
	return nil
}

func maiziUpstreamError(status int, data []byte) error {
	var payload struct {
		Message  string          `json:"message"`
		ErrorMsg string          `json:"error_msg"`
		Error    json.RawMessage `json:"error"`
		Detail   json.RawMessage `json:"detail"`
	}
	_ = json.Unmarshal(data, &payload)
	detail := strings.TrimSpace(payload.Message)
	if detail == "" {
		detail = strings.TrimSpace(payload.ErrorMsg)
	}
	if detail == "" && len(payload.Error) > 0 {
		if payload.Error[0] == '"' {
			_ = json.Unmarshal(payload.Error, &detail)
		} else {
			var item struct {
				Message string `json:"message"`
			}
			_ = json.Unmarshal(payload.Error, &item)
			detail = item.Message
		}
	}
	if detail == "" && len(payload.Detail) > 0 {
		_ = json.Unmarshal(payload.Detail, &detail)
	}
	if detail != "" {
		return maiziError{message: "MaiziAI 请求失败：" + detail}
	}
	return maiziError{message: fmt.Sprintf("MaiziAI 请求失败（HTTP %d）", status)}
}
