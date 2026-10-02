package router

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"github.com/gin-gonic/gin"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

func TestWorkflowImageDownloadValidatesOwnerMediaAndStreamsZIP(t *testing.T) {
	restore := configureWorkflowRouteRuntime(t)
	defer restore()
	owner := fixtureUID("zip-owner-" + time.Now().Format("150405.000000000"))
	seedRouteWorkflowMember(t, owner, true)
	seedRouteWorkflowMember(t, owner+"-other", true)
	workflowID := createRouteWorkflow(t, owner, "1k")
	start := workflowRequest(http.MethodPost, "/api/v1/workflows/"+workflowID+"/runs", owner, `{"requestId":"zip-run"}`)
	var result struct {
		Run model.WorkflowRun `json:"run"`
	}
	if err := json.Unmarshal(workflowResponse(t, start).Data, &result); err != nil || result.Run.ID == "" {
		t.Fatalf("run=%s", start.Body)
	}
	path := "/api/v1/workflow-runs/" + result.Run.ID + "/images/download"
	if response := workflowRequest(http.MethodGet, path+"?check=1", owner, ""); workflowResponse(t, response).Code == 0 {
		t.Fatal("empty run accepted")
	}
	key := "zip-test-" + owner + ".png"
	content := []byte("original-image-content")
	if err := os.WriteFile(filepath.Join(mediaTestDirectory, key), content, 0600); err != nil {
		t.Fatal(err)
	}
	item, err := repository.SaveMedia(model.Media{ID: "media-" + owner, OwnerUID: owner, ObjectKey: key, ContentType: "image/png", Bytes: int64(len(content)), Filename: "测试.png"})
	if err != nil {
		t.Fatal(err)
	}
	db, _ := repository.DB()
	if err := db.Model(&model.WorkflowOutputExecution{}).Where("run_id = ?", result.Run.ID).Updates(map[string]any{"status": "succeeded", "media_id": item.ID}).Error; err != nil {
		t.Fatal(err)
	}
	check := workflowRequest(http.MethodGet, path+"?check=1", owner, "")
	if workflowResponse(t, check).Code != 0 {
		t.Fatalf("check=%s", check.Body)
	}
	if response := workflowRequest(http.MethodGet, path+"?check=1", owner+"-other", ""); workflowResponse(t, response).Code == 0 {
		t.Fatal("other owner accepted")
	}
	response := workflowRequest(http.MethodGet, path, owner, "")
	if response.Header().Get("Content-Type") != "application/zip" || !strings.Contains(response.Header().Get("Content-Disposition"), "attachment") {
		t.Fatalf("headers=%v body=%s", response.Header(), response.Body)
	}
	archive, err := zip.NewReader(bytes.NewReader(response.Body.Bytes()), int64(response.Body.Len()))
	if err != nil || len(archive.File) != 1 {
		t.Fatalf("zip=%v err=%v", archive, err)
	}
	r, _ := archive.File[0].Open()
	got, _ := io.ReadAll(r)
	r.Close()
	if !bytes.Equal(got, content) {
		t.Fatal("original image changed")
	}

	for _, values := range []map[string]any{
		{"owner_uid": owner + "-other"},
		{"owner_uid": owner, "cleanup_status": model.MediaCleanupDeleting},
		{"cleanup_status": "", "content_type": "video/mp4"},
	} {
		if err := db.Model(&model.Media{}).Where("id = ?", item.ID).Updates(values).Error; err != nil {
			t.Fatal(err)
		}
		if response := workflowRequest(http.MethodGet, path+"?check=1", owner, ""); workflowResponse(t, response).Code == 0 {
			t.Fatalf("invalid media accepted: %v", values)
		}
	}
	if err := db.Model(&model.Media{}).Where("id = ?", item.ID).Updates(map[string]any{"owner_uid": owner, "cleanup_status": "", "content_type": "image/png"}).Error; err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(mediaTestDirectory, key)); err != nil {
		t.Fatal(err)
	}
	if response := workflowRequest(http.MethodGet, path+"?check=1", owner, ""); workflowResponse(t, response).Code == 0 {
		t.Fatal("missing object accepted")
	}
}

func TestWorkflowDownloadStreamAbortReachesHTTPClient(t *testing.T) {
	api := New()
	api.GET("/stream-abort-test", func(c *gin.Context) {
		c.Header("Content-Type", "application/zip")
		c.Writer.WriteHeader(http.StatusOK)
		_, _ = c.Writer.Write([]byte("partial-zip"))
		c.Writer.Flush()
		panic(http.ErrAbortHandler)
	})
	server := httptest.NewServer(api)
	defer server.Close()
	response, err := http.Get(server.URL + "/stream-abort-test")
	if err != nil {
		return
	}
	defer response.Body.Close()
	if _, err := io.ReadAll(response.Body); err == nil {
		t.Fatal("truncated stream appeared successful")
	}
}
