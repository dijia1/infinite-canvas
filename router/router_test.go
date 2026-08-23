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
	"testing"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
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
