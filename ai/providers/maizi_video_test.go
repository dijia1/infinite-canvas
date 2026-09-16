package providers

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/basketikun/infinite-canvas/ai"
	"io"
	"net/http"
	"strings"
	"testing"
)

func videoTestProvider(fn roundTripperFunc) *maiziVideoProvider {
	return &maiziVideoProvider{config: maiziConfig{APIKey: "secret", Model: "doubao-seedance-2.0-fast"}, client: &http.Client{Transport: fn}}
}
func videoResponse(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body))}
}
func validVideoRequest() ai.VideoRequest {
	return ai.VideoRequest{Prompt: "dance", Seconds: "5", Size: "16:9", Resolution: "720p", ImageURLs: []string{"https://example.com/i.png"}, VideoURLs: []string{"https://example.com/v.mp4"}}
}
func TestMaiziVideoRequestContract(t *testing.T) {
	p := videoTestProvider(func(r *http.Request) (*http.Response, error) {
		if r.URL.String() != maiziVideoBaseURL+"/videos/generations" || r.Method != "POST" || r.Header.Get("Authorization") != "Bearer secret" {
			t.Fatalf("wrong request %v", r.URL)
		}
		var body map[string]any
		if e := json.NewDecoder(r.Body).Decode(&body); e != nil {
			t.Fatal(e)
		}
		if body["duration"] != float64(5) || body["size"] != "16:9" || body["resolution"] != "720p" || body["generate_audio"] != false || body["model"] != "doubao-seedance-2.0-fast" {
			t.Fatalf("wrong fields %#v", body)
		}
		if len(body["image_urls"].([]any)) != 1 || len(body["video_urls"].([]any)) != 1 {
			t.Fatal(body)
		}
		for _, key := range []string{"seed", "audio_urls", "return_last_frame"} {
			if _, ok := body[key]; ok {
				t.Fatal(key)
			}
		}
		return videoResponse(200, `{"id":"task-1","status":"processing"}`), nil
	})
	task, e := p.CreateVideo(context.Background(), validVideoRequest())
	if e != nil || task.ID != "task-1" {
		t.Fatalf("%+v %v", task, e)
	}
}
func TestMaiziVideoPollContract(t *testing.T) {
	p := videoTestProvider(func(r *http.Request) (*http.Response, error) {
		if r.Method != "GET" || r.URL.Path != "/v1/tasks/task-1" {
			t.Fatal(r.URL)
		}
		return videoResponse(200, `{"id":"task-1","status":"completed","progress":100,"result_urls":["https://example.com/v.mp4"],"cost":0.50,"currency":"USD"}`), nil
	})
	task, e := p.GetVideo(context.Background(), "task-1")
	if e != nil || task.Progress != 100 || len(task.ResultURLs) != 1 || task.Cost != "0.50" || task.Currency != "USD" {
		t.Fatalf("%+v %v", task, e)
	}
}
func TestMaiziVideoSubmissionAmbiguityAndSafeErrors(t *testing.T) {
	for _, tc := range []struct {
		name      string
		status    int
		body      string
		transport bool
		uncertain bool
	}{
		{"rejected", 400, `secret`, false, false}, {"server", 500, `secret`, false, true}, {"timeout", 408, `secret`, false, true}, {"malformed", 200, `secret`, false, true}, {"transport", 0, "", true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := videoTestProvider(func(*http.Request) (*http.Response, error) {
				if tc.transport {
					return nil, errors.New("secret")
				}
				return videoResponse(tc.status, tc.body), nil
			})
			_, e := p.CreateVideo(context.Background(), validVideoRequest())
			var typed *ai.VideoSubmissionError
			if !errors.As(e, &typed) || typed.Uncertain != tc.uncertain || strings.Contains(e.Error(), "secret") {
				t.Fatalf("%v", e)
			}
		})
	}
}

func TestMaiziVideoSubmissionReportsStructuredValidationMessage(t *testing.T) {
	p := videoTestProvider(func(*http.Request) (*http.Response, error) {
		return videoResponse(http.StatusUnprocessableEntity, `{"message":"aspect_ratio is invalid"}`), nil
	})
	_, err := p.CreateVideo(context.Background(), validVideoRequest())
	var submission *ai.VideoSubmissionError
	if !errors.As(err, &submission) || submission.Uncertain || submission.Message != "MaiziAI 请求失败：aspect_ratio is invalid" {
		t.Fatalf("error = %#v", err)
	}
}

func TestMaiziVideoLimits(t *testing.T) {
	p := videoTestProvider(func(*http.Request) (*http.Response, error) {
		return videoResponse(200, `{"id":"id","status":"processing"}`), nil
	})
	for _, seconds := range []string{"4", "15", "3", "16", "4.5"} {
		r := validVideoRequest()
		r.Seconds = seconds
		_, e := p.CreateVideo(context.Background(), r)
		if (e == nil) != (seconds == "4" || seconds == "15") {
			t.Fatalf("%s %v", seconds, e)
		}
	}
	for _, count := range []int{9, 10} {
		r := validVideoRequest()
		r.ImageURLs = nil
		for i := 0; i < count; i++ {
			r.ImageURLs = append(r.ImageURLs, "https://example.com/i.png")
		}
		_, e := p.CreateVideo(context.Background(), r)
		if (e == nil) != (count == 9) {
			t.Fatal(count, e)
		}
	}
	for _, count := range []int{3, 4} {
		r := validVideoRequest()
		r.VideoURLs = nil
		for i := 0; i < count; i++ {
			r.VideoURLs = append(r.VideoURLs, "https://example.com/v.mp4")
		}
		_, e := p.CreateVideo(context.Background(), r)
		if (e == nil) != (count == 3) {
			t.Fatal(count, e)
		}
	}
}
func TestMaiziVideoRejectsInvalidResults(t *testing.T) {
	for _, body := range []string{`{"id":"id","status":"completed","result_urls":[]}`, `{"id":"id","status":"completed","result_urls":["file:///etc/passwd"]}`, `{"id":"id","status":"unknown"}`, strings.Repeat("x", (1<<20)+1)} {
		p := videoTestProvider(func(*http.Request) (*http.Response, error) { return videoResponse(200, body), nil })
		if _, e := p.GetVideo(context.Background(), "id"); e == nil {
			t.Fatal("accepted invalid result")
		}
	}
}

func TestMaiziVideoRejectsMismatchedTaskID(t *testing.T) {
	p := videoTestProvider(func(*http.Request) (*http.Response, error) {
		return videoResponse(200, `{"id":"other","status":"processing"}`), nil
	})
	if _, err := p.GetVideo(context.Background(), "requested"); err == nil {
		t.Fatal("accepted another task response")
	}
}
