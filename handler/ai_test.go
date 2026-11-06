package handler

import (
	"encoding/json"
	"testing"
)

func TestImageRequestOptionsFromJSONRejectsNonObject(t *testing.T) {
	options, err := imageRequestOptionsFromJSON(json.RawMessage(`{"resolution":"1.5k","watermark":false}`))
	if err != nil {
		t.Fatalf("imageRequestOptionsFromJSON() error = %v", err)
	}
	if string(options["resolution"]) != `"1.5k"` || string(options["watermark"]) != "false" {
		t.Fatalf("imageRequestOptionsFromJSON() = %#v", options)
	}
	if _, err := imageRequestOptionsFromJSON(json.RawMessage(`[]`)); err == nil {
		t.Fatal("imageRequestOptionsFromJSON() accepted a non-object")
	}
}
