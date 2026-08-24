package router

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	_ "github.com/basketikun/infinite-canvas/ai/providers"
	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/basketikun/infinite-canvas/service"
)

var mediaTestDirectory string

func TestMain(m *testing.M) {
	directory, err := os.MkdirTemp("", "infinite-canvas-router-test-")
	if err != nil {
		panic(err)
	}
	mediaTestDirectory = directory
	config.Cfg = config.Config{
		StorageDriver:   "sqlite",
		DatabaseDSN:     filepath.Join(directory, "canvas.db"),
		PortalAdminRole: "portal-admin",
		MediaStorage:    "local",
		MediaLocalDir:   directory,
	}
	code := m.Run()
	_ = os.RemoveAll(directory)
	os.Exit(code)
}

func TestPrivateMediaDeleteRouteIsProtected(t *testing.T) {
	found := false
	for _, route := range New().Routes() {
		if route.Method == "DELETE" && route.Path == "/api/v1/media/:id" {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("private media delete route must be registered under /api/v1")
	}
}

func TestImageGenerationCreatesPersistentTaskWithoutForwardingModel(t *testing.T) {
	if _, err := service.SaveSettings(model.Settings{AI: model.AISettings{
		Providers:       []model.AIProvider{{ID: "async-maizi", Name: "Maizi", Type: "maizi-image", Enabled: true, Config: json.RawMessage(`{"apiKey":"test-key","model":"gpt-image-2"}`)}},
		ImageProviderID: "async-maizi",
	}}); err != nil {
		t.Fatal(err)
	}
	clientRequestID := "async-create-" + time.Now().Format("20060102150405.000000000")
	request := httptest.NewRequest(http.MethodPost, "/api/v1/images/generations", bytes.NewBufferString(`{"clientRequestId":"`+clientRequestID+`","model":"browser-controlled-model","prompt":"生成一张测试图","n":1,"size":"1:1","resolution":"1k"}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Portal-User-Uid", "async-owner")
	response := httptest.NewRecorder()
	New().ServeHTTP(response, request)

	var created struct {
		Code int `json:"code"`
		Data struct {
			ID              string `json:"id"`
			ClientRequestID string `json:"clientRequestId"`
			Status          string `json:"status"`
		} `json:"data"`
	}
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &created) != nil || created.Code != 0 || created.Data.ID == "" || created.Data.ClientRequestID != clientRequestID || created.Data.Status != "queued" {
		t.Fatalf("create image task = %d/%s", response.Code, response.Body.String())
	}

	lookup := httptest.NewRequest(http.MethodGet, "/api/v1/images/tasks/by-client-request/"+clientRequestID, nil)
	lookup.Header.Set("X-Portal-User-Uid", "async-owner")
	lookedUp := httptest.NewRecorder()
	New().ServeHTTP(lookedUp, lookup)
	if lookedUp.Code != http.StatusOK || !strings.Contains(lookedUp.Body.String(), `"id":"`+created.Data.ID+`"`) {
		t.Fatalf("lookup image task = %d/%s", lookedUp.Code, lookedUp.Body.String())
	}
}

func TestPrivateImageCatalogRestoresOwnedMediaAndExcludesPublicMedia(t *testing.T) {
	createdAt := time.Now().Format(time.RFC3339Nano)
	owned := model.Media{ID: "media-private-catalog-owned", OwnerUID: "catalog-owner", Source: model.MediaSourceUpload, ObjectKey: "images/private/catalog-owner/owned.png", ContentType: "image/png", Filename: "恢复素材.png", CreatedAt: createdAt}
	generated := model.Media{ID: "media-private-catalog-generated", OwnerUID: "catalog-owner", Source: model.MediaSourceGenerated, ObjectKey: "images/private/catalog-owner/generated.png", ContentType: "image/png", Filename: "generated.png", CreatedAt: createdAt}
	otherUser := model.Media{ID: "media-private-catalog-other", OwnerUID: "catalog-other", Source: model.MediaSourceUpload, ObjectKey: "images/private/catalog-other/other.png", ContentType: "image/png", Filename: "other.png", CreatedAt: createdAt}
	publicMedia := model.Media{ID: "media-private-catalog-public", OwnerUID: "catalog-owner", Source: model.MediaSourceUpload, ObjectKey: "images/public/catalog-owner/public.png", ContentType: "image/png", Filename: "public.png", CreatedAt: createdAt}
	for _, item := range []model.Media{owned, generated, otherUser, publicMedia} {
		if _, err := repository.SaveMedia(item); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := repository.SavePublicImage(model.PublicImage{ID: "public-private-catalog", MediaID: publicMedia.ID, UploaderUID: publicMedia.OwnerUID, Title: "公共图片", CreatedAt: createdAt}); err != nil {
		t.Fatal(err)
	}

	request := httptest.NewRequest(http.MethodGet, "/api/v1/private-images", nil)
	request.Header.Set("X-Portal-User-Uid", owned.OwnerUID)
	response := httptest.NewRecorder()
	New().ServeHTTP(response, request)

	var payload struct {
		Code int `json:"code"`
		Data struct {
			Items []model.Media `json:"items"`
		} `json:"data"`
	}
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &payload) != nil || payload.Code != 0 {
		t.Fatalf("catalog status/body = %d/%s", response.Code, response.Body.String())
	}
	if len(payload.Data.Items) != 2 {
		t.Fatalf("private catalog items = %+v, want owned upload and generated media", payload.Data.Items)
	}
	seen := map[string]bool{}
	for _, item := range payload.Data.Items {
		seen[item.ID] = true
	}
	if !seen[owned.ID] || !seen[generated.ID] || seen[otherUser.ID] || seen[publicMedia.ID] {
		t.Fatalf("catalog ownership/public filtering = %+v", seen)
	}
}

func TestPrivateImageCatalogPersistsFolderMoveAndRenamePerOwner(t *testing.T) {
	owner := "private-catalog-editor"
	item := model.Media{ID: "media-private-catalog-edit", OwnerUID: owner, Source: model.MediaSourceUpload, ObjectKey: "images/private/private-catalog-editor/edit.png", ContentType: "image/png", Filename: "edit.png", CreatedAt: time.Now().Format(time.RFC3339Nano)}
	if _, err := repository.SaveMedia(item); err != nil {
		t.Fatal(err)
	}

	create := httptest.NewRequest(http.MethodPost, "/api/v1/private-folders", bytes.NewBufferString(`{"title":"项目图"}`))
	create.Header.Set("Content-Type", "application/json")
	create.Header.Set("X-Portal-User-Uid", owner)
	created := httptest.NewRecorder()
	New().ServeHTTP(created, create)
	var folderPayload struct {
		Data model.PrivateFolder `json:"data"`
	}
	if created.Code != http.StatusOK || json.Unmarshal(created.Body.Bytes(), &folderPayload) != nil || folderPayload.Data.ID == "" {
		t.Fatalf("create private folder = %d/%s", created.Code, created.Body.String())
	}

	update := httptest.NewRequest(http.MethodPatch, "/api/v1/private-images/"+item.ID, bytes.NewBufferString(`{"title":"最终主图","folderId":"`+folderPayload.Data.ID+`"}`))
	update.Header.Set("Content-Type", "application/json")
	update.Header.Set("X-Portal-User-Uid", owner)
	updated := httptest.NewRecorder()
	New().ServeHTTP(updated, update)
	if updated.Code != http.StatusOK {
		t.Fatalf("update private image = %d/%s", updated.Code, updated.Body.String())
	}

	list := httptest.NewRequest(http.MethodGet, "/api/v1/private-images", nil)
	list.Header.Set("X-Portal-User-Uid", owner)
	listed := httptest.NewRecorder()
	New().ServeHTTP(listed, list)
	var imagePayload struct {
		Data model.PrivateImageList `json:"data"`
	}
	if listed.Code != http.StatusOK || json.Unmarshal(listed.Body.Bytes(), &imagePayload) != nil {
		t.Fatalf("list private images = %d/%s", listed.Code, listed.Body.String())
	}
	for _, candidate := range imagePayload.Data.Items {
		if candidate.ID == item.ID {
			if candidate.Title != "最终主图" || candidate.FolderID != folderPayload.Data.ID {
				t.Fatalf("persisted private image = %+v", candidate)
			}
			return
		}
	}
	t.Fatalf("updated image %q missing from private catalog", item.ID)
}

func TestOperationLogRouteIsAdminOnly(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/api/admin/operation-logs", nil)
	request.Header.Set("X-Portal-User-Uid", "member")
	response := httptest.NewRecorder()
	New().ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("non-admin status = %d, want %d; body = %s", response.Code, http.StatusForbidden, response.Body.String())
	}

	request.Header.Set("X-Portal-Roles", "portal-admin")
	response = httptest.NewRecorder()
	New().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("admin status = %d, want %d; body = %s", response.Code, http.StatusOK, response.Body.String())
	}
}

func TestPortalMemberListRouteIsAdminOnlyAndReturnsSynchronizedMembers(t *testing.T) {
	memberID := "member-list-" + time.Now().Format("20060102150405.000000000")
	if err := repository.UpsertPortalMembers([]model.PortalMember{{
		UserUID:     memberID,
		DisplayName: "成员列表测试",
		Enabled:     true,
		Roles:       []string{"设计师"},
		SyncedAt:    time.Now().UTC(),
	}}); err != nil {
		t.Fatal(err)
	}

	denied := httptest.NewRequest(http.MethodGet, "/api/admin/members", nil)
	denied.Header.Set("X-Portal-User-Uid", "ordinary-member")
	deniedResponse := httptest.NewRecorder()
	New().ServeHTTP(deniedResponse, denied)
	if deniedResponse.Code != http.StatusForbidden {
		t.Fatalf("non-admin members status = %d, want %d; body = %s", deniedResponse.Code, http.StatusForbidden, deniedResponse.Body.String())
	}

	request := httptest.NewRequest(http.MethodGet, "/api/admin/members?query=%E6%88%90%E5%91%98", nil)
	request.Header.Set("X-Portal-User-Uid", "member-list-admin")
	request.Header.Set("X-Portal-Roles", "portal-admin")
	response := httptest.NewRecorder()
	New().ServeHTTP(response, request)
	var payload struct {
		Code int `json:"code"`
		Data struct {
			Items []model.PortalMember `json:"items"`
			Total int                  `json:"total"`
		} `json:"data"`
	}
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &payload) != nil || payload.Code != 0 || payload.Data.Total == 0 {
		t.Fatalf("member list status/body = %d/%s", response.Code, response.Body.String())
	}
	for _, item := range payload.Data.Items {
		if item.UserUID == memberID && item.DisplayName == "成员列表测试" {
			return
		}
	}
	t.Fatalf("member %q missing from list: %+v", memberID, payload.Data.Items)
}

func TestPortalDirectoryCallbackSynchronizesAndDisablesMember(t *testing.T) {
	const userUID = "2b5892c4-3dd2-4f82-8644-f0d14a0b5e71"
	users := []string{`{"userUid":"` + userUID + `","displayName":"李小明","enabled":true,"roles":["设计师"]}`}
	directory := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Portal-Service-Key") != "infinite-canvas" || r.Header.Get("X-Portal-Service-Secret") != "directory-secret" {
			t.Fatalf("directory headers = %q/%q", r.Header.Get("X-Portal-Service-Key"), r.Header.Get("X-Portal-Service-Secret"))
		}
		_, _ = w.Write([]byte(`{"users":[` + strings.Join(users, ",") + `]}`))
	}))
	defer directory.Close()
	previous := config.Cfg
	config.Cfg.PortalDirectoryURL = directory.URL
	config.Cfg.PortalDirectoryAppKey = "infinite-canvas"
	config.Cfg.PortalDirectorySecret = "directory-secret"
	t.Cleanup(func() { config.Cfg = previous })

	denied := httptest.NewRequest(http.MethodPost, "/internal/portal/directory-sync", bytes.NewBufferString(`{"userUid":"`+userUID+`"}`))
	denied.Header.Set("Content-Type", "application/json")
	denied.Header.Set("X-Portal-Service-Key", "infinite-canvas")
	denied.Header.Set("X-Portal-Service-Secret", "wrong-secret")
	deniedResponse := httptest.NewRecorder()
	New().ServeHTTP(deniedResponse, denied)
	if deniedResponse.Code != http.StatusUnauthorized {
		t.Fatalf("wrong-secret status = %d, want %d", deniedResponse.Code, http.StatusUnauthorized)
	}

	request := httptest.NewRequest(http.MethodPost, "/internal/portal/directory-sync", bytes.NewBufferString(`{"userUid":"`+userUID+`"}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Portal-Service-Key", "infinite-canvas")
	request.Header.Set("X-Portal-Service-Secret", "directory-secret")
	response := httptest.NewRecorder()
	New().ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("callback status = %d, want %d", response.Code, http.StatusNoContent)
	}
	member, found, err := repository.GetPortalMember(userUID)
	if err != nil || !found || !member.Enabled || member.DisplayName != "李小明" {
		t.Fatalf("synchronized member = %+v, found=%t, err=%v", member, found, err)
	}

	manual := httptest.NewRequest(http.MethodPost, "/api/admin/members/sync", nil)
	manual.Header.Set("X-Portal-User-Uid", "directory-admin")
	manual.Header.Set("X-Portal-Roles", "portal-admin")
	manualResponse := httptest.NewRecorder()
	New().ServeHTTP(manualResponse, manual)
	if manualResponse.Code != http.StatusOK {
		t.Fatalf("manual sync status = %d, want %d; body = %s", manualResponse.Code, http.StatusOK, manualResponse.Body.String())
	}

	users = nil
	request = httptest.NewRequest(http.MethodPost, "/internal/portal/directory-sync", bytes.NewBufferString(`{"userUid":"`+userUID+`"}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Portal-Service-Key", "infinite-canvas")
	request.Header.Set("X-Portal-Service-Secret", "directory-secret")
	response = httptest.NewRecorder()
	New().ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("disable callback status = %d, want %d", response.Code, http.StatusNoContent)
	}
	member, found, err = repository.GetPortalMember(userUID)
	if err != nil || !found || member.Enabled {
		t.Fatalf("disabled member = %+v, found=%t, err=%v", member, found, err)
	}
}

func TestPortalSessionUsesDirectoryDisplayNameAndFallsBackToUsername(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/api/session", nil)
	request.Header.Set("X-Portal-User-Uid", "session-user")
	request.Header.Set("X-Portal-Username", "fallback-name")
	response := httptest.NewRecorder()
	New().ServeHTTP(response, request)
	var payload struct {
		Data struct {
			User struct {
				DisplayName string `json:"displayName"`
			} `json:"user"`
		} `json:"data"`
	}
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &payload) != nil || payload.Data.User.DisplayName != "fallback-name" {
		t.Fatalf("fallback session = %d/%s", response.Code, response.Body.String())
	}
	if err := repository.UpsertPortalMembers([]model.PortalMember{{UserUID: "session-user", DisplayName: "目录姓名", Enabled: true}}); err != nil {
		t.Fatal(err)
	}
	response = httptest.NewRecorder()
	New().ServeHTTP(response, request)
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &payload) != nil || payload.Data.User.DisplayName != "目录姓名" {
		t.Fatalf("directory session = %d/%s", response.Code, response.Body.String())
	}
}

func TestOperationLogListsAuditedWriteAndCleansExpiredEntries(t *testing.T) {
	request := httptest.NewRequest(http.MethodPost, "/api/admin/public-folders", bytes.NewBufferString(`{"title":"审计目录"}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Portal-User-Uid", "audit-admin")
	request.Header.Set("X-Portal-Username", "audit-admin")
	request.Header.Set("X-Portal-Roles", "portal-admin")
	response := httptest.NewRecorder()
	New().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("create status = %d, body = %s", response.Code, response.Body.String())
	}

	request = httptest.NewRequest(http.MethodGet, "/api/admin/operation-logs?action=public_folder_create&actor=audit-admin", nil)
	request.Header.Set("X-Portal-User-Uid", "audit-admin")
	request.Header.Set("X-Portal-Roles", "portal-admin")
	response = httptest.NewRecorder()
	New().ServeHTTP(response, request)
	var payload struct {
		Data model.OperationLogList `json:"data"`
	}
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &payload) != nil || payload.Data.Total == 0 {
		t.Fatalf("operation logs status/data = %d/%s", response.Code, response.Body.String())
	}
	item := payload.Data.Items[0]
	if item.ActorUID != "audit-admin" || item.ActorName != "audit-admin" || item.Action != "public_folder_create" || item.Status != model.OperationStatusSuccess {
		t.Fatalf("operation item = %+v", item)
	}
	if item.MediaIDs == nil {
		t.Fatal("operation log without media must return an empty mediaIds array")
	}

	if err := repository.SaveOperationLog(model.OperationLog{ID: "operation-expired", ActorUID: "audit-admin", ActorName: "审计", Action: "expired", Status: model.OperationStatusSuccess, CreatedAt: time.Now().Add(-8 * 24 * time.Hour)}); err != nil {
		t.Fatal(err)
	}
	if err := service.CleanupExpiredOperationLogs(time.Now()); err != nil {
		t.Fatal(err)
	}
	items, _, err := repository.ListOperationLogs(model.OperationLogQuery{Action: "expired"})
	if err != nil || len(items) != 0 {
		t.Fatalf("expired operation logs = %+v, err=%v", items, err)
	}
}

func TestPrivateMediaDeleteHardDeletesOwnedPrivateMedia(t *testing.T) {
	item := model.Media{ID: "media-private-delete", OwnerUID: "owner", ObjectKey: "images/private/owner/delete.png", ContentType: "image/png"}
	objectPath := filepath.Join(mediaTestDirectory, filepath.FromSlash(item.ObjectKey))
	if err := os.MkdirAll(filepath.Dir(objectPath), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(objectPath, []byte("image"), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.SaveMedia(item); err != nil {
		t.Fatal(err)
	}

	request := httptest.NewRequest(http.MethodDelete, "/api/v1/media/"+item.ID, nil)
	request.Header.Set("X-Portal-User-Uid", item.OwnerUID)
	response := httptest.NewRecorder()
	New().ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body = %s", response.Code, http.StatusOK, response.Body.String())
	}
	if _, err := os.Stat(objectPath); !os.IsNotExist(err) {
		t.Fatalf("object still exists after deletion: %v", err)
	}
	_, found, err := repository.GetMedia(item.ID)
	if err != nil {
		t.Fatal(err)
	}
	if found {
		t.Fatal("media record still exists after deletion")
	}

	response = httptest.NewRecorder()
	New().ServeHTTP(response, request)
	var body struct {
		Code int `json:"code"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusOK || body.Code != 0 {
		t.Fatalf("repeated delete status/code = %d/%d, want %d/0; body = %s", response.Code, body.Code, http.StatusOK, response.Body.String())
	}
}

func TestPrivateMediaDeleteCleansDatabaseRecordWhenLocalObjectIsMissing(t *testing.T) {
	item := model.Media{ID: "media-private-missing-object", OwnerUID: "owner", ObjectKey: "images/private/owner/missing.png", ContentType: "image/png"}
	if _, err := repository.SaveMedia(item); err != nil {
		t.Fatal(err)
	}

	request := httptest.NewRequest(http.MethodDelete, "/api/v1/media/"+item.ID, nil)
	request.Header.Set("X-Portal-User-Uid", item.OwnerUID)
	response := httptest.NewRecorder()
	New().ServeHTTP(response, request)

	var body struct {
		Code int `json:"code"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusOK || body.Code != 0 {
		t.Fatalf("missing-object delete status/code = %d/%d, want %d/0; body = %s", response.Code, body.Code, http.StatusOK, response.Body.String())
	}
	_, found, err := repository.GetMedia(item.ID)
	if err != nil {
		t.Fatal(err)
	}
	if found {
		t.Fatal("media record must be removed when its object is already missing")
	}
}

func TestPrivateMediaDeleteDoesNotDeletePublicLibraryMedia(t *testing.T) {
	item := model.Media{ID: "media-public-library", OwnerUID: "owner", ObjectKey: "images/public/delete.png", ContentType: "image/png"}
	if _, err := repository.SaveMedia(item); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.SavePublicImage(model.PublicImage{ID: "public-delete-guard", MediaID: item.ID, UploaderUID: item.OwnerUID}); err != nil {
		t.Fatal(err)
	}

	request := httptest.NewRequest(http.MethodDelete, "/api/v1/media/"+item.ID, nil)
	request.Header.Set("X-Portal-User-Uid", item.OwnerUID)
	response := httptest.NewRecorder()
	New().ServeHTTP(response, request)

	var body struct {
		Code int `json:"code"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Code != 1 {
		t.Fatalf("response code = %d, want 1; body = %s", body.Code, response.Body.String())
	}
	_, found, err := repository.GetMedia(item.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !found {
		t.Fatal("public library media must remain after private delete request")
	}
}

func TestPrivateMediaDeleteRejectsOtherUsers(t *testing.T) {
	item := model.Media{ID: "media-private-delete-forbidden", OwnerUID: "owner", ObjectKey: "images/private/owner/forbidden.png", ContentType: "image/png"}
	objectPath := filepath.Join(mediaTestDirectory, filepath.FromSlash(item.ObjectKey))
	if err := os.MkdirAll(filepath.Dir(objectPath), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(objectPath, []byte("image"), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.SaveMedia(item); err != nil {
		t.Fatal(err)
	}

	request := httptest.NewRequest(http.MethodDelete, "/api/v1/media/"+item.ID, nil)
	request.Header.Set("X-Portal-User-Uid", "other-user")
	response := httptest.NewRecorder()
	New().ServeHTTP(response, request)

	var body struct {
		Code int `json:"code"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusOK || body.Code != 1 {
		t.Fatalf("forbidden delete status/code = %d/%d, want %d/1; body = %s", response.Code, body.Code, http.StatusOK, response.Body.String())
	}
	if _, err := os.Stat(objectPath); err != nil {
		t.Fatalf("object must remain after forbidden delete: %v", err)
	}
	_, found, err := repository.GetMedia(item.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !found {
		t.Fatal("media record must remain after forbidden delete")
	}
}

func TestDeletePublicImageAndMediaDeletesBothRecords(t *testing.T) {
	media := model.Media{ID: "media-public-transaction", OwnerUID: "admin", ObjectKey: "images/public/transaction.png", ContentType: "image/png"}
	publicImage := model.PublicImage{ID: "public-transaction", MediaID: media.ID, UploaderUID: media.OwnerUID}
	if _, err := repository.SaveMedia(media); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.SavePublicImage(publicImage); err != nil {
		t.Fatal(err)
	}

	if err := repository.DeletePublicImageAndMedia(publicImage.ID, media.ID); err != nil {
		t.Fatal(err)
	}
	_, publicFound, err := repository.GetPublicImage(publicImage.ID)
	if err != nil {
		t.Fatal(err)
	}
	if publicFound {
		t.Fatal("public image record still exists after transactional deletion")
	}
	_, mediaFound, err := repository.GetMedia(media.ID)
	if err != nil {
		t.Fatal(err)
	}
	if mediaFound {
		t.Fatal("media record still exists after transactional deletion")
	}
}

func TestAdminPublicImageDeleteHardDeletesObjectAndRecords(t *testing.T) {
	media := model.Media{ID: "media-public-hard-delete", OwnerUID: "admin", ObjectKey: "images/public/hard-delete.png", ContentType: "image/png"}
	publicImage := model.PublicImage{ID: "public-hard-delete", MediaID: media.ID, UploaderUID: media.OwnerUID}
	objectPath := filepath.Join(mediaTestDirectory, filepath.FromSlash(media.ObjectKey))
	if err := os.MkdirAll(filepath.Dir(objectPath), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(objectPath, []byte("image"), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.SaveMedia(media); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.SavePublicImage(publicImage); err != nil {
		t.Fatal(err)
	}

	request := httptest.NewRequest(http.MethodDelete, "/api/admin/public-images/"+publicImage.ID, nil)
	request.Header.Set("X-Portal-User-Uid", media.OwnerUID)
	request.Header.Set("X-Portal-Roles", "portal-admin")
	response := httptest.NewRecorder()
	New().ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body = %s", response.Code, http.StatusOK, response.Body.String())
	}
	if _, err := os.Stat(objectPath); !os.IsNotExist(err) {
		t.Fatalf("object still exists after deletion: %v", err)
	}
	_, publicFound, err := repository.GetPublicImage(publicImage.ID)
	if err != nil {
		t.Fatal(err)
	}
	if publicFound {
		t.Fatal("public image record still exists after deletion")
	}
	_, mediaFound, err := repository.GetMedia(media.ID)
	if err != nil {
		t.Fatal(err)
	}
	if mediaFound {
		t.Fatal("media record still exists after deletion")
	}
}

func TestAdminPublicImageDeleteCleansRecordsWhenLocalObjectIsMissing(t *testing.T) {
	media := model.Media{ID: "media-public-missing-object", OwnerUID: "admin", ObjectKey: "images/public/missing.png", ContentType: "image/png"}
	publicImage := model.PublicImage{ID: "public-missing-object", MediaID: media.ID, UploaderUID: media.OwnerUID}
	if _, err := repository.SaveMedia(media); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.SavePublicImage(publicImage); err != nil {
		t.Fatal(err)
	}

	request := httptest.NewRequest(http.MethodDelete, "/api/admin/public-images/"+publicImage.ID, nil)
	request.Header.Set("X-Portal-User-Uid", media.OwnerUID)
	request.Header.Set("X-Portal-Roles", "portal-admin")
	response := httptest.NewRecorder()
	New().ServeHTTP(response, request)

	var body struct {
		Code int `json:"code"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusOK || body.Code != 0 {
		t.Fatalf("missing-object public delete status/code = %d/%d, want %d/0; body = %s", response.Code, body.Code, http.StatusOK, response.Body.String())
	}
	_, publicFound, err := repository.GetPublicImage(publicImage.ID)
	if err != nil {
		t.Fatal(err)
	}
	if publicFound {
		t.Fatal("public image record must be removed when its object is already missing")
	}
	_, mediaFound, err := repository.GetMedia(media.ID)
	if err != nil {
		t.Fatal(err)
	}
	if mediaFound {
		t.Fatal("media record must be removed when its public object is already missing")
	}
}

func TestLegacyAssetRoutesAreNotRegistered(t *testing.T) {
	legacy := map[string]bool{
		"/api/assets":           true,
		"/api/admin/assets":     true,
		"/api/admin/assets/:id": true,
	}

	for _, route := range New().Routes() {
		if legacy[route.Path] {
			t.Fatalf("legacy asset route is still registered: %s %s", route.Method, route.Path)
		}
	}
}

func TestPublicFolderListRequiresPortalIdentity(t *testing.T) {
	response := httptest.NewRecorder()
	New().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/public-folders", nil))
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status = %d, want %d; body = %s", response.Code, http.StatusUnauthorized, response.Body.String())
	}

	request := httptest.NewRequest(http.MethodGet, "/api/v1/public-folders", nil)
	request.Header.Set("X-Portal-User-Uid", "member")
	response = httptest.NewRecorder()
	New().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("authenticated status = %d, want %d; body = %s", response.Code, http.StatusOK, response.Body.String())
	}
}

func TestAdminCanCreateNestedPublicFoldersAndRejectsDuplicateSiblingNames(t *testing.T) {
	create := func(body string, admin bool) (*httptest.ResponseRecorder, model.PublicFolder) {
		req := httptest.NewRequest(http.MethodPost, "/api/admin/public-folders", bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Portal-User-Uid", "folder-admin")
		if admin {
			req.Header.Set("X-Portal-Roles", "portal-admin")
		}
		res := httptest.NewRecorder()
		New().ServeHTTP(res, req)
		var payload struct {
			Data model.PublicFolder `json:"data"`
		}
		if res.Code == http.StatusOK {
			if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
				t.Fatal(err)
			}
		}
		return res, payload.Data
	}

	res, _ := create(`{"title":"无权限"}`, false)
	if res.Code != http.StatusForbidden {
		t.Fatalf("non-admin status = %d, want %d; body = %s", res.Code, http.StatusForbidden, res.Body.String())
	}

	res, parent := create(`{"title":"  产品图  "}`, true)
	if res.Code != http.StatusOK || parent.Title != "产品图" || parent.ParentID != "" {
		t.Fatalf("create root status/data = %d/%+v; body = %s", res.Code, parent, res.Body.String())
	}
	res, child := create(`{"title":"首图","parentId":"`+parent.ID+`"}`, true)
	if res.Code != http.StatusOK || child.ParentID != parent.ID {
		t.Fatalf("create child status/data = %d/%+v; body = %s", res.Code, child, res.Body.String())
	}
	res, _ = create(`{"title":"产品图","parentId":"`+parent.ID+`"}`, true)
	if res.Code != http.StatusOK {
		t.Fatalf("same title under another parent status = %d, want %d; body = %s", res.Code, http.StatusOK, res.Body.String())
	}
	res, _ = create(`{"title":"首图","parentId":"`+parent.ID+`"}`, true)
	if res.Code != http.StatusOK {
		t.Fatalf("duplicate sibling returns HTTP status = %d, want %d; body = %s", res.Code, http.StatusOK, res.Body.String())
	}
	var duplicate struct {
		Code int `json:"code"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &duplicate); err != nil {
		t.Fatal(err)
	}
	if duplicate.Code != 1 {
		t.Fatalf("duplicate sibling response code = %d, want 1; body = %s", duplicate.Code, res.Body.String())
	}
}

func TestPublicImageListFiltersByFolderAndDefaultsToRoot(t *testing.T) {
	rootMedia := model.Media{ID: "media-public-root-filter", OwnerUID: "admin", ObjectKey: "images/public/root-filter.png", ContentType: "image/png"}
	childMedia := model.Media{ID: "media-public-child-filter", OwnerUID: "admin", ObjectKey: "images/public/child-filter.png", ContentType: "image/png"}
	if _, err := repository.SaveMedia(rootMedia); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.SaveMedia(childMedia); err != nil {
		t.Fatal(err)
	}
	folder, err := repository.SavePublicFolder(model.PublicFolder{ID: "folder-public-filter", Title: "筛选文件夹", CreatedAt: "2026-08-21T00:00:00Z"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repository.SavePublicImage(model.PublicImage{ID: "public-root-filter", MediaID: rootMedia.ID, Title: "根目录图片", UploaderUID: "admin"}); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.SavePublicImage(model.PublicImage{ID: "public-child-filter", MediaID: childMedia.ID, FolderID: folder.ID, Title: "文件夹图片", UploaderUID: "admin"}); err != nil {
		t.Fatal(err)
	}
	db, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Exec("UPDATE public_images SET folder_id = NULL WHERE id = ?", "public-root-filter").Error; err != nil {
		t.Fatal(err)
	}

	list := func(path string) model.PublicImageList {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Header.Set("X-Portal-User-Uid", "member")
		res := httptest.NewRecorder()
		New().ServeHTTP(res, req)
		if res.Code != http.StatusOK {
			t.Fatalf("list status = %d, want %d; body = %s", res.Code, http.StatusOK, res.Body.String())
		}
		var payload struct {
			Data model.PublicImageList `json:"data"`
		}
		if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
			t.Fatal(err)
		}
		return payload.Data
	}
	contains := func(items []model.PublicImage, id string) bool {
		for _, item := range items {
			if item.ID == id {
				return true
			}
		}
		return false
	}
	root := list("/api/v1/public-images")
	if !contains(root.Items, "public-root-filter") || contains(root.Items, "public-child-filter") {
		t.Fatalf("root items = %+v, want only root filtering", root.Items)
	}
	child := list("/api/v1/public-images?folderId=" + folder.ID)
	if !contains(child.Items, "public-child-filter") || contains(child.Items, "public-root-filter") || child.Items[0].FolderID != folder.ID {
		t.Fatalf("folder items = %+v, want requested folder filtering and folderId", child.Items)
	}
}

func TestAdminPublicImageRenameAndMovePreserveMediaIdentityAndObjectKey(t *testing.T) {
	media := model.Media{ID: "media-public-move", OwnerUID: "admin", ObjectKey: "images/public/keep-object-key.png", ContentType: "image/png"}
	if _, err := repository.SaveMedia(media); err != nil {
		t.Fatal(err)
	}
	folder, err := repository.SavePublicFolder(model.PublicFolder{ID: "folder-public-move", Title: "移动目标", CreatedAt: "2026-08-21T00:00:00Z"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repository.SavePublicImage(model.PublicImage{ID: "public-move", MediaID: media.ID, Title: "旧名称", UploaderUID: "admin"}); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPatch, "/api/admin/public-images/public-move", bytes.NewBufferString(`{"title":"  新名称  ","folderId":"`+folder.ID+`"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Portal-User-Uid", "admin")
	res := httptest.NewRecorder()
	New().ServeHTTP(res, req)
	if res.Code != http.StatusForbidden {
		t.Fatalf("non-admin patch status = %d, want %d; body = %s", res.Code, http.StatusForbidden, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodPatch, "/api/admin/public-images/public-move", bytes.NewBufferString(`{"title":"  新名称  ","folderId":"`+folder.ID+`"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Portal-User-Uid", "admin")
	req.Header.Set("X-Portal-Roles", "portal-admin")
	res = httptest.NewRecorder()
	New().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("admin patch status = %d, want %d; body = %s", res.Code, http.StatusOK, res.Body.String())
	}
	updated, found, err := repository.GetPublicImage("public-move")
	if err != nil || !found {
		t.Fatalf("updated image lookup = %+v, %t, %v", updated, found, err)
	}
	if updated.Title != "新名称" || updated.FolderID != folder.ID || updated.MediaID != media.ID || updated.Media.ObjectKey != media.ObjectKey {
		t.Fatalf("updated image = %+v, media = %+v; want changed title/folder only", updated, updated.Media)
	}
}

func TestAdminPublicImageUploadPersistsFolderImmediatelyAndRejectsUnknownFolderBeforeMediaWrite(t *testing.T) {
	folder, err := repository.SavePublicFolder(model.PublicFolder{ID: "folder-public-upload", Title: "上传目标", CreatedAt: "2026-08-21T00:00:00Z"})
	if err != nil {
		t.Fatal(err)
	}
	pngData, err := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLxgAAAAABJRU5ErkJggg==")
	if err != nil {
		t.Fatal(err)
	}
	upload := func(folderID string) *httptest.ResponseRecorder {
		body := &bytes.Buffer{}
		writer := multipart.NewWriter(body)
		part, err := writer.CreateFormFile("image", "upload.png")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := part.Write(pngData); err != nil {
			t.Fatal(err)
		}
		if err := writer.WriteField("title", "上传素材"); err != nil {
			t.Fatal(err)
		}
		if err := writer.WriteField("folderId", folderID); err != nil {
			t.Fatal(err)
		}
		if err := writer.Close(); err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest(http.MethodPost, "/api/admin/public-images", body)
		req.Header.Set("Content-Type", writer.FormDataContentType())
		req.Header.Set("X-Portal-User-Uid", "admin")
		req.Header.Set("X-Portal-Roles", "portal-admin")
		res := httptest.NewRecorder()
		New().ServeHTTP(res, req)
		return res
	}
	count := func() (int64, int64) {
		db, err := repository.DB()
		if err != nil {
			t.Fatal(err)
		}
		var mediaCount, publicImageCount int64
		if err := db.Model(&model.Media{}).Count(&mediaCount).Error; err != nil {
			t.Fatal(err)
		}
		if err := db.Model(&model.PublicImage{}).Count(&publicImageCount).Error; err != nil {
			t.Fatal(err)
		}
		return mediaCount, publicImageCount
	}

	beforeMedia, beforeImages := count()
	res := upload(folder.ID)
	if res.Code != http.StatusOK {
		t.Fatalf("upload status = %d, want %d; body = %s", res.Code, http.StatusOK, res.Body.String())
	}
	var response struct {
		Data struct {
			Item model.PublicImage `json:"item"`
		} `json:"data"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.Data.Item.FolderID != folder.ID {
		t.Fatalf("uploaded folderId = %q, want %q", response.Data.Item.FolderID, folder.ID)
	}
	if afterMedia, afterImages := count(); afterMedia != beforeMedia+1 || afterImages != beforeImages+1 {
		t.Fatalf("record counts after successful upload = %d/%d, want %d/%d", afterMedia, afterImages, beforeMedia+1, beforeImages+1)
	}

	beforeMedia, beforeImages = count()
	res = upload("folder-does-not-exist")
	var failure struct {
		Code int `json:"code"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &failure); err != nil {
		t.Fatal(err)
	}
	if res.Code != http.StatusOK || failure.Code != 1 {
		t.Fatalf("unknown-folder upload status/code = %d/%d, want %d/1; body = %s", res.Code, failure.Code, http.StatusOK, res.Body.String())
	}
	if afterMedia, afterImages := count(); afterMedia != beforeMedia || afterImages != beforeImages {
		t.Fatalf("unknown-folder upload left records: %d/%d, want %d/%d", afterMedia, afterImages, beforeMedia, beforeImages)
	}
}

func TestAdminCanRenameAndDeleteOnlyEmptyPublicFolders(t *testing.T) {
	empty, err := repository.SavePublicFolder(model.PublicFolder{ID: "folder-public-manage-empty", Title: "旧目录", CreatedAt: "2026-08-21T00:00:00Z"})
	if err != nil {
		t.Fatal(err)
	}
	occupied, err := repository.SavePublicFolder(model.PublicFolder{ID: "folder-public-manage-occupied", Title: "有素材目录", CreatedAt: "2026-08-21T00:00:00Z"})
	if err != nil {
		t.Fatal(err)
	}
	media := model.Media{ID: "media-public-folder-occupied", OwnerUID: "admin", ObjectKey: "images/public/folder-occupied.png", ContentType: "image/png"}
	if _, err := repository.SaveMedia(media); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.SavePublicImage(model.PublicImage{ID: "public-folder-occupied", MediaID: media.ID, FolderID: occupied.ID, Title: "目录素材", UploaderUID: "admin"}); err != nil {
		t.Fatal(err)
	}

	request := func(method, path, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Portal-User-Uid", "admin")
		req.Header.Set("X-Portal-Roles", "portal-admin")
		res := httptest.NewRecorder()
		New().ServeHTTP(res, req)
		return res
	}

	res := request(http.MethodPatch, "/api/admin/public-folders/"+empty.ID, `{"title":"  新目录  "}`)
	if res.Code != http.StatusOK {
		t.Fatalf("rename status = %d, want %d; body = %s", res.Code, http.StatusOK, res.Body.String())
	}
	renamed, found, err := repository.GetPublicFolder(empty.ID)
	if err != nil || !found || renamed.Title != "新目录" {
		t.Fatalf("renamed folder = %+v, %t, %v", renamed, found, err)
	}

	res = request(http.MethodDelete, "/api/admin/public-folders/"+occupied.ID, "")
	var failed struct {
		Code int `json:"code"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &failed); err != nil {
		t.Fatal(err)
	}
	if res.Code != http.StatusOK || failed.Code != 1 {
		t.Fatalf("occupied delete status/code = %d/%d, want %d/1; body = %s", res.Code, failed.Code, http.StatusOK, res.Body.String())
	}

	res = request(http.MethodDelete, "/api/admin/public-folders/"+empty.ID, "")
	if res.Code != http.StatusOK {
		t.Fatalf("empty delete status = %d, want %d; body = %s", res.Code, http.StatusOK, res.Body.String())
	}
	_, found, err = repository.GetPublicFolder(empty.ID)
	if err != nil || found {
		t.Fatalf("deleted folder lookup found/error = %t/%v", found, err)
	}
}
