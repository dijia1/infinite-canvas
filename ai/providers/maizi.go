package providers

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/basketikun/infinite-canvas/ai"
)

const maiziBaseURL = "https://www.maizitech.xyz/v1"
const maiziMaskedEditURL = "https://www.maizitech.xyz/v2/images/edits"

var maiziPollInterval = 2 * time.Second

type maiziConfig struct {
	APIKey string `json:"apiKey"`
	Model  string `json:"model"`
}

type maiziProvider struct {
	config     maiziConfig
	client     *http.Client
	editClient *http.Client
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

type maiziV2EditResponse struct {
	Data []struct {
		URL   string `json:"url"`
		Error string `json:"error"`
	} `json:"data"`
}

type maiziV2PendingResponse struct {
	TaskID  string `json:"task_id"`
	Status  string `json:"status"`
	Message string `json:"message"`
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
	return &maiziProvider{config: config, client: &http.Client{Timeout: 30 * time.Second}, editClient: &http.Client{}}, nil
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
	return provider.createAsyncTask(ctx, request.Request, request.References, request.Mask)
}

func (provider *maiziProvider) SummarizeImageTaskRequest(request ai.ImageTaskRequest) (ai.ImageTaskRequestSummary, error) {
	if request.Mask != nil {
		return provider.summarizeMaskedEdit(request.Request, request.References, *request.Mask), nil
	}
	body, err := marshalMaiziRedactedJSON(provider.v1ImageTaskBody(request.Request, request.References, true))
	if err != nil {
		return ai.ImageTaskRequestSummary{}, err
	}
	return ai.ImageTaskRequestSummary{
		Method: http.MethodPost, Endpoint: maiziBaseURL + "/images/generations", ContentType: "application/json", JSONBody: body,
	}, nil
}

func marshalMaiziRedactedJSON(body map[string]any) (json.RawMessage, error) {
	var result bytes.Buffer
	encoder := json.NewEncoder(&result)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(body); err != nil {
		return nil, err
	}
	return json.RawMessage(bytes.TrimSpace(result.Bytes())), nil
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
	task, err := provider.createAsyncTask(ctx, request, references, nil)
	return task.ID, err
}

func (provider *maiziProvider) createAsyncTask(ctx context.Context, request ai.ImageRequest, references []ai.ImageReference, mask *ai.ImageReference) (ai.ImageTask, error) {
	if mask != nil {
		return provider.createMaskedEdit(ctx, request, references, *mask)
	}
	data, err := json.Marshal(provider.v1ImageTaskBody(request, references, false))
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

func (provider *maiziProvider) v1ImageTaskBody(request ai.ImageRequest, references []ai.ImageReference, redacted bool) map[string]any {
	body := map[string]any{"model": provider.config.Model, "prompt": request.Prompt}
	outputFormat, background := maiziImageOutput(request)
	body["output_format"] = outputFormat
	body["background"] = background
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
			contentType := normalizedMaiziReferenceContentType(reference)
			data := "<base64>"
			if !redacted {
				data = base64.StdEncoding.EncodeToString(reference.Data)
			}
			images = append(images, "data:"+contentType+";base64,"+data)
		}
		body["images"] = images
	}
	return body
}

func (provider *maiziProvider) createMaskedEdit(ctx context.Context, request ai.ImageRequest, references []ai.ImageReference, mask ai.ImageReference) (ai.ImageTask, error) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for _, field := range [][2]string{
		{"model", provider.config.Model},
		{"prompt", request.Prompt},
		{"response_format", "url"},
	} {
		if err := writeMaiziMultipartField(writer, field[0], field[1]); err != nil {
			return ai.ImageTask{}, err
		}
	}
	if request.Size != "" {
		if err := writeMaiziMultipartField(writer, "size", request.Size); err != nil {
			return ai.ImageTask{}, err
		}
	}
	if request.Resolution != "" {
		if err := writeMaiziMultipartField(writer, "resolution", maiziResolution(request.Resolution)); err != nil {
			return ai.ImageTask{}, err
		}
	}
	outputFormat, background := maiziImageOutput(request)
	if err := writeMaiziMultipartField(writer, "output_format", outputFormat); err != nil {
		return ai.ImageTask{}, err
	}
	if err := writeMaiziMultipartField(writer, "background", background); err != nil {
		return ai.ImageTask{}, err
	}
	if request.Quality != "" && request.Quality != "auto" {
		if err := writeMaiziMultipartField(writer, "quality", request.Quality); err != nil {
			return ai.ImageTask{}, err
		}
	}
	for _, reference := range references {
		if err := writeMaiziMultipartImage(writer, "image", reference); err != nil {
			return ai.ImageTask{}, err
		}
	}
	if err := writeMaiziMultipartImage(writer, "mask", mask); err != nil {
		return ai.ImageTask{}, err
	}
	if err := writer.Close(); err != nil {
		return ai.ImageTask{}, err
	}
	contentType := writer.FormDataContentType()

	httpRequest, err := http.NewRequestWithContext(ctx, http.MethodPost, maiziMaskedEditURL, &body)
	if err != nil {
		return ai.ImageTask{}, err
	}
	httpRequest.Header.Set("Authorization", "Bearer "+provider.config.APIKey)
	httpRequest.Header.Set("Content-Type", contentType)
	response, err := provider.editClient.Do(httpRequest)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return ai.ImageTask{}, maiziError{message: "MaiziAI 任务等待超时"}
		}
		return ai.ImageTask{}, maiziError{message: "MaiziAI 请求失败"}
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		return ai.ImageTask{}, err
	}
	switch response.StatusCode {
	case http.StatusOK:
		return parseMaiziV2CompletedEdit(data)
	case http.StatusAccepted:
		var pending maiziV2PendingResponse
		if err := json.Unmarshal(data, &pending); err != nil || strings.TrimSpace(pending.TaskID) == "" {
			return ai.ImageTask{}, maiziError{message: "MaiziAI 响应无效"}
		}
		return ai.ImageTask{ID: strings.TrimSpace(pending.TaskID), Status: strings.ToLower(strings.TrimSpace(pending.Status))}, nil
	default:
		return ai.ImageTask{}, maiziUpstreamError(response.StatusCode, data)
	}
}

func (provider *maiziProvider) summarizeMaskedEdit(request ai.ImageRequest, references []ai.ImageReference, mask ai.ImageReference) ai.ImageTaskRequestSummary {
	fields := make([]ai.ImageTaskRequestSummaryField, 0, len(references)+8)
	for _, field := range [][2]string{{"model", provider.config.Model}, {"prompt", request.Prompt}, {"response_format", "url"}} {
		fields = append(fields, ai.ImageTaskRequestSummaryField{Name: field[0], Value: field[1]})
	}
	if request.Size != "" {
		fields = append(fields, ai.ImageTaskRequestSummaryField{Name: "size", Value: request.Size})
	}
	if request.Resolution != "" {
		fields = append(fields, ai.ImageTaskRequestSummaryField{Name: "resolution", Value: maiziResolution(request.Resolution)})
	}
	outputFormat, background := maiziImageOutput(request)
	fields = append(fields, ai.ImageTaskRequestSummaryField{Name: "output_format", Value: outputFormat}, ai.ImageTaskRequestSummaryField{Name: "background", Value: background})
	if request.Quality != "" && request.Quality != "auto" {
		fields = append(fields, ai.ImageTaskRequestSummaryField{Name: "quality", Value: request.Quality})
	}
	for _, reference := range references {
		fields = append(fields, maiziMultipartSummaryField("image", reference))
	}
	fields = append(fields, maiziMultipartSummaryField("mask", mask))
	return ai.ImageTaskRequestSummary{Method: http.MethodPost, Endpoint: maiziMaskedEditURL, ContentType: "multipart/form-data", MultipartFields: fields}
}

func writeMaiziMultipartField(writer *multipart.Writer, name, value string) error {
	return writer.WriteField(name, value)
}

func writeMaiziMultipartImage(writer *multipart.Writer, field string, reference ai.ImageReference) error {
	filename := filepath.Base(strings.TrimSpace(reference.Name))
	if filename == "" || filename == "." {
		filename = "image.png"
	}
	contentType := normalizedMaiziReferenceContentType(reference)
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", mime.FormatMediaType("form-data", map[string]string{"name": field, "filename": filename}))
	header.Set("Content-Type", contentType)
	part, err := writer.CreatePart(header)
	if err != nil {
		return err
	}
	if _, err = part.Write(reference.Data); err != nil {
		return err
	}
	return nil
}

func maiziMultipartSummaryField(field string, reference ai.ImageReference) ai.ImageTaskRequestSummaryField {
	filename := filepath.Base(strings.TrimSpace(reference.Name))
	if filename == "" || filename == "." {
		filename = "image.png"
	}
	return ai.ImageTaskRequestSummaryField{Name: field, Value: "<base64>", Filename: filename, ContentType: normalizedMaiziReferenceContentType(reference), Bytes: len(reference.Data)}
}

func normalizedMaiziReferenceContentType(reference ai.ImageReference) string {
	contentType := strings.TrimSpace(reference.ContentType)
	if contentType == "" {
		return "application/octet-stream"
	}
	return contentType
}

func parseMaiziV2CompletedEdit(data []byte) (ai.ImageTask, error) {
	var response maiziV2EditResponse
	if err := json.Unmarshal(data, &response); err != nil || len(response.Data) == 0 {
		return ai.ImageTask{}, maiziError{message: "MaiziAI 响应无效"}
	}
	urls := make([]string, 0, len(response.Data))
	for _, item := range response.Data {
		if message := strings.TrimSpace(item.Error); message != "" {
			return ai.ImageTask{Status: "failed", Error: message}, nil
		}
		if url := strings.TrimSpace(item.URL); url != "" {
			urls = append(urls, url)
		}
	}
	if len(urls) == 0 {
		return ai.ImageTask{}, maiziError{message: "MaiziAI 响应无效"}
	}
	return ai.ImageTask{Status: "completed", Progress: 100, ResultURLs: urls}, nil
}

func maiziImageOutput(request ai.ImageRequest) (string, string) {
	format := strings.ToLower(strings.TrimSpace(request.OutputFormat))
	if format != "png" {
		format = "jpeg"
	}
	background := strings.ToLower(strings.TrimSpace(request.Background))
	if background != "opaque" && background != "transparent" {
		background = "auto"
	}
	if format == "jpeg" && background == "transparent" {
		format = "png"
	}
	return format, background
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
		case "failed", "cancelled", "canceled", "error", "violated", "rejected":
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
