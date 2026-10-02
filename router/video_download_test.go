package router

import (
	"encoding/json"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/basketikun/infinite-canvas/service"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestVideoDownloadAccessAndLocalAttachment(t *testing.T) {
	id := "download-video-test"
	key := "download-test.mp4"
	if err := os.WriteFile(filepath.Join(mediaTestDirectory, key), []byte("local-video-bytes"), 0600); err != nil {
		t.Fatal(err)
	}
	_, err := repository.SaveMedia(model.Media{ID: id, OwnerUID: fixtureUID("download-owner"), ObjectKey: key, ContentType: "video/mp4", Source: model.MediaSourceUpload, CreatedAt: time.Now().UTC().Format(time.RFC3339Nano)})
	if err != nil {
		t.Fatal(err)
	}
	path := "/api/v1/media/" + id + "/access?download=1&filename=canvas-video-node.mp4"
	denied := decodeCanvasResponse(t, canvasRequest(t, "GET", path, fixtureUID("other-user"), ""))
	if denied.Code == 0 {
		t.Fatal("unauthorized download allowed")
	}
	result := decodeCanvasResponse(t, canvasRequest(t, "GET", path, fixtureUID("download-owner"), ""))
	if result.Code != 0 {
		t.Fatal(result.Msg)
	}
	var access service.MediaAccess
	if err = json.Unmarshal(result.Data, &access); err != nil {
		t.Fatal(err)
	}
	content := canvasRequest(t, "GET", access.URL, fixtureUID("download-owner"), "")
	if !strings.Contains(content.Header().Get("Content-Disposition"), "attachment") || content.Body.String() != "local-video-bytes" {
		t.Fatalf("invalid download: %v %s", content.Header(), content.Body.String())
	}
	missing := decodeCanvasResponse(t, canvasRequest(t, "GET", "/api/v1/media/missing-download/access?download=1", fixtureUID("download-owner"), ""))
	if missing.Code == 0 {
		t.Fatal("missing media allowed")
	}
	db, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	if err = db.Model(&model.Media{}).Where("id = ?", id).Update("cleanup_status", model.MediaCleanupDeleting).Error; err != nil {
		t.Fatal(err)
	}
	unavailable := decodeCanvasResponse(t, canvasRequest(t, "GET", path, fixtureUID("download-owner"), ""))
	if unavailable.Code == 0 {
		t.Fatal("deleting media allowed")
	}

}
