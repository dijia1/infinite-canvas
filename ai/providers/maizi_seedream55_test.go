package providers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"testing"

	"github.com/basketikun/infinite-canvas/ai"
)

func TestMaiziSeedream55RequestsAndPolling(t *testing.T) {
	info, ok := ai.Type("maizi-seedream-5-5")
	if !ok || info.ImageRequestSchema.MaxReferenceImages != 10 || info.ImageRequestSchema.SupportsMask {
		t.Fatalf("definition=%+v", info)
	}
	for _, resolution := range []string{"1K", "1.5K", "2K"} {
		for _, refs := range []int{0, 10} {
			t.Run(fmt.Sprintf("%s/%d", resolution, refs), func(t *testing.T) {
				instance, err := info.New(json.RawMessage(`{"apiKey":"test-key","model":"seedream-5-5"}`))
				if err != nil {
					t.Fatal(err)
				}
				p := instance.(*maiziProvider)
				request := ai.ImageTaskRequest{Request: ai.ImageRequest{Prompt: "产品摄影", Count: 1, Resolution: resolution, Size: "9:16", OutputFormat: "png", Background: "transparent", Quality: "auto"}}
				urls := []string{}
				for i := 0; i < refs; i++ {
					url := fmt.Sprintf("https://example.test/%d.png", i)
					urls = append(urls, url)
					request.References = append(request.References, ai.ImageReference{URL: url})
				}
				normalized, err := p.NormalizeImageTaskRequest(request)
				if err != nil {
					t.Fatal(err)
				}
				canonical, err := info.CanonicalizeImageTaskRequest(request)
				if err != nil || !reflect.DeepEqual(normalized, canonical) {
					t.Fatalf("hash and submission differ: %v", err)
				}
				p.client = &http.Client{Transport: roundTripperFunc(func(r *http.Request) (*http.Response, error) {
					if r.Header.Get("Authorization") != "Bearer test-key" {
						t.Fatal("missing auth")
					}
					if r.Method == http.MethodGet {
						if r.URL.String() != "https://www.maizitech.ai/v1/tasks/job" {
							t.Fatal(r.URL)
						}
						return jsonResponse(`{"status":"completed","result_urls":["https://example.test/result.png"]}`), nil
					}
					if r.URL.String() != "https://www.maizitech.ai/v1/images/generations" {
						t.Fatal(r.URL)
					}
					var body map[string]any
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Fatal(err)
					}
					expected := map[string]any{"model": "seedream-5-5", "prompt": "产品摄影", "n": float64(1), "size": "9:16", "resolution": resolution, "output_format": "png", "background": "transparent"}
					if refs > 0 {
						items := []any{}
						for _, url := range urls {
							items = append(items, url)
						}
						expected["images"] = items
					}
					if !reflect.DeepEqual(body, expected) {
						t.Fatalf("body=%#v want=%#v", body, expected)
					}
					return jsonResponse(`{"data":[{"task_id":"job","status":"pending"}]}`), nil
				})}
				task, err := p.CreateImageTask(context.Background(), normalized)
				if err != nil || task.ID != "job" {
					t.Fatalf("%+v %v", task, err)
				}
				task, err = p.GetImageTask(context.Background(), task.ID)
				if err != nil || task.Status != ai.ImageTaskStatusCompleted || len(task.ResultURLs) != 1 {
					t.Fatalf("%+v %v", task, err)
				}
			})
		}
	}
}

func TestMaiziSeedream55DefaultsAndInvalidInputs(t *testing.T) {
	info, _ := ai.Type("maizi-seedream-5-5")
	request := ai.ImageTaskRequest{Request: ai.ImageRequest{Prompt: "产品"}}
	normalized, err := info.CanonicalizeImageTaskRequest(request)
	if err != nil || normalized.Request.Resolution != "2K" || normalized.Request.OutputFormat != "png" || normalized.Request.Size != "1:1" || normalized.Request.Background != "auto" {
		t.Fatalf("%+v %v", normalized, err)
	}
	tests := map[string]func(*ai.ImageTaskRequest){
		"references":       func(r *ai.ImageTaskRequest) { r.References = make([]ai.ImageReference, 11) },
		"mask":             func(r *ai.ImageTaskRequest) { r.Mask = &ai.ImageReference{} },
		"resolution":       func(r *ai.ImageTaskRequest) { r.Request.Resolution = "4K" },
		"ratio":            func(r *ai.ImageTaskRequest) { r.Request.Size = "auto" },
		"transparent jpeg": func(r *ai.ImageTaskRequest) { r.Request.OutputFormat = "jpeg"; r.Request.Background = "transparent" },
		"prompt":           func(r *ai.ImageTaskRequest) { r.Request.Prompt = "" },
		"quality option": func(r *ai.ImageTaskRequest) {
			r.Request.Options = ai.ImageRequestOptions{"quality": json.RawMessage(`"high"`)}
		},
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			r := request
			mutate(&r)
			if _, err := info.CanonicalizeImageTaskRequest(r); err == nil {
				t.Fatal("accepted invalid request")
			}
		})
	}
	request.Request.OutputFormat = "jpeg"
	if _, err := info.CanonicalizeImageTaskRequest(request); err != nil {
		t.Fatal(err)
	}
}
