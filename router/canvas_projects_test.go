package router

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"gorm.io/gorm"
)

func canvasRequest(t *testing.T, method, path, owner, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if owner != "" {
		req.Header.Set("X-Portal-User-Uid", owner)
	}
	response := httptest.NewRecorder()
	New().ServeHTTP(response, req)
	return response
}

func decodeCanvasResponse(t *testing.T, response *httptest.ResponseRecorder) struct {
	Code int             `json:"code"`
	Data json.RawMessage `json:"data"`
	Msg  string          `json:"msg"`
} {
	t.Helper()
	var payload struct {
		Code int             `json:"code"`
		Data json.RawMessage `json:"data"`
		Msg  string          `json:"msg"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response %q: %v", response.Body.String(), err)
	}
	return payload
}

func TestCanvasProjectRoutesRequirePortalIdentity(t *testing.T) {
	response := canvasRequest(t, http.MethodGet, "/api/v1/canvas/projects", "", "")
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated canvas list = %d/%s", response.Code, response.Body.String())
	}
}

func TestCanvasProjectOwnerCRUDSanitizesTransientImageContent(t *testing.T) {
	id := "canvas-crud-" + time.Now().Format("20060102150405.000000000")
	owner := "canvas-owner-" + id
	document := `{"nodes":[{"id":"image-1","type":"image","title":"图片","position":{"x":0,"y":0},"width":100,"height":80,"metadata":{"content":"blob:https://canvas.local/1","url":"blob:direct","previewUrl":"data:image/png;base64,preview","thumbnailUrl":"https://bucket.example/thumb.png?sig=secret","coverUrl":"https://cdn.example/stable-cover.png","references":["image:stable","blob:reference","data:image/png;base64,reference","https://bucket.example/ref.png?Expires=1","https://cdn.example/stable-reference.png"],"mediaId":"media-1","publicImageId":"public-image-1","mimeType":"image/png","bytes":12,"access":{"url":"https://bucket.example/image.png?X-Amz-Signature=secret","mediaId":"media-1"}}},{"id":"video-1","type":"video","title":"视频","position":{"x":10,"y":10},"width":120,"height":90,"metadata":{"content":"data:video/mp4;base64,abc","storageKey":"video:stable"}},{"id":"text-1","type":"text","title":"文本","position":{"x":20,"y":20},"width":100,"height":60,"metadata":{"content":"https://copy.example/text?X-Goog-Signature=keep-as-text"}},{"id":"config-1","type":"config","title":"配置","position":{"x":30,"y":30},"width":100,"height":60,"metadata":{"content":"data:image/png;base64,keep-as-config"}}],"connections":[{"id":"line-1","fromNodeId":"image-1","toNodeId":"text-1"}],"backgroundMode":"dots","showImageInfo":true,"viewport":{"x":5,"y":8,"k":1.5},"legacyPreview":"data:image/png;base64,keep-as-document-text"}`
	create := canvasRequest(t, http.MethodPost, "/api/v1/canvas/projects", owner, `{"id":"`+id+`","title":"  我的画布  ","createdAt":"2026-09-02T01:00:00Z","updatedAt":"2026-09-02T01:00:00Z","document":`+document+`}`)
	if create.Code != http.StatusOK {
		t.Fatalf("create canvas project = %d/%s", create.Code, create.Body.String())
	}
	created := decodeCanvasResponse(t, create)
	if created.Code != 0 {
		t.Fatalf("create payload = %s", create.Body.String())
	}
	var project struct {
		ID       string          `json:"id"`
		Title    string          `json:"title"`
		Revision int             `json:"revision"`
		Document json.RawMessage `json:"document"`
	}
	if err := json.Unmarshal(created.Data, &project); err != nil {
		t.Fatal(err)
	}
	if project.ID != id || project.Title != "我的画布" || project.Revision != 1 {
		t.Fatalf("created project = %#v", project)
	}
	assertCanvasDocumentSanitized(t, project.Document)

	list := canvasRequest(t, http.MethodGet, "/api/v1/canvas/projects", owner, "")
	var listData struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
		Total int `json:"total"`
	}
	if list.Code != http.StatusOK || json.Unmarshal(decodeCanvasResponse(t, list).Data, &listData) != nil || listData.Total != 1 || len(listData.Items) != 1 || listData.Items[0].ID != id {
		t.Fatalf("owner list = %d/%s", list.Code, list.Body.String())
	}

	other := canvasRequest(t, http.MethodGet, "/api/v1/canvas/projects/"+id, "another-owner", "")
	if other.Code != http.StatusOK || decodeCanvasResponse(t, other).Code != 1 {
		t.Fatalf("cross-owner get must be hidden = %d/%s", other.Code, other.Body.String())
	}

	update := canvasRequest(t, http.MethodPut, "/api/v1/canvas/projects/"+id, owner, `{"revision":1,"title":"更新后画布","document":{"nodes":[],"connections":[],"backgroundMode":"blank","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1}}}`)
	if update.Code != http.StatusOK {
		t.Fatalf("update canvas project = %d/%s", update.Code, update.Body.String())
	}
	if err := json.Unmarshal(decodeCanvasResponse(t, update).Data, &project); err != nil || project.Revision != 2 || project.Title != "更新后画布" {
		t.Fatalf("updated project = %s, err=%v", update.Body.String(), err)
	}

	deleted := canvasRequest(t, http.MethodDelete, "/api/v1/canvas/projects/"+id, owner, `{"revision":2}`)
	if deleted.Code != http.StatusOK || decodeCanvasResponse(t, deleted).Code != 0 {
		t.Fatalf("delete canvas project = %d/%s", deleted.Code, deleted.Body.String())
	}
	missing := canvasRequest(t, http.MethodGet, "/api/v1/canvas/projects/"+id, owner, "")
	if missing.Code != http.StatusOK || decodeCanvasResponse(t, missing).Code != 1 {
		t.Fatalf("deleted project lookup = %d/%s", missing.Code, missing.Body.String())
	}
}

func TestCanvasProjectImportIsIdempotentAndDoesNotOverwriteExistingProject(t *testing.T) {
	id := "canvas-import-" + time.Now().Format("20060102150405.000000000")
	owner := "canvas-import-owner-" + id
	body := `{"projects":[{"id":"` + id + `","title":"本地画布","createdAt":"2026-09-01T01:00:00Z","updatedAt":"2026-09-01T01:00:00Z","document":{"nodes":[],"connections":[],"backgroundMode":"lines","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1}}}]}`
	first := canvasRequest(t, http.MethodPost, "/api/v1/canvas/projects/import", owner, body)
	if first.Code != http.StatusOK || decodeCanvasResponse(t, first).Code != 0 {
		t.Fatalf("first import = %d/%s", first.Code, first.Body.String())
	}
	second := canvasRequest(t, http.MethodPost, "/api/v1/canvas/projects/import", owner, strings.Replace(body, "本地画布", "不应覆盖", 1))
	if second.Code != http.StatusOK || decodeCanvasResponse(t, second).Code != 0 {
		t.Fatalf("repeat import = %d/%s", second.Code, second.Body.String())
	}
	project := canvasRequest(t, http.MethodGet, "/api/v1/canvas/projects/"+id, owner, "")
	var got struct {
		Title    string `json:"title"`
		Revision int    `json:"revision"`
	}
	if err := json.Unmarshal(decodeCanvasResponse(t, project).Data, &got); err != nil || got.Title != "本地画布" || got.Revision != 1 {
		t.Fatalf("idempotent imported project = %d/%s, %#v, %v", project.Code, project.Body.String(), got, err)
	}
}

func TestCanvasProjectCreateAndDeleteAreIdempotentAfterAmbiguousResponses(t *testing.T) {
	id := "canvas-idempotent-" + time.Now().Format("20060102150405.000000000")
	owner := "canvas-idempotent-owner-" + id
	body := `{"id":"` + id + `","title":"首次创建","document":{"nodes":[],"connections":[],"backgroundMode":"lines","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1}}}`
	first := canvasRequest(t, http.MethodPost, "/api/v1/canvas/projects", owner, body)
	if first.Code != http.StatusOK || decodeCanvasResponse(t, first).Code != 0 {
		t.Fatalf("first create = %d/%s", first.Code, first.Body.String())
	}
	repeated := canvasRequest(t, http.MethodPost, "/api/v1/canvas/projects", owner, strings.Replace(body, "首次创建", "重试不得覆盖", 1))
	var existing struct {
		Title    string `json:"title"`
		Revision int    `json:"revision"`
	}
	if repeated.Code != http.StatusOK || json.Unmarshal(decodeCanvasResponse(t, repeated).Data, &existing) != nil || existing.Title != "首次创建" || existing.Revision != 1 {
		t.Fatalf("repeated create = %d/%s, decoded=%#v", repeated.Code, repeated.Body.String(), existing)
	}

	for attempt := 1; attempt <= 2; attempt++ {
		deleted := canvasRequest(t, http.MethodDelete, "/api/v1/canvas/projects/"+id, owner, `{"revision":1}`)
		if deleted.Code != http.StatusOK || decodeCanvasResponse(t, deleted).Code != 0 {
			t.Fatalf("delete attempt %d = %d/%s", attempt, deleted.Code, deleted.Body.String())
		}
	}
}

func TestCanvasProjectImportAllowsDifferentOwnersToUseTheSameClientID(t *testing.T) {
	id := "canvas-shared-" + time.Now().Format("20060102150405.000000000")
	firstOwner := "canvas-shared-first-" + id
	secondOwner := "canvas-shared-second-" + id
	first := `{"projects":[{"id":"` + id + `","title":"第一个用户画布","document":{"nodes":[],"connections":[],"backgroundMode":"lines","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1}}}]}`
	second := strings.Replace(first, "第一个用户画布", "第二个用户画布", 1)
	if response := canvasRequest(t, http.MethodPost, "/api/v1/canvas/projects/import", firstOwner, first); response.Code != http.StatusOK || decodeCanvasResponse(t, response).Code != 0 {
		t.Fatalf("first owner import = %d/%s", response.Code, response.Body.String())
	}
	if response := canvasRequest(t, http.MethodPost, "/api/v1/canvas/projects/import", secondOwner, second); response.Code != http.StatusOK || decodeCanvasResponse(t, response).Code != 0 {
		t.Fatalf("second owner import = %d/%s", response.Code, response.Body.String())
	}
	for _, check := range []struct {
		owner string
		title string
	}{{firstOwner, "第一个用户画布"}, {secondOwner, "第二个用户画布"}} {
		response := canvasRequest(t, http.MethodGet, "/api/v1/canvas/projects/"+id, check.owner, "")
		var project struct {
			Title string `json:"title"`
		}
		if response.Code != http.StatusOK || json.Unmarshal(decodeCanvasResponse(t, response).Data, &project) != nil || project.Title != check.title {
			t.Fatalf("owner-scoped shared ID lookup for %s = %d/%s", check.owner, response.Code, response.Body.String())
		}
	}
}

func TestCanvasProjectShareCopiesImageIntoRecipientLibrary(t *testing.T) {
	stamp := time.Now().Format("20060102150405.000000000")
	owner := "canvas-share-owner-" + stamp
	recipient := "f3dbfc1a-06c5-4d31-a0cc-62e9475e34f1"
	secondRecipient := "e3151d80-937a-4b20-85e4-4a17b4256f1c"
	mediaID := "media-share-source-" + stamp
	objectKey := "share-source/" + mediaID + ".png"
	if err := os.MkdirAll(filepath.Dir(filepath.Join(mediaTestDirectory, objectKey)), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(mediaTestDirectory, objectKey), []byte("source-image"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.SaveMedia(model.Media{ID: mediaID, OwnerUID: owner, Source: model.MediaSourceUpload, ObjectKey: objectKey, ContentType: "image/png", Bytes: 12, Filename: "source.png", Title: "源图片", CreatedAt: time.Now().UTC().Format(time.RFC3339Nano)}); err != nil {
		t.Fatal(err)
	}
	if err := repository.UpsertPortalMembers([]model.PortalMember{{UserUID: recipient, DisplayName: "接收成员", Enabled: true}, {UserUID: secondRecipient, DisplayName: "另一位接收成员", Enabled: true}}); err != nil {
		t.Fatal(err)
	}
	projectID := "canvas-share-" + stamp
	document := `{"nodes":[{"id":"image-1","type":"image","title":"源图片","position":{"x":0,"y":0},"width":100,"height":80,"metadata":{"mediaId":"` + mediaID + `","storageKey":"media:` + mediaID + `:v1:original"}},{"id":"image-2","type":"image","title":"重复引用","position":{"x":120,"y":0},"width":100,"height":80,"metadata":{"mediaId":"` + mediaID + `","storageKey":"media:` + mediaID + `:v1:original"}}],"connections":[],"backgroundMode":"lines","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1}}`
	if response := canvasRequest(t, http.MethodPost, "/api/v1/canvas/projects", owner, `{"id":"`+projectID+`","title":"分享测试","document":`+document+`}`); response.Code != http.StatusOK || decodeCanvasResponse(t, response).Code != 0 {
		t.Fatalf("create source project = %d/%s", response.Code, response.Body.String())
	}

	response := canvasRequest(t, http.MethodPost, "/api/v1/canvas/projects/"+projectID+"/share", owner, `{"revision":1,"recipientUserUids":["`+recipient+`","`+secondRecipient+`"]}`)
	if response.Code != http.StatusOK || decodeCanvasResponse(t, response).Code != 0 {
		t.Fatalf("share project = %d/%s", response.Code, response.Body.String())
	}
	var firstShare struct {
		Deliveries []struct {
			Status string `json:"status"`
		} `json:"deliveries"`
	}
	if err := json.Unmarshal(decodeCanvasResponse(t, response).Data, &firstShare); err != nil || len(firstShare.Deliveries) != 2 || firstShare.Deliveries[0].Status != "shared" || firstShare.Deliveries[1].Status != "shared" {
		t.Fatalf("first share deliveries = %#v, err=%v", firstShare.Deliveries, err)
	}
	if repeated := canvasRequest(t, http.MethodPost, "/api/v1/canvas/projects/"+projectID+"/share", owner, `{"revision":1,"recipientUserUids":["`+recipient+`","`+secondRecipient+`"]}`); repeated.Code != http.StatusOK || decodeCanvasResponse(t, repeated).Code != 0 {
		t.Fatalf("repeated share = %d/%s", repeated.Code, repeated.Body.String())
	}

	projects, err := repository.ListCanvasProjects(recipient)
	if err != nil || len(projects) != 1 {
		t.Fatalf("recipient projects = %#v, %v", projects, err)
	}
	secondProjects, err := repository.ListCanvasProjects(secondRecipient)
	if err != nil || len(secondProjects) != 1 {
		t.Fatalf("second recipient projects = %#v, %v", secondProjects, err)
	}
	var copied struct {
		Nodes []struct {
			Metadata struct {
				MediaID string `json:"mediaId"`
			} `json:"metadata"`
		} `json:"nodes"`
	}
	if err := json.Unmarshal(projects[0].Document, &copied); err != nil || len(copied.Nodes) != 2 || copied.Nodes[0].Metadata.MediaID == mediaID || copied.Nodes[0].Metadata.MediaID == "" || copied.Nodes[0].Metadata.MediaID != copied.Nodes[1].Metadata.MediaID {
		t.Fatalf("recipient document = %s, %v", projects[0].Document, err)
	}
	media, found, err := repository.GetMedia(copied.Nodes[0].Metadata.MediaID)
	if err != nil || !found || media.OwnerUID != recipient || media.ObjectKey == objectKey {
		t.Fatalf("recipient media = %#v, found=%t, err=%v", media, found, err)
	}
	content, err := os.ReadFile(filepath.Join(mediaTestDirectory, media.ObjectKey))
	if err != nil || string(content) != "source-image" {
		t.Fatalf("recipient object = %q, %v", content, err)
	}
}

func TestCanvasProjectShareRejectsVideos(t *testing.T) {
	stamp := time.Now().Format("20060102150405.000000000")
	owner := "canvas-share-video-owner-" + stamp
	projectID := "canvas-share-video-" + stamp
	recipient := "45b16146-f248-48b2-a0bb-b9017d1cb2b2"
	if err := repository.UpsertPortalMembers([]model.PortalMember{{UserUID: recipient, DisplayName: "接收成员", Enabled: true}}); err != nil {
		t.Fatal(err)
	}
	document := `{"nodes":[{"id":"video-1","type":"video","title":"视频","position":{"x":0,"y":0},"width":100,"height":80,"metadata":{"storageKey":"video:1"}}],"connections":[],"backgroundMode":"lines","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1}}`
	if response := canvasRequest(t, http.MethodPost, "/api/v1/canvas/projects", owner, `{"id":"`+projectID+`","title":"视频画布","document":`+document+`}`); response.Code != http.StatusOK || decodeCanvasResponse(t, response).Code != 0 {
		t.Fatalf("create video project = %d/%s", response.Code, response.Body.String())
	}
	response := canvasRequest(t, http.MethodPost, "/api/v1/canvas/projects/"+projectID+"/share", owner, `{"revision":1,"recipientUserUids":["`+recipient+`"]}`)
	if response.Code != http.StatusBadRequest || decodeCanvasResponse(t, response).Msg != "画布包含视频，暂不支持分享" {
		t.Fatalf("video share = %d/%s", response.Code, response.Body.String())
	}
}

func TestCanvasProjectShareRollsBackRecipientMediaAfterCopyFailure(t *testing.T) {
	stamp := time.Now().Format("20060102150405.000000000")
	owner := "canvas-share-rollback-owner-" + stamp
	recipient := "a35b1ca2-e8ba-47d8-95ba-9c32682e6b8e"
	firstMediaID := "media-share-rollback-first-" + stamp
	secondMediaID := "media-share-rollback-second-" + stamp
	firstKey := "share-rollback/" + firstMediaID + ".png"
	if err := os.MkdirAll(filepath.Dir(filepath.Join(mediaTestDirectory, firstKey)), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(mediaTestDirectory, firstKey), []byte("first-image"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, item := range []model.Media{
		{ID: firstMediaID, OwnerUID: owner, Source: model.MediaSourceUpload, ObjectKey: firstKey, ContentType: "image/png", Bytes: 11, Filename: "first.png", CreatedAt: time.Now().UTC().Format(time.RFC3339Nano)},
		{ID: secondMediaID, OwnerUID: owner, Source: model.MediaSourceUpload, ObjectKey: "share-rollback/missing.png", ContentType: "image/png", Bytes: 12, Filename: "second.png", CreatedAt: time.Now().UTC().Format(time.RFC3339Nano)},
	} {
		if _, err := repository.SaveMedia(item); err != nil {
			t.Fatal(err)
		}
	}
	if err := repository.UpsertPortalMembers([]model.PortalMember{{UserUID: recipient, DisplayName: "接收成员", Enabled: true}}); err != nil {
		t.Fatal(err)
	}
	projectID := "canvas-share-rollback-" + stamp
	document := `{"nodes":[{"id":"first","type":"image","title":"第一张","position":{"x":0,"y":0},"width":100,"height":80,"metadata":{"mediaId":"` + firstMediaID + `"}},{"id":"second","type":"image","title":"第二张","position":{"x":120,"y":0},"width":100,"height":80,"metadata":{"mediaId":"` + secondMediaID + `"}}],"connections":[],"backgroundMode":"lines","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1}}`
	if response := canvasRequest(t, http.MethodPost, "/api/v1/canvas/projects", owner, `{"id":"`+projectID+`","title":"回滚测试","document":`+document+`}`); response.Code != http.StatusOK || decodeCanvasResponse(t, response).Code != 0 {
		t.Fatalf("create rollback project = %d/%s", response.Code, response.Body.String())
	}
	response := canvasRequest(t, http.MethodPost, "/api/v1/canvas/projects/"+projectID+"/share", owner, `{"revision":1,"recipientUserUids":["`+recipient+`"]}`)
	if response.Code != http.StatusOK || decodeCanvasResponse(t, response).Code != 0 {
		t.Fatalf("rollback share response = %d/%s", response.Code, response.Body.String())
	}
	projects, err := repository.ListCanvasProjects(recipient)
	if err != nil || len(projects) != 0 {
		t.Fatalf("failed share left projects = %#v, %v", projects, err)
	}
	media, err := repository.ListPrivateMedia(recipient)
	if err != nil || len(media) != 0 {
		t.Fatalf("failed share left media rows = %#v, %v", media, err)
	}
	recipientRoot := filepath.Join(mediaTestDirectory, "images", "private", "library", recipient)
	objectPaths := make([]string, 0)
	if err := filepath.WalkDir(recipientRoot, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if !entry.IsDir() {
			objectPaths = append(objectPaths, path)
		}
		return nil
	}); err != nil && !os.IsNotExist(err) {
		t.Fatalf("failed share recipient object walk = %v", err)
	} else if len(objectPaths) != 0 {
		t.Fatalf("failed share left recipient objects = %#v", objectPaths)
	}
}

func TestCanvasProjectShareCopiesPublicImageIntoRecipientLibrary(t *testing.T) {
	stamp := time.Now().Format("20060102150405.000000000")
	owner := "canvas-share-public-owner-" + stamp
	recipient := "5919bfb6-d177-4fed-ad97-4bf1f8d2a97d"
	mediaID := "media-share-public-" + stamp
	objectKey := "share-public/" + mediaID + ".png"
	if err := os.MkdirAll(filepath.Dir(filepath.Join(mediaTestDirectory, objectKey)), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(mediaTestDirectory, objectKey), []byte("public-image"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.SaveMedia(model.Media{ID: mediaID, OwnerUID: "public-owner", Source: model.MediaSourceUpload, ObjectKey: objectKey, ContentType: "image/png", Bytes: 12, Filename: "public.png", Title: "公共图片", CreatedAt: time.Now().UTC().Format(time.RFC3339Nano)}); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.SavePublicImage(model.PublicImage{ID: "public-share-" + stamp, MediaID: mediaID, Title: "公共图片", UploaderUID: "public-owner", CreatedAt: time.Now().UTC().Format(time.RFC3339Nano)}); err != nil {
		t.Fatal(err)
	}
	if err := repository.UpsertPortalMembers([]model.PortalMember{{UserUID: recipient, DisplayName: "接收成员", Enabled: true}}); err != nil {
		t.Fatal(err)
	}
	projectID := "canvas-share-public-" + stamp
	document := `{"nodes":[{"id":"public-image","type":"image","title":"公共图片","position":{"x":0,"y":0},"width":100,"height":80,"metadata":{"mediaId":"` + mediaID + `"}}],"connections":[],"backgroundMode":"lines","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1}}`
	if response := canvasRequest(t, http.MethodPost, "/api/v1/canvas/projects", owner, `{"id":"`+projectID+`","title":"公共图片分享","document":`+document+`}`); response.Code != http.StatusOK || decodeCanvasResponse(t, response).Code != 0 {
		t.Fatalf("create public source project = %d/%s", response.Code, response.Body.String())
	}
	if response := canvasRequest(t, http.MethodPost, "/api/v1/canvas/projects/"+projectID+"/share", owner, `{"revision":1,"recipientUserUids":["`+recipient+`"]}`); response.Code != http.StatusOK || decodeCanvasResponse(t, response).Code != 0 {
		t.Fatalf("share public source project = %d/%s", response.Code, response.Body.String())
	}
	projects, err := repository.ListCanvasProjects(recipient)
	if err != nil || len(projects) != 1 {
		t.Fatalf("public recipient projects = %#v, %v", projects, err)
	}
	var copied struct {
		Nodes []struct {
			Metadata struct {
				MediaID string `json:"mediaId"`
			} `json:"metadata"`
		} `json:"nodes"`
	}
	if err := json.Unmarshal(projects[0].Document, &copied); err != nil || len(copied.Nodes) != 1 || copied.Nodes[0].Metadata.MediaID == mediaID {
		t.Fatalf("public recipient document = %s, %v", projects[0].Document, err)
	}
	media, found, err := repository.GetMedia(copied.Nodes[0].Metadata.MediaID)
	if err != nil || !found || media.OwnerUID != recipient || media.Source != model.MediaSourceUpload {
		t.Fatalf("public recipient media = %#v, found=%t, err=%v", media, found, err)
	}
}

func TestCanvasShareRecipientsOnlyListsOtherEnabledMembersWithDepartments(t *testing.T) {
	stamp := time.Now().Format("20060102150405.000000000")
	owner := "canvas-share-members-owner-" + stamp
	enabled := "6315d7db-5f11-45f7-8728-f2c5825ee573"
	disabled := "d6d09b8e-f737-42d4-96a4-d99e5d722848"
	if err := repository.UpsertPortalMembers([]model.PortalMember{
		{UserUID: owner, DisplayName: "分享者", Enabled: true, Departments: []string{"产品"}},
		{UserUID: enabled, DisplayName: "可选成员", Enabled: true, Departments: []string{"设计", "增长"}},
		{UserUID: disabled, DisplayName: "停用成员", Enabled: false, Departments: []string{"研发"}},
	}); err != nil {
		t.Fatal(err)
	}
	response := canvasRequest(t, http.MethodGet, "/api/v1/canvas/share-recipients?query=可选", owner, "")
	if response.Code != http.StatusOK || decodeCanvasResponse(t, response).Code != 0 {
		t.Fatalf("share recipients = %d/%s", response.Code, response.Body.String())
	}
	var list struct {
		Items []struct {
			UserUID     string   `json:"userUid"`
			DisplayName string   `json:"displayName"`
			Departments []string `json:"departments"`
		} `json:"items"`
		Total int `json:"total"`
	}
	if err := json.Unmarshal(decodeCanvasResponse(t, response).Data, &list); err != nil || list.Total != 1 || len(list.Items) != 1 || list.Items[0].UserUID != enabled || list.Items[0].DisplayName != "可选成员" || strings.Join(list.Items[0].Departments, ",") != "设计,增长" {
		t.Fatalf("share recipients response = %#v, err=%v", list, err)
	}
}

func TestCanvasProjectImportRejectsAnInvalidBatchWithoutSavingEarlierProjects(t *testing.T) {
	owner := "canvas-import-invalid-" + time.Now().Format("20060102150405.000000000")
	validID := "canvas-import-valid-" + owner
	batch := `{"projects":[{"id":"` + validID + `","title":"有效画布","document":{"nodes":[],"connections":[],"backgroundMode":"lines","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1}}},{"id":"canvas-import-invalid","title":" ","document":{}}]}`
	response := canvasRequest(t, http.MethodPost, "/api/v1/canvas/projects/import", owner, batch)
	if response.Code != http.StatusBadRequest || decodeCanvasResponse(t, response).Code != 1 {
		t.Fatalf("invalid import batch = %d/%s", response.Code, response.Body.String())
	}
	lookup := canvasRequest(t, http.MethodGet, "/api/v1/canvas/projects/"+validID, owner, "")
	if lookup.Code != http.StatusOK || decodeCanvasResponse(t, lookup).Code != 1 {
		t.Fatalf("invalid import must not save preceding project = %d/%s", lookup.Code, lookup.Body.String())
	}
}

func TestCanvasProjectRejectsInvalidPayloadsAndStaleRevisions(t *testing.T) {
	id := "canvas-conflict-" + time.Now().Format("20060102150405.000000000")
	owner := "canvas-conflict-owner-" + id
	invalid := canvasRequest(t, http.MethodPost, "/api/v1/canvas/projects", owner, `{"id":"bad","title":" ","document":{}}`)
	if invalid.Code != http.StatusBadRequest || decodeCanvasResponse(t, invalid).Code != 1 {
		t.Fatalf("invalid canvas payload = %d/%s", invalid.Code, invalid.Body.String())
	}
	create := canvasRequest(t, http.MethodPost, "/api/v1/canvas/projects", owner, `{"id":"`+id+`","title":"冲突画布","document":{"nodes":[],"connections":[],"backgroundMode":"lines","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1}}}`)
	if create.Code != http.StatusOK {
		t.Fatal(create.Body.String())
	}
	freshUpdate := canvasRequest(t, http.MethodPut, "/api/v1/canvas/projects/"+id, owner, `{"revision":1,"title":"服务器版本","document":{"nodes":[{"id":"server-node","type":"text","title":"服务器节点","position":{"x":0,"y":0},"width":100,"height":80}],"connections":[],"backgroundMode":"lines","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1}}}`)
	if freshUpdate.Code != http.StatusOK || decodeCanvasResponse(t, freshUpdate).Code != 0 {
		t.Fatalf("fresh update = %d/%s", freshUpdate.Code, freshUpdate.Body.String())
	}
	staleUpdate := canvasRequest(t, http.MethodPut, "/api/v1/canvas/projects/"+id, owner, `{"revision":1,"title":"不应保存","document":{"nodes":[{"id":"stale-node","type":"text","title":"过期节点","position":{"x":0,"y":0},"width":100,"height":80}],"connections":[],"backgroundMode":"blank","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1}}}`)
	if staleUpdate.Code != http.StatusConflict || decodeCanvasResponse(t, staleUpdate).Code != 1 {
		t.Fatalf("stale update = %d/%s", staleUpdate.Code, staleUpdate.Body.String())
	}
	staleDelete := canvasRequest(t, http.MethodDelete, "/api/v1/canvas/projects/"+id, owner, `{"revision":1}`)
	if staleDelete.Code != http.StatusConflict || decodeCanvasResponse(t, staleDelete).Code != 1 {
		t.Fatalf("stale delete = %d/%s", staleDelete.Code, staleDelete.Body.String())
	}
	current := canvasRequest(t, http.MethodGet, "/api/v1/canvas/projects/"+id, owner, "")
	var project struct {
		Title    string          `json:"title"`
		Revision int             `json:"revision"`
		Document json.RawMessage `json:"document"`
	}
	if current.Code != http.StatusOK || json.Unmarshal(decodeCanvasResponse(t, current).Data, &project) != nil || project.Title != "服务器版本" || project.Revision != 2 || !bytes.Contains(project.Document, []byte("server-node")) || bytes.Contains(project.Document, []byte("stale-node")) {
		t.Fatalf("stale writes changed server snapshot = %d/%s", current.Code, current.Body.String())
	}
}

func TestCanvasProjectExplainsWhenDocumentExceedsSaveLimit(t *testing.T) {
	owner := "canvas-limit-owner-" + time.Now().Format("20060102150405.000000000")
	document := fmt.Sprintf(`{"nodes":[{"id":"large-text","type":"text","title":"large","position":{"x":0,"y":0},"width":100,"height":80,"metadata":{"content":"%s"}}],"connections":[],"backgroundMode":"lines","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1}}`, strings.Repeat("x", 4<<20))
	response := canvasRequest(t, http.MethodPost, "/api/v1/canvas/projects", owner, `{"id":"oversized-canvas","title":"oversized","document":`+document+`}`)
	payload := decodeCanvasResponse(t, response)

	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized document status = %d/%s", response.Code, response.Body.String())
	}
	if payload.Msg != "画板数据超过保存上限（4MB）" {
		t.Fatalf("oversized document message = %q", payload.Msg)
	}
}

func TestCanvasProjectRejectsUnsafeIDsAndDocumentsTheFrontendCannotLoad(t *testing.T) {
	owner := "canvas-validation-owner-" + time.Now().Format("20060102150405.000000000")
	validDocument := `{"nodes":[],"connections":[],"backgroundMode":"lines","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1}}`
	unsafeID := canvasRequest(t, http.MethodPost, "/api/v1/canvas/projects", owner, `{"id":"unsafe/id","title":"非法 ID","document":`+validDocument+`}`)
	if unsafeID.Code != http.StatusBadRequest || decodeCanvasResponse(t, unsafeID).Code != 1 {
		t.Fatalf("unsafe create ID = %d/%s", unsafeID.Code, unsafeID.Body.String())
	}
	unsafePath := canvasRequest(t, http.MethodGet, "/api/v1/canvas/projects/unsafe%20id", owner, "")
	if unsafePath.Code != http.StatusBadRequest || decodeCanvasResponse(t, unsafePath).Code != 1 {
		t.Fatalf("unsafe path ID = %d/%s", unsafePath.Code, unsafePath.Body.String())
	}

	invalidDocuments := []struct {
		name     string
		document string
	}{
		{name: "missing required document fields", document: `{}`},
		{name: "nodes must be an array", document: `{"nodes":{},"connections":[],"backgroundMode":"lines","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1}}`},
		{name: "node minimum fields", document: `{"nodes":[{"id":"node-only"}],"connections":[],"backgroundMode":"lines","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1}}`},
		{name: "connection minimum fields", document: `{"nodes":[],"connections":[{"id":"connection-only"}],"backgroundMode":"lines","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1}}`},
		{name: "viewport numeric fields", document: `{"nodes":[],"connections":[],"backgroundMode":"lines","showImageInfo":false,"viewport":{"x":0,"y":0}}`},
		{name: "supported background mode", document: `{"nodes":[],"connections":[],"backgroundMode":"rainbow","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1}}`},
		{name: "show image info boolean", document: `{"nodes":[],"connections":[],"backgroundMode":"lines","showImageInfo":"false","viewport":{"x":0,"y":0,"k":1}}`},
	}
	for index, test := range invalidDocuments {
		t.Run(test.name, func(t *testing.T) {
			id := fmt.Sprintf("invalid-document-%d-%d", time.Now().UnixNano(), index)
			response := canvasRequest(t, http.MethodPost, "/api/v1/canvas/projects", owner, `{"id":"`+id+`","title":"非法文档","document":`+test.document+`}`)
			if response.Code != http.StatusBadRequest || decodeCanvasResponse(t, response).Code != 1 {
				t.Fatalf("invalid document accepted = %d/%s", response.Code, response.Body.String())
			}
		})
	}
}

func TestCanvasProjectRejectsDotPathSegmentsAcrossCRUD(t *testing.T) {
	owner := "canvas-dot-id-owner-" + time.Now().Format("20060102150405.000000000")
	validDocument := `{"nodes":[],"connections":[],"backgroundMode":"lines","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1}}`

	for _, id := range []string{".", ".."} {
		t.Run(id, func(t *testing.T) {
			create := canvasRequest(t, http.MethodPost, "/api/v1/canvas/projects", owner, `{"id":"`+id+`","title":"非法路径段","document":`+validDocument+`}`)
			if create.Code != http.StatusBadRequest || decodeCanvasResponse(t, create).Code != 1 {
				t.Errorf("dot segment create = %d/%s", create.Code, create.Body.String())
			}

			for _, method := range []string{http.MethodGet, http.MethodPut, http.MethodDelete} {
				pathID := "%2E"
				if id == ".." {
					pathID = "%2E%2E"
				}
				body := ""
				if method == http.MethodPut {
					body = `{"revision":1,"title":"非法路径段","document":` + validDocument + `}`
				}
				if method == http.MethodDelete {
					body = `{"revision":1}`
				}
				response := canvasRequest(t, method, "/api/v1/canvas/projects/"+pathID, owner, body)
				if response.Code != http.StatusBadRequest || decodeCanvasResponse(t, response).Code != 1 {
					t.Fatalf("dot segment %s = %d/%s", method, response.Code, response.Body.String())
				}
			}
		})
	}
}

func TestCanvasProjectUpdateReturnsTheExactSnapshotAcceptedBeforeALaterWriter(t *testing.T) {
	id := "canvas-interleaved-" + time.Now().Format("20060102150405.000000000")
	owner := "canvas-interleaved-owner-" + id
	create := canvasRequest(t, http.MethodPost, "/api/v1/canvas/projects", owner, `{"id":"`+id+`","title":"初始版本","document":{"nodes":[],"connections":[],"backgroundMode":"lines","showImageInfo":false,"viewport":{"x":0,"y":0,"k":1}}}`)
	if create.Code != http.StatusOK || decodeCanvasResponse(t, create).Code != 0 {
		t.Fatalf("create canvas project = %d/%s", create.Code, create.Body.String())
	}

	database, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	previousSkipDefaultTransaction := database.Config.SkipDefaultTransaction
	database.Config.SkipDefaultTransaction = true
	callbackName := "test:block-first-canvas-update-return"
	firstWriteApplied := make(chan struct{})
	releaseFirstWriter := make(chan struct{})
	var updateCount atomic.Int32
	if err := database.Callback().Update().After("gorm:update").Register(callbackName, func(tx *gorm.DB) {
		if tx.Statement.Table != "canvas_projects" || updateCount.Add(1) != 1 {
			return
		}
		close(firstWriteApplied)
		<-releaseFirstWriter
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		database.Config.SkipDefaultTransaction = previousSkipDefaultTransaction
		_ = database.Callback().Update().Remove(callbackName)
	})

	firstResponse := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		firstResponse <- canvasRequest(t, http.MethodPut, "/api/v1/canvas/projects/"+id, owner, `{"revision":1,"title":"第一个写入","document":{"nodes":[],"connections":[],"backgroundMode":"dots","showImageInfo":false,"viewport":{"x":1,"y":2,"k":1}}}`)
	}()
	select {
	case <-firstWriteApplied:
	case <-time.After(2 * time.Second):
		close(releaseFirstWriter)
		t.Fatal("first conditional update did not reach the synchronization point")
	}

	second := canvasRequest(t, http.MethodPut, "/api/v1/canvas/projects/"+id, owner, `{"revision":2,"title":"第二个写入","document":{"nodes":[],"connections":[],"backgroundMode":"blank","showImageInfo":true,"viewport":{"x":3,"y":4,"k":2}}}`)
	if second.Code != http.StatusOK || decodeCanvasResponse(t, second).Code != 0 {
		close(releaseFirstWriter)
		t.Fatalf("second update = %d/%s", second.Code, second.Body.String())
	}
	close(releaseFirstWriter)

	first := <-firstResponse
	var accepted struct {
		Title    string          `json:"title"`
		Revision int             `json:"revision"`
		Document json.RawMessage `json:"document"`
	}
	if err := json.Unmarshal(decodeCanvasResponse(t, first).Data, &accepted); err != nil {
		t.Fatal(err)
	}
	if accepted.Title != "第一个写入" || accepted.Revision != 2 || !bytes.Contains(accepted.Document, []byte(`"backgroundMode":"dots"`)) {
		t.Fatalf("first response exposed a later writer snapshot: %#v, document=%s", accepted, accepted.Document)
	}
}

func assertCanvasDocumentSanitized(t *testing.T, document json.RawMessage) {
	t.Helper()
	var decoded struct {
		Nodes []struct {
			ID       string         `json:"id"`
			Metadata map[string]any `json:"metadata"`
		} `json:"nodes"`
		LegacyPreview string `json:"legacyPreview"`
	}
	if err := json.Unmarshal(document, &decoded); err != nil {
		t.Fatal(err)
	}
	metadata := make(map[string]map[string]any, len(decoded.Nodes))
	for _, node := range decoded.Nodes {
		metadata[node.ID] = node.Metadata
	}
	if _, exists := metadata["image-1"]["content"]; exists {
		t.Fatalf("stored image node kept blob preview: %s", document)
	}
	if _, exists := metadata["video-1"]["content"]; exists {
		t.Fatalf("stored video node kept data preview: %s", document)
	}
	if access, ok := metadata["image-1"]["access"].(map[string]any); !ok || access["url"] != nil || access["mediaId"] != "media-1" {
		t.Fatalf("stored image access was not selectively sanitized: %#v", metadata["image-1"]["access"])
	}
	if metadata["image-1"]["url"] != nil || metadata["image-1"]["previewUrl"] != nil || metadata["image-1"]["thumbnailUrl"] != nil || metadata["image-1"]["coverUrl"] != "https://cdn.example/stable-cover.png" {
		t.Fatalf("stored image preview fields were not selectively sanitized: %#v", metadata["image-1"])
	}
	if references, ok := metadata["image-1"]["references"].([]any); !ok || len(references) != 2 || references[0] != "image:stable" || references[1] != "https://cdn.example/stable-reference.png" {
		t.Fatalf("stored image references were not selectively sanitized: %#v", metadata["image-1"]["references"])
	}
	if metadata["text-1"]["content"] != "https://copy.example/text?X-Goog-Signature=keep-as-text" || metadata["config-1"]["content"] != "data:image/png;base64,keep-as-config" {
		t.Fatalf("stored document lost text/config content: %s", document)
	}
	if decoded.LegacyPreview != "data:image/png;base64,keep-as-document-text" {
		t.Fatalf("stored document lost non-media text field: %s", document)
	}
	for _, required := range []string{"media-1", "public-image-1", "image/png", "line-1", "dots"} {
		if !bytes.Contains(document, []byte(required)) {
			t.Fatalf("stored document lost stable canvas state %q: %s", required, document)
		}
	}
}
