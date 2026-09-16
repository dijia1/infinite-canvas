package providers

import (
	"context"
	"encoding/json"
	"io"
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
	custom, err := adapter.NormalizeImageTaskRequest(ai.ImageTaskRequest{Request: ai.ImageRequest{Prompt: "一只猫", Count: 1, Options: ai.ImageRequestOptions{"resolution": json.RawMessage(`"1536x1024"`)}}})
	if err != nil || custom.Request.Resolution != "1536x1024" {
		t.Fatalf("NormalizeImageTaskRequest() custom resolution = %#v, %v", custom.Request, err)
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
		if !strings.Contains(string(body), `"resolution":"1536x1024"`) {
			t.Errorf("task request resolution = %s", body)
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
	task, err := tasks.CreateImageTask(context.Background(), ai.ImageTaskRequest{Request: ai.ImageRequest{Prompt: "一只猫", Size: "1:1", Resolution: "1536x1024"}, References: []ai.ImageReference{{ContentType: "image/png", Data: []byte("hello")}}})
	if err != nil {
		t.Fatalf("CreateImageTask() error = %v", err)
	}
	if task.ID != "task-created" || task.Status != "pending" || requests.Load() != 1 {
		t.Fatalf("CreateImageTask() = %#v, requests = %d", task, requests.Load())
	}
}

func TestMaiziProviderUsesCallerDeadlineForAsyncTaskCreation(t *testing.T) {
	instance, err := newMaiziProvider(json.RawMessage(`{"apiKey":"test-key","model":"gpt-image-2"}`))
	if err != nil {
		t.Fatalf("newMaiziProvider() error = %v", err)
	}
	provider, ok := instance.(*maiziProvider)
	if !ok {
		t.Fatalf("newMaiziProvider() = %T, want *maiziProvider", instance)
	}
	if provider.client.Timeout != 0 {
		t.Fatalf("async task client timeout = %s, want no independent deadline", provider.client.Timeout)
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
		References: []ai.ImageReference{{Name: "main.png", ContentType: "image/png", URL: "https://signed.example/main"}, {Name: "reference.jpg", ContentType: "image/jpeg", URL: "https://signed.example/reference"}},
		Mask:       &ai.ImageReference{Name: "mask.png", ContentType: "image/png", URL: "https://signed.example/mask"},
	})
	if err != nil {
		t.Fatalf("SummarizeImageTaskRequest(V2) error = %v", err)
	}
	if v2.Method != http.MethodPost || v2.Endpoint != maiziBaseURL+"/images/generations" || v2.ContentType != "application/json" {
		t.Fatalf("V2 summary metadata = %#v", v2)
	}
	if got := string(v2.JSONBody); !strings.Contains(got, `"images":["<signed-url>","<signed-url>"]`) || !strings.Contains(got, `"mask_url":"<signed-url>"`) || strings.Contains(got, "signed.example") {
		t.Fatalf("V2 summary body = %s", got)
	}
}

func TestMaiziProviderSendsMaskedEditAsVersionBoundURLs(t *testing.T) {
	originalTransport := http.DefaultTransport
	t.Cleanup(func() { http.DefaultTransport = originalTransport })
	http.DefaultTransport = roundTripperFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.Path != "/v1/images/generations" {
			t.Errorf("unexpected request: %s", request.URL)
		}
		if got := request.Header.Get("Authorization"); got != "Bearer test-key" {
			t.Errorf("Authorization = %q, want bearer token", got)
		}
		var body map[string]any
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		images, _ := body["images"].([]any)
		if len(images) != 2 || images[0] != "https://signed.example/image" || images[1] != "https://signed.example/reference" || body["mask_url"] != "https://signed.example/mask" {
			t.Fatalf("request body = %#v", body)
		}
		return jsonResponse(`{"data":[{"task_id":"masked-task","status":"processing"}]}`), nil
	})

	typeInfo, _ := ai.Type("maizi-image")
	provider, err := typeInfo.New(json.RawMessage(`{"apiKey":"test-key","model":"gpt-image-2"}`))
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	task, err := provider.(ai.ImageTaskProvider).CreateImageTask(context.Background(), ai.ImageTaskRequest{
		Request:    ai.ImageRequest{Prompt: "只修改遮罩区域", Size: "1:1", Resolution: "1k", Quality: "high", OutputFormat: "png", Background: "transparent"},
		References: []ai.ImageReference{{ContentType: "image/png", URL: "https://signed.example/image"}, {ContentType: "image/png", URL: "https://signed.example/reference"}},
		Mask:       &ai.ImageReference{Name: "mask.png", ContentType: "image/png", URL: "https://signed.example/mask"},
	})
	if err != nil {
		t.Fatalf("CreateImageTask() error = %v", err)
	}
	if task.ID != "masked-task" || task.Status != ai.ImageTaskStatusRunning || len(task.ResultURLs) != 0 {
		t.Fatalf("CreateImageTask() = %#v", task)
	}
}

func TestMaiziProviderStartsPollingForMaskedEditResponse(t *testing.T) {
	originalTransport := http.DefaultTransport
	t.Cleanup(func() { http.DefaultTransport = originalTransport })
	http.DefaultTransport = roundTripperFunc(func(request *http.Request) (*http.Response, error) {
		if request.Method != http.MethodPost || request.URL.Path != "/v1/images/generations" {
			t.Errorf("unexpected request: %s %s", request.Method, request.URL)
		}
		return jsonStatusResponse(http.StatusAccepted, `{"data":[{"task_id":"task-v2-pending","status":"processing"}]}`), nil
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
	if task.ID != "task-v2-pending" || task.Status != ai.ImageTaskStatusRunning || len(task.ResultURLs) != 0 {
		t.Fatalf("CreateImageTask() = %#v", task)
	}
}

func TestMaiziProviderNormalizesRejectedMaskedSubmission(t *testing.T) {
	originalTransport := http.DefaultTransport
	t.Cleanup(func() { http.DefaultTransport = originalTransport })
	http.DefaultTransport = roundTripperFunc(func(request *http.Request) (*http.Response, error) {
		return jsonResponse(`{"data":[{"task_id":"rejected-task","status":"rejected"}]}`), nil
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
	if task.Status != ai.ImageTaskStatusFailed || task.ID != "rejected-task" {
		t.Fatalf("CreateImageTask() = %#v", task)
	}
}

func TestMaiziProviderRejectsMaskedV2AcceptedResponseWithoutTaskID(t *testing.T) {
	originalTransport := http.DefaultTransport
	t.Cleanup(func() { http.DefaultTransport = originalTransport })
	http.DefaultTransport = roundTripperFunc(func(request *http.Request) (*http.Response, error) {
		return jsonStatusResponse(http.StatusAccepted, `{"data":[{"status":"processing"}]}`), nil
	})

	typeInfo, _ := ai.Type("maizi-image")
	provider, err := typeInfo.New(json.RawMessage(`{"apiKey":"test-key","model":"gpt-image-2"}`))
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	_, err = provider.(ai.ImageTaskProvider).CreateImageTask(context.Background(), maskedV2TaskRequest())
	if err == nil || !strings.Contains(err.Error(), "未返回任务 ID") {
		t.Fatalf("CreateImageTask() error = %v, want invalid response", err)
	}
}

func maskedV2TaskRequest() ai.ImageTaskRequest {
	return ai.ImageTaskRequest{
		Request:    ai.ImageRequest{Prompt: "只修改遮罩区域", Size: "1:1", Resolution: "1k", Quality: "high", OutputFormat: "png", Background: "transparent"},
		References: []ai.ImageReference{{ContentType: "image/png", URL: "https://signed.example/image"}},
		Mask:       &ai.ImageReference{Name: "mask.png", ContentType: "image/png", URL: "https://signed.example/mask"},
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

func TestMaiziProviderNormalizesAsyncTaskStatuses(t *testing.T) {
	originalTransport := http.DefaultTransport
	t.Cleanup(func() { http.DefaultTransport = originalTransport })

	typeInfo, _ := ai.Type("maizi-image")
	provider, err := typeInfo.New(json.RawMessage(`{"apiKey":"test-key","model":"gpt-image-2"}`))
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	tasks := provider.(ai.ImageTaskProvider)
	for _, fixture := range []struct {
		name       string
		status     string
		errorMsg   string
		wantStatus string
		wantError  string
	}{
		{name: "pending", status: "pending", wantStatus: ai.ImageTaskStatusPending},
		{name: "queued", status: "queued", wantStatus: ai.ImageTaskStatusPending},
		{name: "submitted", status: "submitted", wantStatus: ai.ImageTaskStatusPending},
		{name: "processing", status: "processing", wantStatus: ai.ImageTaskStatusRunning},
		{name: "running", status: "running", wantStatus: ai.ImageTaskStatusRunning},
		{name: "completed", status: "completed", wantStatus: ai.ImageTaskStatusCompleted},
		{name: "succeeded", status: "succeeded", wantStatus: ai.ImageTaskStatusCompleted},
		{name: "success", status: "success", wantStatus: ai.ImageTaskStatusCompleted},
		{name: "failed", status: "failed", wantStatus: ai.ImageTaskStatusFailed},
		{name: "error", status: "error", wantStatus: ai.ImageTaskStatusFailed},
		{name: "cancelled", status: "cancelled", wantStatus: ai.ImageTaskStatusFailed},
		{name: "canceled", status: "canceled", wantStatus: ai.ImageTaskStatusFailed},
		{name: "violation", status: "violation", errorMsg: "提交内容违反平台政策", wantStatus: ai.ImageTaskStatusFailed, wantError: "提交内容违反平台政策"},
		{name: "violated", status: "violated", wantStatus: ai.ImageTaskStatusFailed},
		{name: "rejected", status: "rejected", wantStatus: ai.ImageTaskStatusFailed},
		{name: "future failure with error", status: "content_blocked", errorMsg: "内容被拒绝", wantStatus: ai.ImageTaskStatusFailed, wantError: "内容被拒绝"},
		{name: "unknown without error", status: "future_state", wantStatus: ai.ImageTaskStatusUncertain},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			body, marshalErr := json.Marshal(map[string]any{"id": "task-1", "status": fixture.status, "progress": 50, "error_msg": fixture.errorMsg})
			if marshalErr != nil {
				t.Fatal(marshalErr)
			}
			http.DefaultTransport = roundTripperFunc(func(*http.Request) (*http.Response, error) {
				return jsonResponse(string(body)), nil
			})

			task, getErr := tasks.GetImageTask(context.Background(), "task-1")
			if getErr != nil {
				t.Fatalf("GetImageTask() error = %v", getErr)
			}
			if task.Status != fixture.wantStatus || task.Error != fixture.wantError {
				t.Fatalf("GetImageTask() = %#v, want status %q error %q", task, fixture.wantStatus, fixture.wantError)
			}
		})
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

func TestMaiziAdministratorAspectRatioSchema(t *testing.T) {
	raw, err := newMaiziProvider(json.RawMessage(`{"apiKey":"test","model":"model"}`))
	if err != nil {
		t.Fatal(err)
	}
	p := raw.(*maiziProvider)
	schema := maiziImageRequestSchema
	schema.Fields = append([]ai.ImageRequestField(nil), schema.Fields...)
	for i := range schema.Fields {
		if schema.Fields[i].Key == "size" {
			schema.Fields[i].Options = []ai.ImageRequestFieldOption{{Value: "5:4", Label: "5:4"}}
			schema.Fields[i].Default = json.RawMessage(`"5:4"`)
		}
	}
	input := ai.ImageTaskRequest{Request: ai.ImageRequest{Prompt: "test", Size: "5:4", Resolution: "2K"}, RequestSchema: &schema}
	normalized, err := p.NormalizeImageTaskRequest(input)
	if err != nil || normalized.Request.Size != "5:4" {
		t.Fatalf("%+v %v", normalized, err)
	}
	if p.v1ImageTaskBody(normalized.Request, nil, false)["size"] != "5:4" {
		t.Fatal("ratio not forwarded")
	}
	input.Request.Size = "1:1"
	if _, err = p.NormalizeImageTaskRequest(input); err == nil {
		t.Fatal("unconfigured ratio accepted")
	}
	input.RequestSchema = nil
	input.Request.Size = "5:4"
	if _, err = p.NormalizeImageTaskRequest(input); err == nil {
		t.Fatal("static schema mutated")
	}
}
