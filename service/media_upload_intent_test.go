package service

import "testing"

func TestValidateMediaUploadIntentInputRejectsInvalidMetadata(t *testing.T) {
	valid := MediaUploadIntentInput{Filename: "sample.png", ContentType: "image/png", Bytes: 1024, Intent: "library"}
	if _, _, _, err := validateMediaUploadIntentInput(valid); err != nil {
		t.Fatalf("valid metadata error = %v", err)
	}
	for _, input := range []MediaUploadIntentInput{
		{Filename: "", ContentType: "image/png", Bytes: 1, Intent: "library"},
		{Filename: "sample.txt", ContentType: "text/plain", Bytes: 1, Intent: "library"},
		{Filename: "sample.png", ContentType: "image/png", Bytes: 0, Intent: "library"},
		{Filename: "sample.png", ContentType: "image/png", Bytes: maxMediaBytes + 1, Intent: "library"},
		{Filename: "sample.png", ContentType: "image/png", Bytes: 1, Intent: "unknown"},
	} {
		if _, _, _, err := validateMediaUploadIntentInput(input); err == nil {
			t.Fatalf("input %#v was accepted", input)
		}
	}
}

func TestMediaUploadSizeLimitsSeparateVideoFromImages(t *testing.T) {
	for _, test := range []struct {
		contentType string
		bytes       int64
		valid       bool
	}{
		{"video/mp4", 50<<20 + 1, true},
		{"video/mp4", 100 << 20, true},
		{"video/mp4", 100<<20 + 1, false},
		{"image/png", 50 << 20, true},
		{"image/png", 50<<20 + 1, false},
	} {
		input := MediaUploadIntentInput{Filename: "sample", ContentType: test.contentType, Bytes: test.bytes, Intent: "canvas"}
		if _, _, _, err := validateMediaUploadIntentInput(input); (err == nil) != test.valid {
			t.Fatalf("%s %d bytes: %v, want valid=%v", test.contentType, test.bytes, err, test.valid)
		}
	}
}
