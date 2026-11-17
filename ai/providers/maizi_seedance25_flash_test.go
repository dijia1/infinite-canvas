package providers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"github.com/basketikun/infinite-canvas/ai"
)

func flashVideoTestProvider(t *testing.T, transport roundTripperFunc) *maiziVideoProvider {
	t.Helper()
	info, ok := ai.Type("maizi-video-seedance-2-5-flash")
	if !ok {
		t.Fatal("Flash not registered")
	}
	provider, err := info.New(json.RawMessage(`{"apiKey":"flash-key","model":"doubao-seedance-2.5-flash"}`))
	if err != nil {
		t.Fatal(err)
	}
	p := provider.(*maiziVideoProvider)
	p.client = &http.Client{Transport: transport}
	return p
}

func TestSeedance25FlashUsesRegisteredDefinitionAndOrderedReferences(t *testing.T) {
	info, _ := ai.Type("maizi-video-seedance-2-5-flash")
	s := info.VideoRequestSchema
	if s == nil || s.SupportsDraft || !s.SupportsAudio || s.MinDuration != 4 || s.MaxDuration != 30 || s.DefaultDuration != 5 || s.MaxReferenceImages != 6 || s.MaxReferenceVideos != 3 || s.MaxReferenceMedia != 6 || s.MaxReferenceVideoDuration != 15 {
		t.Fatalf("wrong Flash capabilities: %+v", s)
	}
	if _, err := info.New(json.RawMessage(`{"apiKey":"fixture","model":"doubao-seedance-2.5"}`)); err == nil {
		t.Fatal("standard model accepted as Flash")
	}
	for _, resolution := range []string{"480p", "720p"} {
		request := validVideoRequest()
		request.Resolution, request.Size, request.Seconds, request.GenerateAudio = resolution, "adaptive", "30", true
		request.ImageURLs = []string{"https://example.com/b.png", "https://example.com/a.png", "https://example.com/b.png"}
		request.VideoURLs = []string{"https://example.com/b.mp4", "https://example.com/a.mp4", "https://example.com/c.mp4"}
		p := flashVideoTestProvider(t, func(r *http.Request) (*http.Response, error) {
			if r.Method != http.MethodPost || r.URL.String() != maiziVideoBaseURL+"/videos/generations" || r.Header.Get("Authorization") != "Bearer flash-key" {
				t.Fatalf("wrong endpoint or auth: %v", r.URL)
			}
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if body["model"] != "doubao-seedance-2.5-flash" || body["resolution"] != resolution || body["size"] != "adaptive" || body["duration"] != float64(30) || body["generate_audio"] != true || body["output_format"] != "mp4" {
				t.Fatal(body)
			}
			if !reflect.DeepEqual(body["image_urls"], []any{request.ImageURLs[0], request.ImageURLs[1], request.ImageURLs[2]}) || !reflect.DeepEqual(body["video_urls"], []any{request.VideoURLs[0], request.VideoURLs[1], request.VideoURLs[2]}) {
				t.Fatal("reference order or duplicates changed", body)
			}
			for _, key := range []string{"draft", "draft_task_id", "audio_urls", "first_frame_image", "last_frame_image", "return_last_frame", "seed", "generation_type"} {
				if _, ok := body[key]; ok {
					t.Fatal("unexpected parameter", key)
				}
			}
			return videoResponse(200, `{"id":"flash-task","status":"pending"}`), nil
		})
		if task, err := p.CreateVideo(context.Background(), request); err != nil || task.ID != "flash-task" {
			t.Fatalf("%+v %v", task, err)
		}
	}
}

func TestSeedance25FlashRejectsUnsupportedRequestsBeforeSending(t *testing.T) {
	p := flashVideoTestProvider(t, func(*http.Request) (*http.Response, error) {
		t.Fatal("invalid Flash request reached supplier")
		return nil, nil
	})
	for name, change := range map[string]func(*ai.VideoRequest){
		"too short":     func(r *ai.VideoRequest) { r.Seconds = "3" },
		"too long":      func(r *ai.VideoRequest) { r.Seconds = "31" },
		"auto duration": func(r *ai.VideoRequest) { r.Seconds = "-1" },
		"fraction":      func(r *ai.VideoRequest) { r.Seconds = "4.5" },
		"1080p":         func(r *ai.VideoRequest) { r.Resolution = "1080p" },
		"ratio":         func(r *ai.VideoRequest) { r.Size = "2:1" },
		"draft":         func(r *ai.VideoRequest) { r.Mode = "draft"; r.Resolution = "480p" },
		"final":         func(r *ai.VideoRequest) { r.Mode = "final"; r.DraftTaskID = "sample" },
		"mixed overflow": func(r *ai.VideoRequest) {
			r.ImageURLs = []string{"https://example.com/1", "https://example.com/2", "https://example.com/3", "https://example.com/4"}
			r.VideoURLs = []string{"https://example.com/1", "https://example.com/2", "https://example.com/3"}
		},
		"video overflow": func(r *ai.VideoRequest) {
			r.VideoURLs = []string{"https://example.com/1", "https://example.com/2", "https://example.com/3", "https://example.com/4"}
		},
		"local URL": func(r *ai.VideoRequest) { r.ImageURLs = []string{"file:///local.png"} },
	} {
		t.Run(name, func(t *testing.T) {
			r := validVideoRequest()
			change(&r)
			_, err := p.CreateVideo(context.Background(), r)
			var rejected *ai.VideoSubmissionError
			if !errors.As(err, &rejected) || rejected.Uncertain {
				t.Fatalf("expected explicit rejection, got %v", err)
			}
		})
	}
}

func TestSeedance25FlashPollsAndNormalizesViolationAsTerminalFailure(t *testing.T) {
	for _, status := range []string{"pending", "queued", "processing", "completed", "failed", "violation"} {
		t.Run(status, func(t *testing.T) {
			p := flashVideoTestProvider(t, func(r *http.Request) (*http.Response, error) {
				if r.Method != http.MethodGet || r.URL.Path != "/v1/tasks/flash-task" {
					t.Fatal(r.URL)
				}
				return videoResponse(200, fmt.Sprintf(`{"id":"flash-task","status":%q,"result_urls":["https://example.com/result.mp4"],"error_msg":"private supplier details"}`, status)), nil
			})
			task, err := p.GetVideo(context.Background(), "flash-task")
			if err != nil || strings.Contains(task.Error, "private") {
				t.Fatalf("%+v %v", task, err)
			}
			if status == "violation" {
				if task.Status != "failed" || !strings.Contains(task.Error, "审核") {
					t.Fatal(task)
				}
			} else if task.Status != status {
				t.Fatal(task)
			}
		})
	}
}
