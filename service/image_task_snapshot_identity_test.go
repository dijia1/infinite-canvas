package service

import (
	"testing"

	"github.com/basketikun/infinite-canvas/model"
)

func TestImageTaskSnapshotInputsBindFinalizedMediaVersion(t *testing.T) {
	media := model.Media{
		ID:              "media-versioned",
		ObjectKey:       "images/private/source.png",
		ObjectVersionID: "validated-version",
		ObjectETag:      "validated-etag",
		ContentType:     "image/png",
		Bytes:           128,
		Filename:        "source.png",
	}

	inputs := imageTaskSnapshotInputs("task-versioned", []string{media.ID}, "", []model.Media{media})
	if len(inputs) != 1 {
		t.Fatalf("input count = %d, want 1", len(inputs))
	}
	if inputs[0].SourceVersionID != media.ObjectVersionID || inputs[0].SourceETag != media.ObjectETag {
		t.Fatalf("source identity = (%q, %q), want (%q, %q)", inputs[0].SourceVersionID, inputs[0].SourceETag, media.ObjectVersionID, media.ObjectETag)
	}
}
