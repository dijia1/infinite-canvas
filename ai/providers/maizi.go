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

	"github.com/basketikun/infinite-canvas/ai"
)

const maiziBaseURL = "https://www.maizitech.xyz/v1"
const maiziMaskedEditURL = "https://www.maizitech.xyz/v2/images/edits"

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

var maiziImageRequestSchema = ai.ImageRequestSchema{
	Version:            "v1",
	MaxReferenceImages: 7,
	SupportsMask:       true,
	Fields: []ai.ImageRequestField{
		{Key: "quality", Label: "质量", Type: ai.ImageRequestFieldSelect, Default: json.RawMessage(`"auto"`), Options: []ai.ImageRequestFieldOption{{Value: "auto", Label: "自动"}, {Value: "high", Label: "高"}, {Value: "medium", Label: "中"}, {Value: "low", Label: "低"}}},
		{Key: "size", Label: "宽高比", Type: ai.ImageRequestFieldSelect, Default: json.RawMessage(`"1:1"`), Options: []ai.ImageRequestFieldOption{{Value: "1:1", Label: "1:1"}, {Value: "3:2", Label: "3:2"}, {Value: "2:3", Label: "2:3"}, {Value: "4:3", Label: "4:3"}, {Value: "3:4", Label: "3:4"}, {Value: "16:9", Label: "16:9"}, {Value: "9:16", Label: "9:16"}, {Value: "21:9", Label: "21:9"}, {Value: "auto", Label: "自动"}}},
		{Key: "resolution", Label: "尺寸", Type: ai.ImageRequestFieldSelect, Default: json.RawMessage(`"1k"`), Options: []ai.ImageRequestFieldOption{{Value: "1k", Label: "1K"}, {Value: "2k", Label: "2K"}, {Value: "4k", Label: "4K"}}},
		{Key: "outputFormat", Label: "输出格式", Type: ai.ImageRequestFieldSelect, Default: json.RawMessage(`"jpeg"`), Options: []ai.ImageRequestFieldOption{{Value: "jpeg", Label: "JPEG"}, {Value: "png", Label: "PNG"}}},
		{Key: "background", Label: "背景", Type: ai.ImageRequestFieldSelect, Default: json.RawMessage(`"auto"`), Options: []ai.ImageRequestFieldOption{{Value: "auto", Label: "自动"}, {Value: "opaque", Label: "不透明"}, {Value: "transparent", Label: "透明"}}},
	},
}

func init() {
	_ = ai.Register(ai.ProviderType{
		ID:           "maizi-image",
		Name:         "MaiziAI",
		Capabilities: []ai.Capability{ai.CapabilityImageGenerate, ai.CapabilityImageEdit},
		ConfigFields: []ai.ConfigField{
			{Key: "apiKey", Label: "API Key", Type: "password", Required: true},
			{Key: "model", Label: "模型名称", Type: "text", Placeholder: "例如：gpt-image-2", Required: true},
		},
		ImageRequestSchema: &maiziImageRequestSchema,
		New:                newMaiziProvider,
	})
}

func (provider *maiziProvider) NormalizeImageTaskRequest(request ai.ImageTaskRequest) (ai.ImageTaskRequest, error) {
	if len(request.References) > maiziImageRequestSchema.MaxReferenceImages {
		return ai.ImageTaskRequest{}, maiziError{message: "MaiziAI 图像编辑最多支持 7 张参考图"}
	}
	if request.Mask != nil && len(request.References) == 0 {
		return ai.ImageTaskRequest{}, maiziError{message: "遮罩编辑需要参考图"}
	}
	options := cloneImageRequestOptions(request.Request.Options)
	setImageRequestOption(options, "quality", request.Request.Quality)
	setImageRequestOption(options, "size", request.Request.Size)
	setImageRequestOption(options, "resolution", request.Request.Resolution)
	setImageRequestOption(options, "outputFormat", request.Request.OutputFormat)
	setImageRequestOption(options, "background", request.Request.Background)
	normalized, err := ai.NormalizeImageRequestOptions(maiziImageRequestSchema, options)
	if err != nil {
		return ai.ImageTaskRequest{}, maiziError{message: err.Error()}
	}
	request.Request.Options = normalized
	request.Request.Quality = imageRequestOptionString(normalized, "quality")
	request.Request.Size = imageRequestOptionString(normalized, "size")
	request.Request.Resolution = imageRequestOptionString(normalized, "resolution")
	request.Request.OutputFormat = imageRequestOptionString(normalized, "outputFormat")
	request.Request.Background = imageRequestOptionString(normalized, "background")
	if request.Request.OutputFormat == "jpeg" && request.Request.Background == "transparent" {
		return ai.ImageTaskRequest{}, maiziError{message: "透明背景只能使用 PNG 输出格式"}
	}
	return request, nil
}

func setImageRequestOption(options ai.ImageRequestOptions, key, value string) {
	if _, exists := options[key]; exists || strings.TrimSpace(value) == "" {
		return
	}
	encoded, _ := json.Marshal(value)
	options[key] = encoded
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
	return &maiziProvider{config: config, client: &http.Client{}, editClient: &http.Client{}}, nil
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
	body, err := marshalRedactedJSON(provider.v1ImageTaskBody(request.Request, request.References, true))
	if err != nil {
		return ai.ImageTaskRequestSummary{}, err
	}
	return ai.ImageTaskRequestSummary{
		Method: http.MethodPost, Endpoint: maiziBaseURL + "/images/generations", ContentType: "application/json", JSONBody: body,
	}, nil
}

func (provider *maiziProvider) GetImageTask(ctx context.Context, id string) (ai.ImageTask, error) {
	var result maiziTaskResponse
	if err := provider.doJSON(ctx, http.MethodGet, maiziBaseURL+"/tasks/"+id, nil, &result); err != nil {
		return ai.ImageTask{}, err
	}
	return ai.ImageTask{ID: firstNonEmpty(result.ID, id), Status: strings.ToLower(strings.TrimSpace(result.Status)), Progress: result.Progress, ResultURLs: result.ResultURLs, Error: strings.TrimSpace(result.Error)}, nil
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
