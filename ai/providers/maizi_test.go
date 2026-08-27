package providers

import (
	"context"
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/basketikun/infinite-canvas/ai"
)

type roundTripperFunc func(*http.Request) (*http.Response, error)

func (fn roundTripperFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}

func TestMarshalRedactedJSONClonesOptionsAndRedactsImageData(t *testing.T) {
	options := ai.ImageRequestOptions{"resolution": json.RawMessage(`"2k"`)}
	clone := cloneImageRequestOptions(options)
	clone["resolution"] = json.RawMessage(`"4k"`)
	if string(options["resolution"]) != `"2k"` {
		t.Fatal("source options mutated")
	}

	body, err := marshalRedactedJSON(map[string]any{
		"image":  "data:image/png;base64,c2VjcmV0LWltYWdl",
		"prompt": "一只猫",
	})
	if err != nil {
		t.Fatalf("marshalRedactedJSON() error = %v", err)
	}
	if got := string(body); !strings.Contains(got, `"image":"data:image/png;base64,<base64>"`) || !strings.Contains(got, `"prompt":"一只猫"`) || strings.Contains(got, "c2VjcmV0LWltYWdl") {
		t.Fatalf("marshalRedactedJSON() = %s", got)
	}
}

func TestMaiziImageOutputPreservesBackgroundChoices(t *testing.T) {
	for _, item := range []struct {
		request    ai.ImageRequest
		format     string
		background string
	}{
		{request: ai.ImageRequest{OutputFormat: "jpeg", Background: "auto"}, format: "jpeg", background: "auto"},
		{request: ai.ImageRequest{OutputFormat: "png", Background: "opaque"}, format: "png", background: "opaque"},
		{request: ai.ImageRequest{OutputFormat: "png", Background: "transparent"}, format: "png", background: "transparent"},
	} {
		format, background := maiziImageOutput(item.request)
		if format != item.format || background != item.background {
			t.Errorf("maiziImageOutput(%#v) = %s/%s, want %s/%s", item.request, format, background, item.format, item.background)
		}
	}
}

func TestMaiziProviderNormalizesPublicRequestOptions(t *testing.T) {
	provider, err := newMaiziProvider(json.RawMessage(`{"apiKey":"test-key","model":"gpt-image-2"}`))
	if err != nil {
		t.Fatalf("newMaiziProvider() error = %v", err)
	}
	adapter, ok := provider.(ai.ImageTaskRequestAdapter)
	if !ok {
		t.Fatal("MaiziAI provider does not implement ImageTaskRequestAdapter")
	}
	normalized, err := adapter.NormalizeImageTaskRequest(ai.ImageTaskRequest{Request: ai.ImageRequest{Prompt: "一只猫", Count: 1, Options: ai.ImageRequestOptions{"resolution": json.RawMessage(`"2k"`), "background": json.RawMessage(`"opaque"`)}}})
	if err != nil {
		t.Fatalf("NormalizeImageTaskRequest() error = %v", err)
	}
	if normalized.Request.Resolution != "2k" || normalized.Request.Background != "opaque" || normalized.Request.OutputFormat != "jpeg" || normalized.Request.Size != "1:1" {
		t.Fatalf("normalized request = %#v", normalized.Request)
	}
	if _, err := adapter.NormalizeImageTaskRequest(ai.ImageTaskRequest{Request: ai.ImageRequest{Prompt: "一只猫", Count: 1, Options: ai.ImageRequestOptions{"resolution": json.RawMessage(`"1.5k"`)}}}); err == nil {
		t.Fatal("NormalizeImageTaskRequest() accepted an unsupported MaiziAI resolution")
	}
	if _, err := adapter.NormalizeImageTaskRequest(ai.ImageTaskRequest{Request: ai.ImageRequest{Prompt: "编辑", Count: 1}, References: make([]ai.ImageReference, 8)}); err == nil {
		t.Fatal("NormalizeImageTaskRequest() accepted eight MaiziAI reference images")
	}
}

func TestMaiziProviderCreatesAsyncTaskWithoutPolling(t *testing.T) {
	originalTransport := http.DefaultTransport
	t.Cleanup(func() { http.DefaultTransport = originalTransport })
	var requests atomic.Int32
	http.DefaultTransport = roundTripperFunc(func(request *http.Request) (*http.Response, error) {
		requests.Add(1)
		if request.URL.Path != "/v1/images/generations" {
			t.Errorf("unexpected request: %s", request.URL)
		}
		body, _ := io.ReadAll(request.Body)
		if !strings.Contains(string(body), `"images":["data:image/png;base64,aGVsbG8="]`) {
			t.Errorf("task request references = %s", body)
		}
		return jsonResponse(`{"data":[{"task_id":"task-created","status":"pending"}]}`), nil
	})

	typeInfo, _ := ai.Type("maizi-image")
	provider, err := typeInfo.New(json.RawMessage(`{"apiKey":"test-key","model":"gpt-image-2"}`))
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	tasks, ok := provider.(ai.ImageTaskProvider)
	if !ok {
		t.Fatal("MaiziAI provider does not implement ImageTaskProvider")
	}
	task, err := tasks.CreateImageTask(context.Background(), ai.ImageTaskRequest{Request: ai.ImageRequest{Prompt: "一只猫", Size: "1:1", Resolution: "1k"}, References: []ai.ImageReference{{ContentType: "image/png", Data: []byte("hello")}}})
	if err != nil {
		t.Fatalf("CreateImageTask() error = %v", err)
	}
	if task.ID != "task-created" || task.Status != "pending" || requests.Load() != 1 {
		t.Fatalf("CreateImageTask() = %#v, requests = %d", task, requests.Load())
	}
}

func TestMaiziProviderBuildsRedactedRequestSummaries(t *testing.T) {
	typeInfo, _ := ai.Type("maizi-image")
	provider, err := typeInfo.New(json.RawMessage(`{"apiKey":"test-key","model":"gpt-image-2"}`))
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	summarizer, ok := provider.(ai.ImageTaskRequestSummarizer)
	if !ok {
		t.Fatal("MaiziAI provider does not implement ImageTaskRequestSummarizer")
	}

	v1, err := summarizer.SummarizeImageTaskRequest(ai.ImageTaskRequest{
		Request:    ai.ImageRequest{Prompt: "V1 编辑", Size: "1:1", Resolution: "1k", Quality: "high", OutputFormat: "jpeg", Background: "opaque"},
		References: []ai.ImageReference{{Name: "main.png", ContentType: "image/png", Data: []byte("raw-main-image")}},
	})
	if err != nil {
		t.Fatalf("SummarizeImageTaskRequest(V1) error = %v", err)
	}
	if v1.Method != http.MethodPost || v1.Endpoint != maiziBaseURL+"/images/generations" || v1.ContentType != "application/json" {
		t.Fatalf("V1 summary metadata = %#v", v1)
	}
	if got := string(v1.JSONBody); !strings.Contains(got, `"images":["data:image/png;base64,<base64>"]`) || strings.Contains(got, "raw-main-image") || strings.Contains(got, "test-key") {
		t.Fatalf("V1 summary body = %s", got)
	}

	v2, err := summarizer.SummarizeImageTaskRequest(ai.ImageTaskRequest{
		Request:    ai.ImageRequest{Prompt: "V2 遮罩编辑", Size: "1:1", Resolution: "1k", OutputFormat: "png", Background: "transparent"},
		References: []ai.ImageReference{{Name: "main.png", ContentType: "image/png", Data: []byte("raw-main-image")}, {Name: "reference.jpg", ContentType: "image/jpeg", Data: []byte("raw-reference-image")}},
		Mask:       &ai.ImageReference{Name: "mask.png", ContentType: "image/png", Data: []byte("raw-mask-image")},
	})
	if err != nil {
		t.Fatalf("SummarizeImageTaskRequest(V2) error = %v", err)
	}
	if v2.Method != http.MethodPost || v2.Endpoint != maiziMaskedEditURL || !strings.HasPrefix(v2.ContentType, "multipart/form-data") || len(v2.MultipartFields) != 10 {
		t.Fatalf("V2 summary metadata = %#v", v2)
	}
	if got := v2.MultipartFields[7]; got.Name != "image" || got.Value != "<base64>" || got.Filename != "main.png" || got.ContentType != "image/png" || got.Bytes != len("raw-main-image") {
		t.Fatalf("V2 main image summary = %#v", got)
	}
	if got := v2.MultipartFields[9]; got.Name != "mask" || got.Value != "<base64>" || got.Filename != "mask.png" || got.ContentType != "image/png" || got.Bytes != len("raw-mask-image") {
		t.Fatalf("V2 mask summary = %#v", got)
	}
}

func TestMaiziProviderSendsMaskedV2EditAsMultipartAndReturnsDirectURL(t *testing.T) {
	originalTransport := http.DefaultTransport
	t.Cleanup(func() { http.DefaultTransport = originalTransport })
	http.DefaultTransport = roundTripperFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.Path != "/v2/images/edits" {
			t.Errorf("unexpected request: %s", request.URL)
		}
		mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
		if err != nil || mediaType != "multipart/form-data" {
			t.Fatalf("content type = %q, want multipart/form-data", request.Header.Get("Content-Type"))
		}
		if err := request.ParseMultipartForm(1 << 20); err != nil {
			t.Fatalf("parse multipart form: %v", err)
		}
		if got := request.Header.Get("Authorization"); got != "Bearer test-key" {
			t.Errorf("Authorization = %q, want bearer token", got)
		}
		if got := request.MultipartForm.Value["response_format"]; len(got) != 1 || got[0] != "url" {
			t.Errorf("response_format = %#v, want url", got)
		}
		for field, want := range map[string]string{
			"model":      "gpt-image-2",
			"prompt":     "只修改遮罩区域",
			"size":       "1:1",
			"resolution": "1k",
			"quality":    "high",
		} {
			if got := request.MultipartForm.Value[field]; len(got) != 1 || got[0] != want {
				t.Errorf("%s = %#v, want %q", field, got, want)
			}
		}
		if got := request.MultipartForm.Value["output_format"]; len(got) != 1 || got[0] != "png" {
			t.Errorf("output_format = %#v, want png", got)
		}
		if got := request.MultipartForm.Value["background"]; len(got) != 1 || got[0] != "transparent" {
			t.Errorf("background = %#v, want transparent", got)
		}
		if _, exists := request.MultipartForm.Value["images"]; exists {
			t.Errorf("V2 multipart request unexpectedly includes V1 images field")
		}
		if _, exists := request.MultipartForm.Value["n"]; exists {
			t.Errorf("V2 multipart request unexpectedly includes n")
		}
		images := request.MultipartForm.File["image"]
		if len(images) != 2 {
			t.Fatalf("image files = %d, want 2", len(images))
		}
		for index, want := range []string{"image", "reference"} {
			file, err := images[index].Open()
			if err != nil {
				t.Fatalf("open image %d: %v", index, err)
			}
			data, err := io.ReadAll(file)
			_ = file.Close()
			if err != nil || string(data) != want {
				t.Errorf("image %d = %q, %v; want %q", index, data, err, want)
			}
		}
		masks := request.MultipartForm.File["mask"]
		if len(masks) != 1 {
			t.Fatalf("mask files = %d, want 1", len(masks))
		}
		mask, err := masks[0].Open()
		if err != nil {
			t.Fatalf("open mask: %v", err)
		}
		maskData, err := io.ReadAll(mask)
		_ = mask.Close()
		if err != nil || string(maskData) != "mask" {
			t.Errorf("mask = %q, %v; want mask", maskData, err)
		}
		return jsonResponse(`{"created":1785123456,"data":[{"url":"https://cdn.example.com/masked.png"}]}`), nil
	})

	typeInfo, _ := ai.Type("maizi-image")
	provider, err := typeInfo.New(json.RawMessage(`{"apiKey":"test-key","model":"gpt-image-2"}`))
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	task, err := provider.(ai.ImageTaskProvider).CreateImageTask(context.Background(), ai.ImageTaskRequest{
		Request:    ai.ImageRequest{Prompt: "只修改遮罩区域", Size: "1:1", Resolution: "1k", Quality: "high", OutputFormat: "png", Background: "transparent"},
		References: []ai.ImageReference{{ContentType: "image/png", Data: []byte("image")}, {ContentType: "image/png", Data: []byte("reference")}},
		Mask:       &ai.ImageReference{Name: "mask.png", ContentType: "image/png", Data: []byte("mask")},
	})
	if err != nil {
		t.Fatalf("CreateImageTask() error = %v", err)
	}
	if task.ID != "" || task.Status != "completed" || len(task.ResultURLs) != 1 || task.ResultURLs[0] != "https://cdn.example.com/masked.png" {
		t.Fatalf("CreateImageTask() = %#v", task)
	}
}

func TestMaiziProviderStartsPollingForMaskedV2EditAcceptedResponse(t *testing.T) {
	originalTransport := http.DefaultTransport
	t.Cleanup(func() { http.DefaultTransport = originalTransport })
	http.DefaultTransport = roundTripperFunc(func(request *http.Request) (*http.Response, error) {
		if request.Method != http.MethodPost || request.URL.Path != "/v2/images/edits" {
			t.Errorf("unexpected request: %s %s", request.Method, request.URL)
		}
		return jsonStatusResponse(http.StatusAccepted, `{"task_id":"task-v2-pending","status":"processing","message":"任务仍在处理中"}`), nil
	})

	typeInfo, _ := ai.Type("maizi-image")
	provider, err := typeInfo.New(json.RawMessage(`{"apiKey":"test-key","model":"gpt-image-2"}`))
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	task, err := provider.(ai.ImageTaskProvider).CreateImageTask(context.Background(), maskedV2TaskRequest())
	if err != nil {
		t.Fatalf("CreateImageTask() error = %v", err)
	}
	if task.ID != "task-v2-pending" || task.Status != "processing" || len(task.ResultURLs) != 0 {
		t.Fatalf("CreateImageTask() = %#v", task)
	}
}

func TestMaiziProviderFailsMaskedV2EditWithReturnedError(t *testing.T) {
	originalTransport := http.DefaultTransport
	t.Cleanup(func() { http.DefaultTransport = originalTransport })
	http.DefaultTransport = roundTripperFunc(func(request *http.Request) (*http.Response, error) {
		return jsonResponse(`{"data":[{"error":"Generation failed"}]}`), nil
	})

	typeInfo, _ := ai.Type("maizi-image")
	provider, err := typeInfo.New(json.RawMessage(`{"apiKey":"test-key","model":"gpt-image-2"}`))
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	task, err := provider.(ai.ImageTaskProvider).CreateImageTask(context.Background(), maskedV2TaskRequest())
	if err != nil {
		t.Fatalf("CreateImageTask() error = %v", err)
	}
	if task.Status != "failed" || task.Error != "Generation failed" || task.ID != "" {
		t.Fatalf("CreateImageTask() = %#v", task)
	}
}

func TestMaiziProviderRejectsMaskedV2AcceptedResponseWithoutTaskID(t *testing.T) {
	originalTransport := http.DefaultTransport
	t.Cleanup(func() { http.DefaultTransport = originalTransport })
	http.DefaultTransport = roundTripperFunc(func(request *http.Request) (*http.Response, error) {
		return jsonStatusResponse(http.StatusAccepted, `{"status":"processing"}`), nil
	})

	typeInfo, _ := ai.Type("maizi-image")
	provider, err := typeInfo.New(json.RawMessage(`{"apiKey":"test-key","model":"gpt-image-2"}`))
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	_, err = provider.(ai.ImageTaskProvider).CreateImageTask(context.Background(), maskedV2TaskRequest())
	if err == nil || !strings.Contains(err.Error(), "响应无效") {
		t.Fatalf("CreateImageTask() error = %v, want invalid response", err)
	}
}

func maskedV2TaskRequest() ai.ImageTaskRequest {
	return ai.ImageTaskRequest{
		Request:    ai.ImageRequest{Prompt: "只修改遮罩区域", Size: "1:1", Resolution: "1k", Quality: "high", OutputFormat: "png", Background: "transparent"},
		References: []ai.ImageReference{{ContentType: "image/png", Data: []byte("image")}},
		Mask:       &ai.ImageReference{Name: "mask.png", ContentType: "image/png", Data: []byte("mask")},
	}
}

func TestMaiziProviderGetsAsyncTaskStatus(t *testing.T) {
	originalTransport := http.DefaultTransport
	t.Cleanup(func() { http.DefaultTransport = originalTransport })
	http.DefaultTransport = roundTripperFunc(func(request *http.Request) (*http.Response, error) {
		if request.Method != http.MethodGet || request.URL.Path != "/v1/tasks/task-1" {
			t.Errorf("unexpected request: %s %s", request.Method, request.URL)
		}
		return jsonResponse(`{"id":"task-1","status":"completed","progress":100,"result_urls":["https://cdn.example.com/result.png"]}`), nil
	})

	typeInfo, _ := ai.Type("maizi-image")
	provider, err := typeInfo.New(json.RawMessage(`{"apiKey":"test-key","model":"gpt-image-2"}`))
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	task, err := provider.(ai.ImageTaskProvider).GetImageTask(context.Background(), "task-1")
	if err != nil {
		t.Fatalf("GetImageTask() error = %v", err)
	}
	if task.Status != "completed" || task.Progress != 100 || len(task.ResultURLs) != 1 {
		t.Fatalf("GetImageTask() = %#v", task)
	}
}

func TestMaiziProviderDeclaresRequiredAdminFields(t *testing.T) {
	typeInfo, ok := ai.Type("maizi-image")
	if !ok {
		t.Fatal("MaiziAI provider type is not registered")
	}
	if len(typeInfo.ConfigFields) != 2 {
		t.Fatalf("ConfigFields = %#v, want API Key and model fields", typeInfo.ConfigFields)
	}
	if typeInfo.ConfigFields[0].Key != "apiKey" || typeInfo.ConfigFields[0].Type != "password" || !typeInfo.ConfigFields[0].Required {
		t.Fatalf("API Key field = %#v", typeInfo.ConfigFields[0])
	}
	if typeInfo.ConfigFields[1].Key != "model" || typeInfo.ConfigFields[1].Type != "text" || !typeInfo.ConfigFields[1].Required {
		t.Fatalf("model field = %#v", typeInfo.ConfigFields[1])
	}
}

func TestMaiziProviderRejectsMissingCredentials(t *testing.T) {
	typeInfo, _ := ai.Type("maizi-image")
	if _, err := typeInfo.New(json.RawMessage(`{"model":"gpt-image-2"}`)); err == nil {
		t.Fatal("New() error = nil, want missing API Key validation error")
	}
	if _, err := typeInfo.New(json.RawMessage(`{"apiKey":"test-key"}`)); err == nil {
		t.Fatal("New() error = nil, want missing model validation error")
	}
}

func jsonResponse(body string) *http.Response {
	return jsonStatusResponse(http.StatusOK, body)
}

func jsonStatusResponse(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(body))}
}
