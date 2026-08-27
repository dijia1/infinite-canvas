package providers

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/basketikun/infinite-canvas/ai"
)

func TestDoubaoSeedreamNormalizesAndSubmitsACompleteImageRequest(t *testing.T) {
	originalTransport := http.DefaultTransport
	t.Cleanup(func() { http.DefaultTransport = originalTransport })
	http.DefaultTransport = roundTripperFunc(func(request *http.Request) (*http.Response, error) {
		if request.Method != http.MethodPost || request.URL.String() != doubaoSeedreamBaseURL+"/images/generations" {
			t.Errorf("request = %s %s", request.Method, request.URL)
		}
		if request.Header.Get("Authorization") != "Bearer test-key" {
			t.Errorf("Authorization = %q", request.Header.Get("Authorization"))
		}
		var body map[string]any
		data, _ := io.ReadAll(request.Body)
		if err := json.Unmarshal(data, &body); err != nil {
			t.Fatalf("request body = %s: %v", data, err)
		}
		if body["model"] != "doubao-seedream-5-0-pro-260628" || body["size"] != "2048x1152" || body["output_format"] != "png" || body["response_format"] != "url" || body["watermark"] != false {
			t.Errorf("request body = %#v", body)
		}
		images, ok := body["image"].([]any)
		if !ok || len(images) != 2 || images[0] != "data:image/png;base64,bWFpbg==" || images[1] != "data:image/jpeg;base64,cmVmZXJlbmNl" {
			t.Errorf("request image = %#v", body["image"])
		}
		return jsonResponse(`{"model":"doubao-seedream-5-0-pro-260628","data":[{"url":"https://images.example.test/result.png","size":"2048x1152"}]}`), nil
	})

	typeInfo, found := ai.Type("doubao-seedream-5-pro")
	if !found || typeInfo.ImageRequestSchema == nil {
		t.Fatal("Doubao Seedream provider schema is not registered")
	}
	provider, err := typeInfo.New(json.RawMessage(`{"apiKey":"test-key","model":"doubao-seedream-5-0-pro-260628"}`))
	if err != nil {
		t.Fatalf("provider.New() error = %v", err)
	}
	adapter := provider.(ai.ImageTaskRequestAdapter)
	normalized, err := adapter.NormalizeImageTaskRequest(ai.ImageTaskRequest{
		Request: ai.ImageRequest{Prompt: "将图 1 的服装换为图 2 的服装", Count: 1, Options: ai.ImageRequestOptions{
			"size":         json.RawMessage(`"16:9"`),
			"resolution":   json.RawMessage(`"1.5k"`),
			"outputFormat": json.RawMessage(`"png"`),
			"background":   json.RawMessage(`"opaque"`),
			"watermark":    json.RawMessage(`true`),
		}},
		References: []ai.ImageReference{{Name: "main.png", ContentType: "image/png", Data: []byte("main")}, {Name: "reference.jpg", ContentType: "image/jpeg", Data: []byte("reference")}},
	})
	if err != nil {
		t.Fatalf("NormalizeImageTaskRequest() error = %v", err)
	}
	if normalized.Request.Size != "2048x1152" || normalized.Request.Resolution != "1.5k" {
		t.Fatalf("normalized request = %#v", normalized.Request)
	}
	if _, exists := normalized.Request.Options["watermark"]; exists {
		t.Fatalf("normalized request retained removed watermark option: %#v", normalized.Request.Options)
	}
	task, err := provider.(ai.ImageTaskProvider).CreateImageTask(context.Background(), normalized)
	if err != nil {
		t.Fatalf("CreateImageTask() error = %v", err)
	}
	if task.Status != "completed" || len(task.ResultURLs) != 1 || task.ResultURLs[0] != "https://images.example.test/result.png" {
		t.Fatalf("task = %#v", task)
	}
}

func TestDoubaoSeedreamRejectsUnsupportedMaskAndReferenceCounts(t *testing.T) {
	typeInfo, _ := ai.Type("doubao-seedream-5-pro")
	provider, err := typeInfo.New(json.RawMessage(`{"apiKey":"test-key","model":"doubao-seedream-5-0-pro-260628"}`))
	if err != nil {
		t.Fatal(err)
	}
	adapter := provider.(ai.ImageTaskRequestAdapter)
	if _, err := adapter.NormalizeImageTaskRequest(ai.ImageTaskRequest{Request: ai.ImageRequest{Prompt: "编辑"}, References: make([]ai.ImageReference, 11)}); err == nil {
		t.Fatal("NormalizeImageTaskRequest() accepted eleven reference images")
	}
	if _, err := adapter.NormalizeImageTaskRequest(ai.ImageTaskRequest{Request: ai.ImageRequest{Prompt: "编辑"}, References: []ai.ImageReference{{ContentType: "image/png"}}, Mask: &ai.ImageReference{ContentType: "image/png"}}); err == nil {
		t.Fatal("NormalizeImageTaskRequest() accepted a hand-drawn mask")
	}
	if _, err := adapter.NormalizeImageTaskRequest(ai.ImageTaskRequest{Request: ai.ImageRequest{Prompt: "编辑", Options: ai.ImageRequestOptions{"background": json.RawMessage(`"transparent"`)}}, References: []ai.ImageReference{{ContentType: "image/jpeg"}}}); err == nil {
		t.Fatal("NormalizeImageTaskRequest() accepted transparent output from a JPEG reference")
	}
}

func TestDoubaoSeedreamSummarizesWithoutSecretsOrImageData(t *testing.T) {
	typeInfo, _ := ai.Type("doubao-seedream-5-pro")
	provider, err := typeInfo.New(json.RawMessage(`{"apiKey":"test-secret","model":"doubao-seedream-5-0-pro-260628"}`))
	if err != nil {
		t.Fatal(err)
	}
	adapter := provider.(ai.ImageTaskRequestAdapter)
	request, err := adapter.NormalizeImageTaskRequest(ai.ImageTaskRequest{
		Request:    ai.ImageRequest{Prompt: "画一件蓝色外套", Options: ai.ImageRequestOptions{"watermark": json.RawMessage(`false`)}},
		References: []ai.ImageReference{{Name: "reference.png", ContentType: "image/png", Data: []byte("do-not-record-me")}},
	})
	if err != nil {
		t.Fatal(err)
	}
	summary, err := provider.(ai.ImageTaskRequestSummarizer).SummarizeImageTaskRequest(request)
	if err != nil {
		t.Fatal(err)
	}
	body := string(summary.JSONBody)
	if !strings.Contains(body, "data:image/png;base64,<base64>") || strings.Contains(body, "test-secret") || strings.Contains(body, "do-not-record-me") {
		t.Fatalf("summary leaked or omitted redaction: %s", body)
	}
}
