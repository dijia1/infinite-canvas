package service

import (
	"testing"

	"github.com/basketikun/infinite-canvas/ai"
)

func TestNormalizeImageTaskRequestDefaultsAndValidatesImageAndMaskCounts(t *testing.T) {
	request, err := normalizeImageTaskRequest(CreateImageTaskRequest{
		ClientRequestID: "request-defaults",
		Mode:            ImageTaskModeGeneration,
		Request:         ai.ImageRequest{Prompt: "生成图", Count: 1},
	})
	if err != nil {
		t.Fatalf("normalizeImageTaskRequest() error = %v", err)
	}
	if request.Request.OutputFormat != "jpeg" || request.Request.Background != "opaque" {
		t.Fatalf("defaults = %q/%q, want jpeg/opaque", request.Request.OutputFormat, request.Request.Background)
	}

	invalidFormat := CreateImageTaskRequest{ClientRequestID: "request-invalid-format", Mode: ImageTaskModeGeneration, Request: ai.ImageRequest{Prompt: "生成图", Count: 1, OutputFormat: "jpeg", Background: "transparent"}}
	if _, err := normalizeImageTaskRequest(invalidFormat); err == nil {
		t.Fatal("normalizeImageTaskRequest() accepted jpeg/transparent")
	}

	maskWithoutReference := CreateImageTaskRequest{ClientRequestID: "request-no-image", Mode: ImageTaskModeEdit, Request: ai.ImageRequest{Prompt: "编辑", Count: 1}, Mask: &ai.ImageReference{ContentType: "image/png", Data: tinyPNG}}
	if _, err := normalizeImageTaskRequest(maskWithoutReference); err == nil {
		t.Fatal("normalizeImageTaskRequest() accepted a mask without an image")
	}

	sevenReferences := make([]ai.ImageReference, 7)
	for index := range sevenReferences {
		sevenReferences[index] = ai.ImageReference{ContentType: "image/png", Data: tinyPNG}
	}
	maskedMultiReference := CreateImageTaskRequest{ClientRequestID: "request-many-images", Mode: ImageTaskModeEdit, Request: ai.ImageRequest{Prompt: "编辑", Count: 1}, References: sevenReferences, Mask: &ai.ImageReference{ContentType: "image/png", Data: tinyPNG}}
	if _, err := normalizeImageTaskRequest(maskedMultiReference); err != nil {
		t.Fatalf("normalizeImageTaskRequest() rejected seven ordered images with one mask: %v", err)
	}

	eightReferences := append(sevenReferences, ai.ImageReference{ContentType: "image/png", Data: tinyPNG})
	tooManyReferences := CreateImageTaskRequest{ClientRequestID: "request-eight-images", Mode: ImageTaskModeEdit, Request: ai.ImageRequest{Prompt: "编辑", Count: 1}, References: eightReferences}
	if _, err := normalizeImageTaskRequest(tooManyReferences); err == nil {
		t.Fatal("normalizeImageTaskRequest() accepted eight edit images")
	}
}
