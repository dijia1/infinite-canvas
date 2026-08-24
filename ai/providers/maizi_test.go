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

func TestMaiziProviderCreatesAndCompletesImageTask(t *testing.T) {
	originalTransport := http.DefaultTransport
	t.Cleanup(func() { http.DefaultTransport = originalTransport })
	http.DefaultTransport = roundTripperFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.String() == "https://www.maizitech.xyz/v1/images/generations" {
			if got := request.Header.Get("Authorization"); got != "Bearer test-key" {
				t.Errorf("Authorization = %q, want bearer token", got)
			}
			body, _ := io.ReadAll(request.Body)
			var payload map[string]any
			_ = json.Unmarshal(body, &payload)
			if payload["model"] != "gpt-image-2" || payload["prompt"] != "一只猫" || payload["size"] != "1:1" || payload["resolution"] != "1k" || payload["quality"] != "high" {
				t.Errorf("generation payload = %#v", payload)
			}
			if _, exists := payload["n"]; exists {
				t.Errorf("generation payload unexpectedly includes n: %#v", payload)
			}
			return jsonResponse(`{"created":1714012800,"data":[{"task_id":"task-1","status":"pending"}]}`), nil
		}
		if request.URL.String() == "https://www.maizitech.xyz/v1/tasks/task-1" {
			return jsonResponse(`{"id":"task-1","type":"image","model":"gpt-image-2","prompt":"一只猫","status":"completed","progress":100,"result_urls":["https://cdn.example.com/result.png"],"error_msg":null}`), nil
		}
		t.Errorf("unexpected request: %s", request.URL)
		return jsonResponse(`{}`), nil
	})

	typeInfo, ok := ai.Type("maizi-image")
	if !ok {
		t.Fatal("MaiziAI provider type is not registered")
	}
	provider, err := typeInfo.New(json.RawMessage(`{"apiKey":"test-key","model":"gpt-image-2"}`))
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	generator, ok := provider.(ai.ImageGenerator)
	if !ok {
		t.Fatal("MaiziAI provider does not implement ImageGenerator")
	}
	images, err := generator.GenerateImage(context.Background(), ai.ImageRequest{Prompt: "一只猫", Count: 1, Quality: "high", Size: "1:1", Resolution: "1k"})
	if err != nil {
		t.Fatalf("GenerateImage() error = %v", err)
	}
	if len(images) != 1 || images[0].URL != "https://cdn.example.com/result.png" {
		t.Fatalf("GenerateImage() = %#v", images)
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

func TestMaiziProviderNormalizesLegacyResolution(t *testing.T) {
	originalTransport := http.DefaultTransport
	t.Cleanup(func() { http.DefaultTransport = originalTransport })
	http.DefaultTransport = roundTripperFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.Path == "/v1/images/generations" {
			body, _ := io.ReadAll(request.Body)
			var payload map[string]any
			_ = json.Unmarshal(body, &payload)
			if payload["resolution"] != "1k" {
				t.Errorf("resolution = %#v, want 1k", payload["resolution"])
			}
			return jsonResponse(`{"data":[{"task_id":"task-1"}]}`), nil
		}
		return jsonResponse(`{"status":"completed","result_urls":["https://cdn.example.com/result.png"]}`), nil
	})

	typeInfo, _ := ai.Type("maizi-image")
	provider, err := typeInfo.New(json.RawMessage(`{"apiKey":"test-key","model":"gpt-image-2"}`))
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	_, err = provider.(ai.ImageGenerator).GenerateImage(context.Background(), ai.ImageRequest{Prompt: "一只猫", Resolution: "1024x1024"})
	if err != nil {
		t.Fatalf("GenerateImage() error = %v", err)
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

func TestMaiziProviderCreatesOneTaskPerEditedImage(t *testing.T) {
	originalTransport := http.DefaultTransport
	t.Cleanup(func() { http.DefaultTransport = originalTransport })
	var creates atomic.Int32
	http.DefaultTransport = roundTripperFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.Path == "/v1/images/generations" {
			body, _ := io.ReadAll(request.Body)
			if !strings.Contains(string(body), `"images":["data:image/png;base64,aGVsbG8="]`) || strings.Contains(string(body), `"n"`) {
				t.Errorf("edit payload = %s", body)
			}
			return jsonResponse(`{"data":[{"task_id":"task-` + string(rune('1'+creates.Add(1)-1)) + `"}]}`), nil
		}
		if strings.HasPrefix(request.URL.Path, "/v1/tasks/task-") {
			return jsonResponse(`{"status":"completed","result_urls":["https://cdn.example.com/` + request.URL.Path[len("/v1/tasks/"):] + `.png"]}`), nil
		}
		t.Errorf("unexpected request: %s", request.URL)
		return jsonResponse(`{}`), nil
	})

	typeInfo, _ := ai.Type("maizi-image")
	provider, err := typeInfo.New(json.RawMessage(`{"apiKey":"test-key","model":"gpt-image-2"}`))
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	editor := provider.(ai.ImageEditor)
	images, err := editor.EditImage(context.Background(), ai.ImageRequest{Prompt: "改成水彩", Count: 2, Size: "1:1", Resolution: "1024x1024"}, []ai.ImageReference{{ContentType: "image/png", Data: []byte("hello")}})
	if err != nil {
		t.Fatalf("EditImage() error = %v", err)
	}
	if creates.Load() != 2 || len(images) != 2 {
		t.Fatalf("creates = %d, images = %#v", creates.Load(), images)
	}
}

func TestMaiziProviderReturnsUpstreamErrorMessage(t *testing.T) {
	originalTransport := http.DefaultTransport
	t.Cleanup(func() { http.DefaultTransport = originalTransport })
	http.DefaultTransport = roundTripperFunc(func(request *http.Request) (*http.Response, error) {
		return jsonStatusResponse(http.StatusBadRequest, `{"detail":"resolution 参数不支持"}`), nil
	})

	typeInfo, _ := ai.Type("maizi-image")
	provider, err := typeInfo.New(json.RawMessage(`{"apiKey":"test-key","model":"gpt-image-2"}`))
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	_, err = provider.(ai.ImageGenerator).GenerateImage(context.Background(), ai.ImageRequest{Prompt: "一只猫"})
	if err == nil || !strings.Contains(err.Error(), "resolution 参数不支持") {
		t.Fatalf("GenerateImage() error = %v", err)
	}
}

func jsonResponse(body string) *http.Response {
	return jsonStatusResponse(http.StatusOK, body)
}

func jsonStatusResponse(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(body))}
}
