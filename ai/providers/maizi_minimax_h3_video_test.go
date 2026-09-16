package providers

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/basketikun/infinite-canvas/ai"
)

func minimaxH3TestProvider(model string, fn roundTripperFunc) *maiziMiniMaxH3VideoProvider {
	return &maiziMiniMaxH3VideoProvider{
		config: maiziConfig{APIKey: "secret", Model: model},
		client: &http.Client{Transport: fn},
	}
}

func TestMaiziMiniMaxH3RequestUsesAdministratorConfiguration(t *testing.T) {
	provider := minimaxH3TestProvider(" administrator-model ", func(request *http.Request) (*http.Response, error) {
		if request.Method != http.MethodPost || request.URL.String() != maiziVideoBaseURL+"/videos/generations" || request.Header.Get("Authorization") != "Bearer secret" {
			t.Fatalf("request = %s %s auth=%q", request.Method, request.URL, request.Header.Get("Authorization"))
		}
		var body map[string]any
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body["model"] != "administrator-model" || body["prompt"] != "animate" || body["duration"] != float64(5) || body["resolution"] != "custom-resolution" || body["size"] != "16:9" {
			t.Fatalf("body = %#v", body)
		}
		images, ok := body["image_urls"].([]any)
		if !ok || len(images) != 1 || images[0] != "https://example.com/reference.png" {
			t.Fatalf("image_urls = %#v", body["image_urls"])
		}
		for _, key := range []string{"aspect_ratio", "video_urls", "audio_urls", "generate_audio", "image_with_roles", "first_frame_image", "last_frame_image", "watermark", "webhook"} {
			if _, exists := body[key]; exists {
				t.Fatalf("unexpected field %q in %#v", key, body)
			}
		}
		return videoResponse(http.StatusOK, `{"id":"minimax-task","status":"processing","model":"administrator-model"}`), nil
	})

	task, err := provider.CreateVideo(context.Background(), ai.VideoRequest{
		Prompt: "animate", Seconds: "5", Size: "16:9", Resolution: "custom-resolution", ImageURLs: []string{"https://example.com/reference.png"},
	})
	if err != nil || task.ID != "minimax-task" || task.Status != "processing" {
		t.Fatalf("task = %#v, err=%v", task, err)
	}
}

func TestMaiziMiniMaxH3RejectsUnsupportedInputsBeforeSubmission(t *testing.T) {
	calls := 0
	provider := minimaxH3TestProvider("minimax-h3", func(*http.Request) (*http.Response, error) {
		calls++
		return videoResponse(http.StatusOK, `{"id":"unexpected","status":"processing"}`), nil
	})
	valid := ai.VideoRequest{Prompt: "animate", Seconds: "5", Size: "16:9", Resolution: "768p", ImageURLs: []string{"https://example.com/reference.png"}}
	cases := []struct {
		name   string
		mutate func(*ai.VideoRequest)
	}{
		{"duration below range", func(request *ai.VideoRequest) { request.Seconds = "4" }},
		{"duration above range", func(request *ai.VideoRequest) { request.Seconds = "16" }},
		{"video reference", func(request *ai.VideoRequest) { request.VideoURLs = []string{"https://example.com/reference.mp4"} }},
		{"audio", func(request *ai.VideoRequest) { request.GenerateAudio = true }},
		{"embedded reference", func(request *ai.VideoRequest) { request.References = []ai.ImageReference{{Data: []byte("image")}} }},
		{"invalid image URL", func(request *ai.VideoRequest) { request.ImageURLs = []string{"file:///tmp/reference.png"} }},
		{"too many images", func(request *ai.VideoRequest) {
			request.ImageURLs = strings.Split(strings.Repeat("https://example.com/reference.png,", 10), ",")[:10]
		}},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			request := valid
			request.ImageURLs = append([]string(nil), valid.ImageURLs...)
			testCase.mutate(&request)
			if _, err := provider.CreateVideo(context.Background(), request); err == nil {
				t.Fatal("unsupported request was accepted")
			}
		})
	}
	if calls != 0 {
		t.Fatalf("upstream calls = %d", calls)
	}
}

func TestMaiziMiniMaxH3ReusesMaiziPolling(t *testing.T) {
	provider := minimaxH3TestProvider("minimax-h3", func(request *http.Request) (*http.Response, error) {
		if request.Method != http.MethodGet || request.URL.Path != "/v1/tasks/minimax-task" {
			t.Fatalf("request = %s %s", request.Method, request.URL)
		}
		return videoResponse(http.StatusOK, `{"id":"minimax-task","status":"completed","progress":100,"result_urls":["https://example.com/result.mp4"]}`), nil
	})
	task, err := provider.GetVideo(context.Background(), "minimax-task")
	if err != nil || task.Status != "completed" || len(task.ResultURLs) != 1 {
		t.Fatalf("task = %#v, err=%v", task, err)
	}
}

func TestMaiziMiniMaxH3ProviderTypeExposesEditableModel(t *testing.T) {
	providerType, found := ai.Type("maizi-video-minimax-h3")
	if !found || providerType.VideoRequestSchema == nil {
		t.Fatalf("provider type = %#v, found=%t", providerType, found)
	}
	if providerType.VideoRequestSchema.MinDuration != 5 || providerType.VideoRequestSchema.MaxDuration != 15 || providerType.VideoRequestSchema.MaxReferenceImages != 9 || providerType.VideoRequestSchema.MaxReferenceVideos != 0 || providerType.VideoRequestSchema.SupportsAudio {
		t.Fatalf("schema = %#v", providerType.VideoRequestSchema)
	}
	fields := map[string]bool{}
	for _, field := range providerType.ConfigFields {
		fields[field.Key] = field.Required
	}
	if !fields["apiKey"] || !fields["model"] {
		t.Fatalf("config fields = %#v", providerType.ConfigFields)
	}
}
