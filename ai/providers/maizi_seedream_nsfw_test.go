package providers

import (
	"context"
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"github.com/basketikun/infinite-canvas/ai"
)

func seedreamNSFWProviderForTest(t *testing.T) (*maiziProvider, ai.ProviderType) {
	t.Helper()
	info, ok := ai.Type("maizi-seedream-5-pro-nsfw")
	if !ok {
		t.Fatal("Seedream Pro NSFW provider is not registered")
	}
	instance, err := info.New(json.RawMessage(`{"apiKey":" test-key ","model":" administrator-model "}`))
	if err != nil {
		t.Fatal(err)
	}
	return instance.(*maiziProvider), info
}

func TestMaiziSeedreamNSFWCapabilitiesAreSeparateFromGenericMaizi(t *testing.T) {
	_, info := seedreamNSFWProviderForTest(t)
	if !info.Supports(ai.CapabilityImageGenerate) || !info.Supports(ai.CapabilityImageEdit) || info.CanonicalizeImageTaskRequest == nil {
		t.Fatal("missing image capabilities or request canonicalizer")
	}
	schema := info.ImageRequestSchema
	if schema == nil || schema.MaxReferenceImages != 10 || schema.SupportsMask {
		t.Fatalf("schema=%+v", schema)
	}
	keys := []string{}
	for _, field := range schema.Fields {
		keys = append(keys, field.Key)
	}
	if !reflect.DeepEqual(keys, []string{"size", "resolution", "outputFormat"}) {
		t.Fatalf("fields=%v", keys)
	}
	ordinary, _ := ai.Type("maizi-image")
	if ordinary.ImageRequestSchema.MaxReferenceImages != 7 || !ordinary.ImageRequestSchema.SupportsMask {
		t.Fatal("generic Maizi schema changed")
	}
}

func TestMaiziSeedreamNSFWSendsDocumentedBodyAndRedactsSummary(t *testing.T) {
	for _, count := range []int{0, 10} {
		t.Run(string(rune('A'+count)), func(t *testing.T) {
			provider, _ := seedreamNSFWProviderForTest(t)
			request := ai.ImageTaskRequest{Request: ai.ImageRequest{Prompt: "影棚产品摄影", Count: 1, Size: "16:9", Resolution: "2K", OutputFormat: "png", Quality: "auto", Background: "auto"}}
			for i := 0; i < count; i++ {
				request.References = append(request.References, ai.ImageReference{URL: "https://signed.example/input?versionId=version-a&Signature=secret"})
			}
			normalized, err := provider.NormalizeImageTaskRequest(request)
			if err != nil {
				t.Fatal(err)
			}
			calls := 0
			provider.client = &http.Client{Transport: roundTripperFunc(func(r *http.Request) (*http.Response, error) {
				calls++
				if r.Method != http.MethodPost || r.URL.String() != "https://www.maizitech.ai/v1/images/generations" {
					t.Fatalf("request=%s %s", r.Method, r.URL)
				}
				if r.Header.Get("Authorization") != "Bearer test-key" || r.Header.Get("Content-Type") != "application/json" {
					t.Fatal("request headers incorrect")
				}
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Fatal(err)
				}
				expected := map[string]any{"model": "administrator-model", "prompt": "影棚产品摄影", "size": "16:9", "resolution": "2K", "output_format": "png", "nsfw_check": false}
				if count > 0 {
					images := make([]any, count)
					for i := range images {
						images[i] = request.References[i].URL
					}
					expected["images"] = images
				}
				if !reflect.DeepEqual(body, expected) {
					t.Fatalf("body=%#v want=%#v", body, expected)
				}
				return jsonResponse(`{"data":[{"task_id":"accepted-task","status":"processing"}]}`), nil
			})}
			created, err := provider.CreateImageTask(context.Background(), normalized)
			if err != nil || created.ID != "accepted-task" || created.Status != ai.ImageTaskStatusRunning || calls != 1 {
				t.Fatalf("task=%+v calls=%d err=%v", created, calls, err)
			}
			summary, err := provider.SummarizeImageTaskRequest(normalized)
			if err != nil {
				t.Fatal(err)
			}
			if summary.Endpoint != "https://www.maizitech.ai/v1/images/generations" || strings.Contains(string(summary.JSONBody), "Signature") || strings.Contains(string(summary.JSONBody), "test-key") {
				t.Fatalf("summary=%+v", summary)
			}
			var body map[string]any
			if err := json.Unmarshal(summary.JSONBody, &body); err != nil {
				t.Fatal(err)
			}
			if value, ok := body["nsfw_check"].(bool); !ok || value {
				t.Fatalf("nsfw_check=%#v", body["nsfw_check"])
			}
			if count > 0 && strings.Count(string(summary.JSONBody), "<signed-url>") != count {
				t.Fatalf("redaction=%s", summary.JSONBody)
			}
		})
	}
}

func TestMaiziSeedreamNSFWRejectsUnsupportedInputsBeforeSubmission(t *testing.T) {
	provider, _ := seedreamNSFWProviderForTest(t)
	for _, tc := range []struct {
		name       string
		references int
		mask       bool
		background string
		options    ai.ImageRequestOptions
	}{
		{name: "eleven references", references: 11},
		{name: "mask", references: 1, mask: true},
		{name: "transparent background", background: "transparent"},
		{name: "override fixed review policy", options: ai.ImageRequestOptions{"nsfw_check": json.RawMessage(`true`)}},
		{name: "unsupported quality", options: ai.ImageRequestOptions{"quality": json.RawMessage(`"high"`)}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := ai.ImageTaskRequest{Request: ai.ImageRequest{Prompt: "产品摄影", Count: 1, Resolution: "1K", Background: tc.background, Options: tc.options}, References: make([]ai.ImageReference, tc.references)}
			if tc.mask {
				r.Mask = &ai.ImageReference{}
			}
			if _, err := provider.NormalizeImageTaskRequest(r); err == nil {
				t.Fatal("accepted unsupported input")
			}
		})
	}
	r, err := provider.NormalizeImageTaskRequest(ai.ImageTaskRequest{Request: ai.ImageRequest{Prompt: "产品摄影", Resolution: "1K"}})
	if err != nil || r.Request.OutputFormat != "jpeg" || r.Request.Size != "1:1" || r.Request.Background != "opaque" || r.Request.Quality != "" {
		t.Fatalf("defaults=%+v err=%v", r.Request, err)
	}
}

func TestMaiziSeedreamNSFWPollsSameEndpointAndNormalizesFailure(t *testing.T) {
	provider, _ := seedreamNSFWProviderForTest(t)
	provider.client = &http.Client{Transport: roundTripperFunc(func(r *http.Request) (*http.Response, error) {
		if r.Method != http.MethodGet || r.URL.String() != "https://www.maizitech.ai/v1/tasks/accepted-task" || r.Header.Get("Authorization") != "Bearer test-key" {
			t.Fatalf("poll=%s %s", r.Method, r.URL)
		}
		return jsonResponse(`{"id":"accepted-task","status":"violation","error_msg":"上游拒绝"}`), nil
	})}
	task, err := provider.GetImageTask(context.Background(), "accepted-task")
	if err != nil || task.ID != "accepted-task" || task.Status != ai.ImageTaskStatusFailed || task.Error != "上游拒绝" {
		t.Fatalf("task=%+v err=%v", task, err)
	}
}

func TestMaiziSeedreamNSFWDoesNotChangeOrdinaryRequestPolicy(t *testing.T) {
	ordinary, err := newMaiziProvider(json.RawMessage(`{"apiKey":"key","model":"ordinary-model"}`))
	if err != nil {
		t.Fatal(err)
	}
	summary, err := ordinary.(ai.ImageTaskRequestSummarizer).SummarizeImageTaskRequest(ai.ImageTaskRequest{Request: ai.ImageRequest{Prompt: "产品摄影", Resolution: "1K"}})
	if err != nil {
		t.Fatal(err)
	}
	if summary.Endpoint != maiziBaseURL+"/images/generations" || strings.Contains(string(summary.JSONBody), "nsfw_check") || !strings.Contains(string(summary.JSONBody), "background") {
		t.Fatalf("ordinary summary=%+v", summary)
	}
}
