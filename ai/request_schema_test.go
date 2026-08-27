package ai

import (
	"encoding/json"
	"testing"
)

func TestNormalizeImageRequestOptionsAppliesDefaultsAndRejectsInvalidValues(t *testing.T) {
	schema := ImageRequestSchema{
		Version: "v1",
		Fields: []ImageRequestField{
			{Key: "resolution", Type: ImageRequestFieldSelect, Default: json.RawMessage(`"1K"`), Options: []ImageRequestFieldOption{{Value: "1K"}, {Value: "2K"}}},
			{Key: "watermark", Type: ImageRequestFieldBoolean, Default: json.RawMessage(`true`)},
		},
	}

	options, err := NormalizeImageRequestOptions(schema, ImageRequestOptions{"resolution": json.RawMessage(`"2K"`), "watermark": json.RawMessage(`false`)})
	if err != nil {
		t.Fatalf("NormalizeImageRequestOptions() error = %v", err)
	}
	if string(options["resolution"]) != `"2K"` || string(options["watermark"]) != "false" {
		t.Fatalf("normalized options = %#v", options)
	}

	defaults, err := NormalizeImageRequestOptions(schema, nil)
	if err != nil {
		t.Fatalf("NormalizeImageRequestOptions() defaults error = %v", err)
	}
	if string(defaults["resolution"]) != `"1K"` || string(defaults["watermark"]) != "true" {
		t.Fatalf("default options = %#v", defaults)
	}

	if _, err := NormalizeImageRequestOptions(schema, ImageRequestOptions{"resolution": json.RawMessage(`"4K"`)}); err == nil {
		t.Fatal("NormalizeImageRequestOptions() accepted an unsupported select option")
	}
	if _, err := NormalizeImageRequestOptions(schema, ImageRequestOptions{"watermark": json.RawMessage(`"false"`)}); err == nil {
		t.Fatal("NormalizeImageRequestOptions() accepted a string for a boolean option")
	}
	if _, err := NormalizeImageRequestOptions(schema, ImageRequestOptions{"unknown": json.RawMessage(`true`)}); err == nil {
		t.Fatal("NormalizeImageRequestOptions() accepted an unknown option")
	}
}
