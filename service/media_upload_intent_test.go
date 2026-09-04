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
