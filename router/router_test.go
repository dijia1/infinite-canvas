package router

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	_ "github.com/basketikun/infinite-canvas/ai/providers"
	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/internal/testpostgres"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/basketikun/infinite-canvas/service"
	"github.com/shopspring/decimal"
)

var mediaTestDirectory string

func TestMain(m *testing.M) {
	directory, err := os.MkdirTemp("", "infinite-canvas-router-test-")
	if err != nil {
		panic(err)
	}
	mediaTestDirectory = directory
	schema, err := testpostgres.NewSchema("router")
	if err != nil {
		panic(err)
	}
	config.Cfg = config.Config{
		DatabaseDSN:                    schema.DSN,
		MediaStorage:                   "local",
		MediaLocalDir:                  directory,
		CanvasSaveSuccessLogSampleRate: 1,
	}
	code := m.Run()
	closeRepositoryPool()
	_ = schema.Close()
	_ = os.RemoveAll(directory)
	os.Exit(code)
}

func closeRepositoryPool() {
	database, _ := repository.DB()
	if database == nil {
		return
	}
	sqlDB, err := database.DB()
	if err == nil {
		_ = sqlDB.Close()
	}
}

func grantLocalAppRole(t *testing.T, userUID string, role model.AppRole, enabled bool) {
	t.Helper()
	if err := repository.UpsertPortalMembers([]model.PortalMember{{
		UserUID: userUID, DisplayName: userUID, Enabled: enabled, Roles: []string{}, SyncedAt: time.Now().UTC(),
	}}); err != nil {
		t.Fatal(err)
	}
	if err := repository.SetAppRole(userUID, role, "test-grantor"); err != nil {
		t.Fatal(err)
	}
}

func requestWithPortalHeaders(method, path, userUID, roles string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, nil)
	request.Header.Set("X-Portal-User-Uid", userUID)
	if roles != "" {
		request.Header.Set("X-Portal-Roles", roles)
	}
	response := httptest.NewRecorder()
	New().ServeHTTP(response, request)
	return response
}

func requestAppRoleChange(userUID, targetUID string, role model.AppRole, extraJSON string) *httptest.ResponseRecorder {
	body := fmt.Sprintf(`{"appRole":%q%s}`, role, extraJSON)
	request := httptest.NewRequest(http.MethodPatch, "/api/admin/members/"+targetUID+"/app-role", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Portal-User-Uid", userUID)
	response := httptest.NewRecorder()
	New().ServeHTTP(response, request)
	return response
}

func TestAdminSetsApplicationRoleAndAuditsIt(t *testing.T) {
	const adminUID = "role-route-admin"
	const targetUID = "role-route-target"
	grantLocalAppRole(t, adminUID, model.AppRoleAdmin, true)
	if err := repository.UpsertPortalMembers([]model.PortalMember{{
		UserUID: targetUID, DisplayName: "真实目标姓名", Enabled: true, Roles: []string{"Portal 设计师"}, SyncedAt: time.Now().UTC(),
	}}); err != nil {
		t.Fatal(err)
	}

	for attempt := 0; attempt < 2; attempt++ {
		response := requestAppRoleChange(adminUID, targetUID, model.AppRolePublicAssetsManager, `,"actorUid":"spoofed-actor","targetName":"伪造姓名"`)
		var payload struct {
			Code int `json:"code"`
			Data struct {
				UserUID     string        `json:"userUid"`
				DisplayName string        `json:"displayName"`
				Roles       []string      `json:"roles"`
				AppRole     model.AppRole `json:"appRole"`
			} `json:"data"`
		}
		if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &payload) != nil || payload.Code != 0 {
			t.Fatalf("attempt %d status/body = %d/%s", attempt+1, response.Code, response.Body.String())
		}
		if payload.Data.UserUID != targetUID || payload.Data.DisplayName != "真实目标姓名" || payload.Data.AppRole != model.AppRolePublicAssetsManager {
			t.Fatalf("changed member = %+v", payload.Data)
		}
		if len(payload.Data.Roles) != 1 || payload.Data.Roles[0] != "Portal 设计师" {
			t.Fatalf("Portal roles changed with app role: %#v", payload.Data.Roles)
		}
	}

	items, _, err := repository.ListOperationLogs(model.OperationLogQuery{Action: "member_app_role_change", Page: 1, PageSize: 20})
	if err != nil {
		t.Fatal(err)
	}
	matching := 0
	for _, item := range items {
		if item.TargetID != targetUID {
			continue
		}
		matching++
		if item.ActorUID != adminUID || item.TargetType != "portal_member" || item.TargetName != "真实目标姓名" || item.Status != model.OperationStatusSuccess {
			t.Fatalf("role audit = %+v", item)
		}
		if item.RequestSummary != `{"appRole":"public_assets_manager"}` {
			t.Fatalf("role audit request summary = %q, want validated resulting role", item.RequestSummary)
		}
	}
	if matching != 2 {
		t.Fatalf("matching role audit count = %d, want one per successful idempotent request; logs=%+v", matching, items)
	}

	database, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	var assignment model.AppMemberRole
	if err := database.Where("user_uid = ?", targetUID).First(&assignment).Error; err != nil {
		t.Fatal(err)
	}
	if assignment.GrantedByUID != adminUID {
		t.Fatalf("grantedByUid = %q, want %q", assignment.GrantedByUID, adminUID)
	}
}

func TestRoleChangeRejectsOnlyEnabledAdminDemotionWhenAnotherAssignmentIsDisabled(t *testing.T) {
	database, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Where("role = ?", model.AppRoleAdmin).Delete(&model.AppMemberRole{}).Error; err != nil {
		t.Fatal(err)
	}
	const enabledAdminUID = "role-route-enabled-last-admin"
	const disabledAdminUID = "role-route-disabled-explicit-admin"
	grantLocalAppRole(t, enabledAdminUID, model.AppRoleAdmin, true)
	grantLocalAppRole(t, disabledAdminUID, model.AppRoleAdmin, true)
	if err := repository.UpsertPortalMembers([]model.PortalMember{{
		UserUID: disabledAdminUID, DisplayName: disabledAdminUID, Enabled: false, Roles: []string{}, SyncedAt: time.Now().UTC(),
	}}); err != nil {
		t.Fatal(err)
	}

	response := requestAppRoleChange(enabledAdminUID, enabledAdminUID, model.AppRoleMember, "")
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), `"code":1`) || !strings.Contains(response.Body.String(), `"data":null`) {
		t.Fatalf("last enabled admin status/body = %d/%s, want HTTP 409 JSON envelope", response.Code, response.Body.String())
	}
	if role, err := repository.ResolveAppRole(enabledAdminUID); err != nil || role != model.AppRoleAdmin {
		t.Fatalf("enabled administrator role = %q, err=%v; want unchanged admin", role, err)
	}
}

func TestRoleChangeRejectsInvalidTargetsLastAdminDemotionAndNonAdmins(t *testing.T) {
	database, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Where("role = ?", model.AppRoleAdmin).Delete(&model.AppMemberRole{}).Error; err != nil {
		t.Fatal(err)
	}
	const adminUID = "role-route-only-admin"
	const enabledUID = "role-route-enabled-target"
	const disabledUID = "role-route-disabled-target"
	const managerUID = "role-route-manager"
	const memberUID = "role-route-member"
	grantLocalAppRole(t, adminUID, model.AppRoleAdmin, true)
	grantLocalAppRole(t, managerUID, model.AppRolePublicAssetsManager, true)
	grantLocalAppRole(t, memberUID, model.AppRoleMember, true)
	if err := repository.UpsertPortalMembers([]model.PortalMember{
		{UserUID: enabledUID, DisplayName: enabledUID, Enabled: true, Roles: []string{}},
		{UserUID: disabledUID, DisplayName: disabledUID, Enabled: false, Roles: []string{}},
	}); err != nil {
		t.Fatal(err)
	}

	for _, test := range []struct {
		name      string
		targetUID string
		role      model.AppRole
	}{
		{name: "invalid role", targetUID: enabledUID, role: model.AppRole("owner")},
		{name: "disabled target", targetUID: disabledUID, role: model.AppRoleAdmin},
		{name: "missing target", targetUID: "role-route-missing-target", role: model.AppRoleAdmin},
	} {
		t.Run(test.name, func(t *testing.T) {
			response := requestAppRoleChange(adminUID, test.targetUID, test.role, "")
			if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), `"code":1`) || !strings.Contains(response.Body.String(), `"data":null`) {
				t.Fatalf("status/body = %d/%s, want HTTP 400 JSON envelope", response.Code, response.Body.String())
			}
		})
	}

	conflict := requestAppRoleChange(adminUID, adminUID, model.AppRoleMember, "")
	if conflict.Code != http.StatusConflict || !strings.Contains(conflict.Body.String(), `"code":1`) || !strings.Contains(conflict.Body.String(), `"data":null`) {
		t.Fatalf("last-admin status/body = %d/%s, want HTTP 409 JSON envelope", conflict.Code, conflict.Body.String())
	}
	if role, err := repository.ResolveAppRole(adminUID); err != nil || role != model.AppRoleAdmin {
		t.Fatalf("last administrator role = %q, err=%v", role, err)
	}

	for _, callerUID := range []string{managerUID, memberUID} {
		response := requestAppRoleChange(callerUID, enabledUID, model.AppRoleAdmin, "")
		if response.Code != http.StatusForbidden {
			t.Fatalf("caller %q status/body = %d/%s, want forbidden", callerUID, response.Code, response.Body.String())
		}
	}
}

func TestGatewayAdminRoleAloneDoesNotGrantLocalAdmin(t *testing.T) {
	const userUID = "gateway-admin-only-router"
	grantLocalAppRole(t, userUID, model.AppRoleMember, true)
	response := requestWithPortalHeaders(http.MethodGet, "/api/admin/me", userUID, "portal-admin")
	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d; body = %s", response.Code, http.StatusForbidden, response.Body.String())
	}
}

func TestLegacyGatewayRolesNeverGrantLocalPrivileges(t *testing.T) {
	const userUID = "legacy-gateway-role-only-member"
	grantLocalAppRole(t, userUID, model.AppRoleMember, true)

	admin := requestWithPortalHeaders(http.MethodGet, "/api/admin/me", userUID, "portal-admin")
	if admin.Code != http.StatusForbidden {
		t.Fatalf("legacy Gateway admin role status = %d, want %d; body = %s", admin.Code, http.StatusForbidden, admin.Body.String())
	}

	request := httptest.NewRequest(http.MethodPost, "/api/admin/public-folders", strings.NewReader(`{"title":"旧 Gateway 角色无权创建"}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Portal-User-Uid", userUID)
	request.Header.Set("X-Portal-Roles", "portal-public-assets-manager,portal-admin")
	publicAssets := httptest.NewRecorder()
	New().ServeHTTP(publicAssets, request)
	if publicAssets.Code != http.StatusForbidden {
		t.Fatalf("legacy Gateway public-assets role status = %d, want %d; body = %s", publicAssets.Code, http.StatusForbidden, publicAssets.Body.String())
	}
}

func TestLocalPublicAssetsManagerWritesOnlyPublicAssets(t *testing.T) {
	const userUID = "local-public-assets-manager-router"
	grantLocalAppRole(t, userUID, model.AppRolePublicAssetsManager, true)

	request := httptest.NewRequest(http.MethodPost, "/api/admin/public-folders", strings.NewReader(`{"title":"本地素材管理员目录"}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Portal-User-Uid", userUID)
	publicAssets := httptest.NewRecorder()
	New().ServeHTTP(publicAssets, request)
	if publicAssets.Code != http.StatusOK {
		t.Fatalf("public-assets status = %d, want %d; body = %s", publicAssets.Code, http.StatusOK, publicAssets.Body.String())
	}

	admin := requestWithPortalHeaders(http.MethodGet, "/api/admin/settings", userUID, "")
	if admin.Code != http.StatusForbidden {
		t.Fatalf("admin status = %d, want %d; body = %s", admin.Code, http.StatusForbidden, admin.Body.String())
	}
}

func TestLocalAdminMediaAccessesCrossUserPrivateMedia(t *testing.T) {
	const adminUID = "local-admin-cross-user-media"
	grantLocalAppRole(t, adminUID, model.AppRoleAdmin, true)
	item := model.Media{
		ID: "local-admin-cross-user-private-media", OwnerUID: "different-media-owner",
		ObjectKey: "images/private/different-media-owner/admin-access.png", ContentType: "image/png",
	}
	if _, err := repository.SaveMedia(item); err != nil {
		t.Fatal(err)
	}

	response := requestWithPortalHeaders(http.MethodGet, "/api/v1/media/"+item.ID+"/access", adminUID, "member")
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"code":0`) {
		t.Fatalf("local-admin media access = %d/%s", response.Code, response.Body.String())
	}
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

func TestMediaUploadIntentUsesProxyModeForLocalStorage(t *testing.T) {
	request := httptest.NewRequest(http.MethodPost, "/api/v1/media/upload-intents", strings.NewReader(`{"filename":"canvas.png","contentType":"image/png","bytes":42,"intent":"canvas"}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Portal-User-Uid", "local-upload-owner")
	response := httptest.NewRecorder()
	New().ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"mode":"proxy"`) {
		t.Fatalf("local upload intent = %d/%s", response.Code, response.Body.String())
	}
}

func TestMediaUploadIntentRetentionRemovesOnlyExpiredUncompletedRequests(t *testing.T) {
	current := time.Now().UTC()
	expired := model.MediaUploadIntent{ID: "expired-media-upload-" + current.Format("20060102150405.000000000"), OwnerUID: "owner", ObjectKey: "missing-expired-upload", ExpiresAt: current.Add(-time.Minute).Format(time.RFC3339Nano), CreatedAt: current.Format(time.RFC3339Nano)}
	completed := model.MediaUploadIntent{ID: "completed-media-upload-" + current.Format("20060102150405.000000000"), OwnerUID: "owner", ObjectKey: "completed-upload", ExpiresAt: current.Add(-time.Minute).Format(time.RFC3339Nano), CompletedMediaID: "media-still-audited", CompletedAt: current.Format(time.RFC3339Nano), CreatedAt: current.Format(time.RFC3339Nano)}
	for _, item := range []model.MediaUploadIntent{expired, completed} {
		if err := repository.SaveMediaUploadIntent(item); err != nil {
			t.Fatal(err)
		}
	}
	if err := service.CleanupExpiredMediaUploadIntents(current); err != nil {
		t.Fatal(err)
	}
	if _, found, err := repository.GetMediaUploadIntentForOwner(expired.ID, expired.OwnerUID); err != nil || found {
		t.Fatalf("expired intent found=%t err=%v", found, err)
	}
	if _, found, err := repository.GetMediaUploadIntentForOwner(completed.ID, completed.OwnerUID); err != nil || !found {
		t.Fatalf("completed intent found=%t err=%v", found, err)
	}
}

func TestMediaUploadIntentCompletesOneDirectOSSUploadExactlyOnce(t *testing.T) {
	type object struct {
		body        []byte
		contentType string
	}
	objects := map[string]object{}
	ossServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := strings.TrimPrefix(r.URL.Path, "/")
		switch r.Method {
		case http.MethodPut:
			body, _ := io.ReadAll(r.Body)
			objects[key] = object{body: body, contentType: r.Header.Get("Content-Type")}
			w.WriteHeader(http.StatusOK)
		case http.MethodHead:
			item, found := objects[key]
			if !found {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			w.Header().Set("Content-Type", item.contentType)
			w.Header().Set("Content-Length", fmt.Sprint(len(item.body)))
			w.WriteHeader(http.StatusOK)
		case http.MethodGet:
			item, found := objects[key]
			if !found {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			w.Header().Set("Content-Type", item.contentType)
			_, _ = w.Write(item.body)
		case http.MethodDelete:
			delete(objects, key)
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	}))
	defer ossServer.Close()
	previousConfig := config.Cfg
	config.Cfg.MediaStorage = "oss"
	config.Cfg.OSSRegion = "cn-hongkong"
	config.Cfg.OSSBucket = "test-bucket"
	config.Cfg.OSSInternalEndpoint = ossServer.URL
	config.Cfg.OSSPublicEndpoint = ossServer.URL
	config.Cfg.OSSAccessKeyID = "test-key"
	config.Cfg.OSSAccessKeySecret = "test-secret"
	config.Cfg.OSSSignedURLTTL = "15m"
	t.Cleanup(func() { config.Cfg = previousConfig })

	image, err := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==")
	if err != nil {
		t.Fatal(err)
	}
	owner := "direct-upload-owner"
	intentRequest := httptest.NewRequest(http.MethodPost, "/api/v1/media/upload-intents", strings.NewReader(fmt.Sprintf(`{"filename":"direct.png","contentType":"image/png","bytes":%d,"intent":"library"}`, len(image))))
	intentRequest.Header.Set("Content-Type", "application/json")
	intentRequest.Header.Set("X-Portal-User-Uid", owner)
	intentResponse := httptest.NewRecorder()
	New().ServeHTTP(intentResponse, intentRequest)
	var intent struct {
		Data struct {
			Mode      string `json:"mode"`
			ID        string `json:"id"`
			UploadURL string `json:"uploadUrl"`
		} `json:"data"`
	}
	if intentResponse.Code != http.StatusOK || json.Unmarshal(intentResponse.Body.Bytes(), &intent) != nil || intent.Data.Mode != "direct" || intent.Data.ID == "" || intent.Data.UploadURL == "" {
		t.Fatalf("direct upload intent = %d/%s", intentResponse.Code, intentResponse.Body.String())
	}
	putRequest, err := http.NewRequest(http.MethodPut, intent.Data.UploadURL, bytes.NewReader(image))
	if err != nil {
		t.Fatal(err)
	}
	putRequest.Header.Set("Content-Type", "image/png")
	putResponse, err := http.DefaultClient.Do(putRequest)
	if err != nil || putResponse.StatusCode != http.StatusOK {
		if putResponse != nil {
			putResponse.Body.Close()
		}
		t.Fatalf("direct OSS put status=%v err=%v", putResponse, err)
	}
	putResponse.Body.Close()

	complete := func() *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, "/api/v1/media/upload-intents/"+intent.Data.ID+"/complete", nil)
		request.Header.Set("X-Portal-User-Uid", owner)
		response := httptest.NewRecorder()
		New().ServeHTTP(response, request)
		return response
	}
	first := complete()
	second := complete()
	var firstPayload, secondPayload struct {
		Data struct {
			MediaID string `json:"mediaId"`
		} `json:"data"`
	}
	if first.Code != http.StatusOK || second.Code != http.StatusOK || json.Unmarshal(first.Body.Bytes(), &firstPayload) != nil || json.Unmarshal(second.Body.Bytes(), &secondPayload) != nil || firstPayload.Data.MediaID == "" || firstPayload.Data.MediaID != secondPayload.Data.MediaID {
		t.Fatalf("completion responses = %d/%s and %d/%s", first.Code, first.Body.String(), second.Code, second.Body.String())
	}
	database, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	var count int64
	if err := database.Model(&model.Media{}).Where("id = ?", firstPayload.Data.MediaID).Count(&count).Error; err != nil || count != 1 {
		t.Fatalf("completed media count=%d err=%v", count, err)
	}

	invalidImage := []byte("not an image")
	invalidIntentRequest := httptest.NewRequest(http.MethodPost, "/api/v1/media/upload-intents", strings.NewReader(fmt.Sprintf(`{"filename":"invalid.png","contentType":"image/png","bytes":%d,"intent":"library"}`, len(invalidImage))))
	invalidIntentRequest.Header.Set("Content-Type", "application/json")
	invalidIntentRequest.Header.Set("X-Portal-User-Uid", owner)
	invalidIntentResponse := httptest.NewRecorder()
	New().ServeHTTP(invalidIntentResponse, invalidIntentRequest)
	var invalidIntent struct {
		Data struct {
			ID        string `json:"id"`
			UploadURL string `json:"uploadUrl"`
		} `json:"data"`
	}
	if invalidIntentResponse.Code != http.StatusOK || json.Unmarshal(invalidIntentResponse.Body.Bytes(), &invalidIntent) != nil || invalidIntent.Data.ID == "" {
		t.Fatalf("invalid-image intent = %d/%s", invalidIntentResponse.Code, invalidIntentResponse.Body.String())
	}
	invalidPut, err := http.NewRequest(http.MethodPut, invalidIntent.Data.UploadURL, bytes.NewReader(invalidImage))
	if err != nil {
		t.Fatal(err)
	}
	invalidPut.Header.Set("Content-Type", "image/png")
	invalidPutResponse, err := http.DefaultClient.Do(invalidPut)
	if err != nil || invalidPutResponse.StatusCode != http.StatusOK {
		if invalidPutResponse != nil {
			invalidPutResponse.Body.Close()
		}
		t.Fatalf("invalid-image OSS put status=%v err=%v", invalidPutResponse, err)
	}
	invalidPutResponse.Body.Close()
	invalidCompleteRequest := httptest.NewRequest(http.MethodPost, "/api/v1/media/upload-intents/"+invalidIntent.Data.ID+"/complete", nil)
	invalidCompleteRequest.Header.Set("X-Portal-User-Uid", owner)
	invalidCompleteResponse := httptest.NewRecorder()
	New().ServeHTTP(invalidCompleteResponse, invalidCompleteRequest)
	if invalidCompleteResponse.Code == http.StatusOK && strings.Contains(invalidCompleteResponse.Body.String(), `"code":0`) {
		t.Fatalf("invalid image completion unexpectedly succeeded: %s", invalidCompleteResponse.Body.String())
	}
}

func TestCanvasUploadCreatesPermanentLibraryMedia(t *testing.T) {
	owner := "canvas-upload-owner-" + time.Now().Format("20060102150405.000000000")
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	if err := writer.WriteField("intent", "canvas"); err != nil {
		t.Fatal(err)
	}
	header := textproto.MIMEHeader{}
	header.Set("Content-Disposition", `form-data; name="image"; filename="canvas.png"`)
	header.Set("Content-Type", "image/png")
	part, err := writer.CreatePart(header)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write([]byte("\x89PNG\r\n\x1a\n")); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/v1/media/images", body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	request.Header.Set("X-Portal-User-Uid", owner)
	response := httptest.NewRecorder()
	New().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("canvas upload = %d/%s", response.Code, response.Body.String())
	}
	var payload struct {
		Data struct {
			MediaID string `json:"mediaId"`
		} `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil || payload.Data.MediaID == "" {
		t.Fatalf("canvas upload payload = %s, err = %v", response.Body.String(), err)
	}
	item, found, err := repository.GetMedia(payload.Data.MediaID)
	if err != nil || !found {
		t.Fatalf("saved canvas media = %#v, found=%t, err=%v", item, found, err)
	}
	if item.Source != model.MediaSourceUpload || item.ExpiresAt != nil {
		t.Fatalf("canvas media = %#v, want permanent library media", item)
	}
	if !strings.Contains(item.ObjectKey, "/private/library/"+owner+"/") {
		t.Fatalf("canvas object key = %q", item.ObjectKey)
	}
}

func TestPromoteLegacyCanvasTemporaryMediaKeepsObjectKey(t *testing.T) {
	now := time.Now().UTC()
	expiresAt := now.Add(-time.Minute)
	item := model.Media{ID: "media-legacy-canvas-" + now.Format("20060102150405.000000000"), OwnerUID: "legacy-owner", Source: model.MediaSource("canvas_temporary"), ObjectKey: "images/private/canvas/legacy-owner/2026/08/image.png", ContentType: "image/png", ExpiresAt: &expiresAt, CreatedAt: now.Format(time.RFC3339Nano)}
	if _, err := repository.SaveMedia(item); err != nil {
		t.Fatal(err)
	}
	updated, err := repository.PromoteLegacyCanvasTemporaryMedia()
	if err != nil || updated < 1 {
		t.Fatalf("PromoteLegacyCanvasTemporaryMedia() = %d, %v", updated, err)
	}
	promoted, found, err := repository.GetMedia(item.ID)
	if err != nil || !found {
		t.Fatalf("promoted media found=%t err=%v", found, err)
	}
	if promoted.Source != model.MediaSourceUpload || promoted.ExpiresAt != nil || promoted.ObjectKey != item.ObjectKey {
		t.Fatalf("promoted media = %#v", promoted)
	}
}

func TestImageGenerationCreatesPersistentTaskWithoutForwardingModel(t *testing.T) {
	saveServiceSettingsForTest(t, model.Settings{AI: model.AISettings{
		Providers:       []model.AIProvider{{ID: "async-maizi", Name: "Maizi", Type: "maizi-image", Enabled: true, AspectRatios: []string{"1:1", "16:9"}, ImagePrices: []model.ImageResolutionPrice{{Resolution: "1k", Amount: decimal.RequireFromString("0.1234")}, {Resolution: "2k", Amount: decimal.RequireFromString("0.4567")}}, Config: json.RawMessage(`{"apiKey":"test-key","model":"gpt-image-2"}`)}},
		ImageProviderID: "async-maizi",
	}})
	clientRequestID := "async-create-" + time.Now().Format("20060102150405.000000000")
	request := httptest.NewRequest(http.MethodPost, "/api/v1/images/generations", bytes.NewBufferString(`{"clientRequestId":"`+clientRequestID+`","model":"browser-controlled-model","prompt":"生成一张测试图","n":1,"size":"1:1","resolution":"2k"}`))
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
	stored, found, err := repository.GetImageGenerationTask(created.Data.ID)
	if err != nil || !found || stored.ProviderName != "Maizi" || stored.Resolution != "2k" || !stored.AmountRecorded || !stored.Amount.Equal(decimal.RequireFromString("0.4567")) {
		t.Fatalf("image task price snapshot = %#v, found=%t, err=%v", stored, found, err)
	}

	unpriced := httptest.NewRequest(http.MethodPost, "/api/v1/images/generations", bytes.NewBufferString(`{"clientRequestId":"`+clientRequestID+`-unpriced","prompt":"不允许的分辨率","n":1,"size":"1:1","resolution":"4k"}`))
	unpriced.Header.Set("Content-Type", "application/json")
	unpriced.Header.Set("X-Portal-User-Uid", "async-owner")
	unpricedResponse := httptest.NewRecorder()
	New().ServeHTTP(unpricedResponse, unpriced)
	if unpricedResponse.Code != http.StatusOK || !strings.Contains(unpricedResponse.Body.String(), "未配置该分辨率") {
		t.Fatalf("unpriced resolution = %d/%s", unpricedResponse.Code, unpricedResponse.Body.String())
	}

	lookup := httptest.NewRequest(http.MethodGet, "/api/v1/images/tasks/by-client-request/"+clientRequestID, nil)
	lookup.Header.Set("X-Portal-User-Uid", "async-owner")
	lookedUp := httptest.NewRecorder()
	New().ServeHTTP(lookedUp, lookup)
	if lookedUp.Code != http.StatusOK || !strings.Contains(lookedUp.Body.String(), `"id":"`+created.Data.ID+`"`) {
		t.Fatalf("lookup image task = %d/%s", lookedUp.Code, lookedUp.Body.String())
	}
}

func TestImageGenerationRejectsAnIdempotencyKeyReusedForDifferentPayload(t *testing.T) {
	saveServiceSettingsForTest(t, model.Settings{AI: model.AISettings{
		Providers:       []model.AIProvider{{ID: "idempotency-image", Name: "Maizi", Type: "maizi-image", Enabled: true, AspectRatios: []string{"1:1"}, ImagePrices: []model.ImageResolutionPrice{{Resolution: "1k", Amount: decimal.RequireFromString("0.1234")}}, Config: json.RawMessage(`{"apiKey":"test-key","model":"gpt-image-2"}`)}},
		ImageProviderID: "idempotency-image",
	}})
	clientRequestID := "image-idempotency-payload-" + time.Now().Format("20060102150405.000000000")
	submit := func(prompt string) *httptest.ResponseRecorder {
		body, err := json.Marshal(map[string]any{"clientRequestId": clientRequestID, "prompt": prompt, "n": 1, "size": "1:1", "resolution": "1k"})
		if err != nil {
			t.Fatal(err)
		}
		request := httptest.NewRequest(http.MethodPost, "/api/v1/images/generations", bytes.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("X-Portal-User-Uid", "image-idempotency-owner")
		response := httptest.NewRecorder()
		New().ServeHTTP(response, request)
		return response
	}

	first := submit("生成红色汽车")
	replay := submit("生成红色汽车")
	conflict := submit("生成蓝色汽车")
	if first.Code != http.StatusOK || replay.Code != http.StatusOK {
		t.Fatalf("exact replay = first %d/%s, replay %d/%s", first.Code, first.Body.String(), replay.Code, replay.Body.String())
	}
	var firstPayload, replayPayload struct {
		Data struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if json.Unmarshal(first.Body.Bytes(), &firstPayload) != nil || json.Unmarshal(replay.Body.Bytes(), &replayPayload) != nil || firstPayload.Data.ID == "" || replayPayload.Data.ID != firstPayload.Data.ID {
		t.Fatalf("exact replay returned different task: first=%s replay=%s", first.Body.String(), replay.Body.String())
	}
	if conflict.Code != http.StatusConflict || !strings.Contains(conflict.Body.String(), "客户端请求 ID 已用于不同生成请求") {
		t.Fatalf("different payload = %d/%s, want 409 conflict", conflict.Code, conflict.Body.String())
	}
}

func TestPublicGenerationRoutesRejectReservedWorkflowRequestIDs(t *testing.T) {
	const owner = "reserved-workflow-request-owner"

	imageRequestID := "workflow-public-image-request"
	imageRequest := httptest.NewRequest(http.MethodPost, "/api/v1/images/generations", strings.NewReader(`{"clientRequestId":" `+imageRequestID+` ","prompt":"should not run","n":1}`))
	imageRequest.Header.Set("Content-Type", "application/json")
	imageRequest.Header.Set("X-Portal-User-Uid", owner)
	imageResponse := httptest.NewRecorder()
	New().ServeHTTP(imageResponse, imageRequest)
	if imageResponse.Code != http.StatusBadRequest || !strings.Contains(imageResponse.Body.String(), `"code":1`) {
		t.Fatalf("reserved image generation request = %d/%s", imageResponse.Code, imageResponse.Body.String())
	}
	if task, found, err := repository.GetImageGenerationTaskByClientRequest(owner, imageRequestID); err != nil || found {
		t.Fatalf("reserved image generation persisted task = %#v, found=%t, err=%v", task, found, err)
	}

	editRequestID := "workflow-public-image-edit-request"
	editBody := &bytes.Buffer{}
	editWriter := multipart.NewWriter(editBody)
	if err := editWriter.WriteField("clientRequestId", " "+editRequestID+" "); err != nil {
		t.Fatal(err)
	}
	if err := editWriter.Close(); err != nil {
		t.Fatal(err)
	}
	editRequest := httptest.NewRequest(http.MethodPost, "/api/v1/images/edits", editBody)
	editRequest.Header.Set("Content-Type", editWriter.FormDataContentType())
	editRequest.Header.Set("X-Portal-User-Uid", owner)
	editResponse := httptest.NewRecorder()
	New().ServeHTTP(editResponse, editRequest)
	if editResponse.Code != http.StatusBadRequest || !strings.Contains(editResponse.Body.String(), `"code":1`) {
		t.Fatalf("reserved image edit request = %d/%s", editResponse.Code, editResponse.Body.String())
	}
	if task, found, err := repository.GetImageGenerationTaskByClientRequest(owner, editRequestID); err != nil || found {
		t.Fatalf("reserved image edit persisted task = %#v, found=%t, err=%v", task, found, err)
	}

	videoRequestID := "workflow-public-video-request"
	videoRequest := httptest.NewRequest(http.MethodPost, "/api/v1/videos", strings.NewReader(`{"clientRequestId":" `+videoRequestID+` ","prompt":"should not run","seconds":4,"size":"16:9","resolution":"720p"}`))
	videoRequest.Header.Set("Content-Type", "application/json")
	videoRequest.Header.Set("X-Portal-User-Uid", owner)
	videoResponse := httptest.NewRecorder()
	New().ServeHTTP(videoResponse, videoRequest)
	if videoResponse.Code != http.StatusBadRequest || !strings.Contains(videoResponse.Body.String(), `"code":1`) {
		t.Fatalf("reserved video request = %d/%s", videoResponse.Code, videoResponse.Body.String())
	}
	if task, found, err := repository.GetVideoGenerationTaskByClient(owner, videoRequestID); err != nil || found {
		t.Fatalf("reserved video generation persisted task = %#v, found=%t, err=%v", task, found, err)
	}
}

func TestImageEditPersistsPNGMaskAndOutputSnapshot(t *testing.T) {
	saveServiceSettingsForTest(t, model.Settings{AI: model.AISettings{
		Providers:       []model.AIProvider{{ID: "async-maizi-mask", Name: "Maizi", Type: "maizi-image", Enabled: true, AspectRatios: []string{"1:1", "16:9"}, ImagePrices: []model.ImageResolutionPrice{{Resolution: "2K", Amount: decimal.Zero}}, Config: json.RawMessage(`{"apiKey":"test-key","model":"gpt-image-2"}`)}},
		ImageProviderID: "async-maizi-mask",
	}})
	clientRequestID := "async-mask-" + time.Now().Format("20060102150405.000000000")
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	_ = writer.WriteField("clientRequestId", clientRequestID)
	_ = writer.WriteField("prompt", "只替换白色遮罩区域")
	_ = writer.WriteField("n", "1")
	_ = writer.WriteField("resolution", "2K")
	_ = writer.WriteField("output_format", "png")
	_ = writer.WriteField("background", "transparent")
	for index := 0; index < 7; index++ {
		referenceHeader := textproto.MIMEHeader{}
		referenceHeader.Set("Content-Disposition", fmt.Sprintf(`form-data; name="image"; filename="reference-%d.png"`, index))
		referenceHeader.Set("Content-Type", "image/png")
		reference, err := writer.CreatePart(referenceHeader)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := reference.Write([]byte("\x89PNG\r\n\x1a\n")); err != nil {
			t.Fatal(err)
		}
	}
	maskHeader := textproto.MIMEHeader{}
	maskHeader.Set("Content-Disposition", `form-data; name="mask"; filename="mask.png"`)
	maskHeader.Set("Content-Type", "image/png")
	mask, err := writer.CreatePart(maskHeader)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := mask.Write([]byte("\x89PNG\r\n\x1a\n")); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/v1/images/edits", body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	request.Header.Set("X-Portal-User-Uid", "async-mask-owner")
	response := httptest.NewRecorder()
	New().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("create masked image task = %d/%s", response.Code, response.Body.String())
	}
	task, found, err := repository.GetImageGenerationTaskByClientRequest("async-mask-owner", clientRequestID)
	if err != nil || !found {
		t.Fatalf("saved masked task = %#v, found=%t, err=%v", task, found, err)
	}
	if task.OutputFormat != "png" || task.Background != "transparent" {
		t.Fatalf("task output = %q/%q, want png/transparent", task.OutputFormat, task.Background)
	}
	var inputs []service.ImageTaskInput
	if err := json.Unmarshal([]byte(task.ReferencesJSON), &inputs); err != nil {
		t.Fatal(err)
	}
	if len(inputs) != 8 || inputs[7].Purpose != "mask" {
		t.Fatalf("task inputs = %#v, want seven images and one mask", inputs)
	}
	for index := 0; index < 7; index++ {
		if inputs[index].Purpose != "image" || inputs[index].Name != fmt.Sprintf("reference-%d.png", index) {
			t.Fatalf("task image %d = %#v, want ordered reference", index, inputs[index])
		}
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

func TestPrivateMediaCatalogFiltersVideosAndKeepsTheDefaultImageOnly(t *testing.T) {
	const owner = "private-media-kind-owner"
	createdAt := time.Now().Format(time.RFC3339Nano)
	expiresAt := time.Now().UTC().Add(time.Hour)
	items := []model.Media{
		{ID: "private-kind-image", OwnerUID: owner, Source: model.MediaSourceUpload, ObjectKey: "images/private/private-media-kind-owner/image.png", ContentType: "image/png", CreatedAt: createdAt},
		{ID: "private-kind-video", OwnerUID: owner, Source: model.MediaSourceUpload, ObjectKey: "videos/private/private-media-kind-owner/video.mp4", ContentType: "video/mp4", CreatedAt: createdAt},
		{ID: "private-kind-other-video", OwnerUID: "private-media-kind-other", Source: model.MediaSourceUpload, ObjectKey: "videos/private/private-media-kind-other/video.mp4", ContentType: "video/mp4", CreatedAt: createdAt},
		{ID: "private-kind-expiring-video", OwnerUID: owner, Source: model.MediaSourceUpload, ObjectKey: "videos/private/private-media-kind-owner/expiring.mp4", ContentType: "video/mp4", ExpiresAt: &expiresAt, CreatedAt: createdAt},
		{ID: "private-kind-deleting-video", OwnerUID: owner, Source: model.MediaSourceUpload, ObjectKey: "videos/private/private-media-kind-owner/deleting.mp4", ContentType: "video/mp4", CleanupStatus: model.MediaCleanupDeleting, CreatedAt: createdAt},
		{ID: "private-kind-public-video", OwnerUID: owner, Source: model.MediaSourceUpload, ObjectKey: "videos/public/private-media-kind-owner/public.mp4", ContentType: "video/mp4", CreatedAt: createdAt},
	}
	for _, item := range items {
		if _, err := repository.SaveMedia(item); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := repository.SavePublicImage(model.PublicImage{ID: "private-kind-public-record", MediaID: "private-kind-public-video", UploaderUID: owner, Title: "public", CreatedAt: createdAt}); err != nil {
		t.Fatal(err)
	}

	readIDs := func(path string) ([]string, *httptest.ResponseRecorder) {
		t.Helper()
		request := httptest.NewRequest(http.MethodGet, path, nil)
		request.Header.Set("X-Portal-User-Uid", owner)
		response := httptest.NewRecorder()
		New().ServeHTTP(response, request)
		var payload struct {
			Code int `json:"code"`
			Data struct {
				Items []model.Media `json:"items"`
				Total int           `json:"total"`
			} `json:"data"`
		}
		if response.Code == http.StatusOK && json.Unmarshal(response.Body.Bytes(), &payload) == nil && payload.Code == 0 {
			ids := make([]string, 0, len(payload.Data.Items))
			for _, item := range payload.Data.Items {
				ids = append(ids, item.ID)
			}
			if payload.Data.Total != len(ids) {
				t.Fatalf("private media total = %d, items = %v", payload.Data.Total, ids)
			}
			return ids, response
		}
		return nil, response
	}

	for _, path := range []string{"/api/v1/private-images", "/api/v1/private-images?kind=image"} {
		ids, response := readIDs(path)
		if response.Code != http.StatusOK || len(ids) != 1 || ids[0] != "private-kind-image" {
			t.Fatalf("image catalog %s = %d/%s, ids=%v", path, response.Code, response.Body.String(), ids)
		}
	}
	videoIDs, videoResponse := readIDs("/api/v1/private-images?kind=video")
	if videoResponse.Code != http.StatusOK || len(videoIDs) != 1 || videoIDs[0] != "private-kind-video" {
		t.Fatalf("video catalog = %d/%s, ids=%v", videoResponse.Code, videoResponse.Body.String(), videoIDs)
	}
	_, invalidResponse := readIDs("/api/v1/private-images?kind=audio")
	if invalidResponse.Code != http.StatusBadRequest || !strings.Contains(invalidResponse.Body.String(), `"code":1`) {
		t.Fatalf("invalid private media kind = %d/%s", invalidResponse.Code, invalidResponse.Body.String())
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
	const adminUID = "operation-log-route-admin"
	request := httptest.NewRequest(http.MethodGet, "/api/admin/operation-logs", nil)
	request.Header.Set("X-Portal-User-Uid", "operation-log-route-member")
	response := httptest.NewRecorder()
	New().ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("non-admin status = %d, want %d; body = %s", response.Code, http.StatusForbidden, response.Body.String())
	}

	grantLocalAppRole(t, adminUID, model.AppRoleAdmin, true)
	request = httptest.NewRequest(http.MethodGet, "/api/admin/operation-logs", nil)
	request.Header.Set("X-Portal-User-Uid", adminUID)
	response = httptest.NewRecorder()
	New().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("admin status = %d, want %d; body = %s", response.Code, http.StatusOK, response.Body.String())
	}
}

func TestStatisticsRouteIsAdminOnlyAndReturnsRangeAndUserBreakdown(t *testing.T) {
	const adminUID = "statistics-admin"
	stamp := time.Now().UTC().Format("20060102150405.000000000")
	database, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Create(&model.ImageGenerationTask{
		ID: "statistics-" + stamp, OwnerUID: "statistics-user", ClientRequestID: "statistics-" + stamp,
		Status: model.ImageTaskSucceeded, ProviderID: "statistics-provider", ProviderName: "统计模型",
		Amount: decimal.RequireFromString("0.1234"), AmountRecorded: true, ResultMediaIDsJSON: `["statistics-media"]`, FinishedAt: time.Now().UTC().Format(time.RFC3339),
	}).Error; err != nil {
		t.Fatal(err)
	}

	denied := httptest.NewRequest(http.MethodGet, "/api/admin/statistics", nil)
	denied.Header.Set("X-Portal-User-Uid", "ordinary-member")
	deniedResponse := httptest.NewRecorder()
	New().ServeHTTP(deniedResponse, denied)
	if deniedResponse.Code != http.StatusForbidden {
		t.Fatalf("non-admin statistics status = %d, want %d; body = %s", deniedResponse.Code, http.StatusForbidden, deniedResponse.Body.String())
	}

	request := httptest.NewRequest(http.MethodGet, "/api/admin/statistics?start="+time.Now().In(time.FixedZone("CST", 8*60*60)).Format("2006-01-02")+"&end="+time.Now().In(time.FixedZone("CST", 8*60*60)).Format("2006-01-02"), nil)
	grantLocalAppRole(t, adminUID, model.AppRoleAdmin, true)
	request.Header.Set("X-Portal-User-Uid", adminUID)
	response := httptest.NewRecorder()
	New().ServeHTTP(response, request)
	var payload struct {
		Code int `json:"code"`
		Data struct {
			StartDate string `json:"startDate"`
			EndDate   string `json:"endDate"`
			Amount    string `json:"amount"`
			Models    []struct {
				ProviderID string `json:"providerId"`
				Amount     string `json:"amount"`
			} `json:"models"`
			Users []struct {
				UserUID string `json:"userUid"`
				Models  []struct {
					ProviderID string `json:"providerId"`
				} `json:"models"`
			} `json:"users"`
		} `json:"data"`
	}
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &payload) != nil || payload.Code != 0 || payload.Data.Amount == "" || payload.Data.StartDate == "" || payload.Data.EndDate == "" {
		t.Fatalf("statistics status/body = %d/%s", response.Code, response.Body.String())
	}
	for _, item := range payload.Data.Models {
		if item.ProviderID == "statistics-provider" && item.Amount == "0.1234" {
			for _, user := range payload.Data.Users {
				if user.UserUID == "statistics-user" && len(user.Models) == 1 && user.Models[0].ProviderID == "statistics-provider" {
					return
				}
			}
			break
		}
	}
	t.Fatalf("statistics provider snapshot missing: %+v", payload.Data.Models)
}

func TestPortalMemberListRouteIsAdminOnlyAndReturnsSynchronizedMembers(t *testing.T) {
	const adminUID = "member-list-admin"
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
	grantLocalAppRole(t, adminUID, model.AppRoleAdmin, true)
	request.Header.Set("X-Portal-User-Uid", adminUID)
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
	const adminUID = "directory-admin"
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
	grantLocalAppRole(t, adminUID, model.AppRoleAdmin, true)
	manual.Header.Set("X-Portal-User-Uid", adminUID)
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
	if err != nil || !found || member.Enabled || strings.Join(member.Roles, ",") != "设计师" {
		t.Fatalf("disabled member = %+v, found=%t, err=%v", member, found, err)
	}
	listed, total, err := repository.ListPortalMembers(model.PortalMemberQuery{Query: "李小明", Page: 1, PageSize: 20})
	if err != nil || total != 0 || len(listed) != 0 {
		t.Fatalf("disabled member must be hidden from member management: %#v, total=%d, err=%v", listed, total, err)
	}
	recipients, total, err := repository.ListCanvasShareRecipients("different-user", model.PortalMemberQuery{Query: "李小明", Page: 1, PageSize: 20})
	if err != nil || total != 0 || len(recipients) != 0 {
		t.Fatalf("disabled member must be hidden from share recipients: %#v, total=%d, err=%v", recipients, total, err)
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

func TestPortalSessionExposesPublicAssetManagementCapability(t *testing.T) {
	tests := []struct {
		name                   string
		appRole                model.AppRole
		enabled                bool
		gatewayRoles           string
		wantAdmin              bool
		wantPublicAssetManager bool
	}{
		{name: "regular member", appRole: model.AppRoleMember, enabled: true, gatewayRoles: "portal-admin"},
		{name: "public asset manager", appRole: model.AppRolePublicAssetsManager, enabled: true, gatewayRoles: "member", wantPublicAssetManager: true},
		{name: "local admin", appRole: model.AppRoleAdmin, enabled: true, gatewayRoles: "design-team", wantAdmin: true, wantPublicAssetManager: true},
		{name: "disabled local admin", appRole: model.AppRoleAdmin, enabled: false, gatewayRoles: "portal-admin", wantAdmin: false, wantPublicAssetManager: false},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			userUID := "session-role-" + strings.ReplaceAll(test.name, " ", "-")
			grantLocalAppRole(t, userUID, test.appRole, test.enabled)
			request := httptest.NewRequest(http.MethodGet, "/api/session", nil)
			request.Header.Set("X-Portal-User-Uid", userUID)
			request.Header.Set("X-Portal-Roles", test.gatewayRoles)
			response := httptest.NewRecorder()
			New().ServeHTTP(response, request)

			var payload struct {
				Data struct {
					AppRole               model.AppRole `json:"appRole"`
					IsAdmin               bool          `json:"isAdmin"`
					CanManagePublicAssets bool          `json:"canManagePublicAssets"`
					User                  struct {
						Roles []string `json:"roles"`
					} `json:"user"`
				} `json:"data"`
			}
			if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &payload) != nil {
				t.Fatalf("session status/body = %d/%s", response.Code, response.Body.String())
			}
			if got := response.Header().Get("Cache-Control"); got != "no-store" {
				t.Fatalf("session Cache-Control = %q, want no-store", got)
			}
			wantRole := test.appRole
			if !test.enabled {
				wantRole = model.AppRoleMember
			}
			if payload.Data.AppRole != wantRole || payload.Data.IsAdmin != test.wantAdmin || payload.Data.CanManagePublicAssets != test.wantPublicAssetManager {
				t.Fatalf("session permissions = role:%q admin:%t publicAssets:%t, want role:%q admin:%t publicAssets:%t", payload.Data.AppRole, payload.Data.IsAdmin, payload.Data.CanManagePublicAssets, wantRole, test.wantAdmin, test.wantPublicAssetManager)
			}
			if len(payload.Data.User.Roles) != 1 || payload.Data.User.Roles[0] != test.gatewayRoles {
				t.Fatalf("raw Gateway roles = %#v, want [%q]", payload.Data.User.Roles, test.gatewayRoles)
			}
		})
	}
}

func TestLocalPublicAssetsManagerCanManagePublicAssetsButNotOtherAdminRoutes(t *testing.T) {
	const memberUID = "public-assets-member"
	const managerUID = "public-assets-manager"
	const adminUID = "public-assets-admin"
	grantLocalAppRole(t, memberUID, model.AppRoleMember, true)
	grantLocalAppRole(t, managerUID, model.AppRolePublicAssetsManager, true)
	grantLocalAppRole(t, adminUID, model.AppRoleAdmin, true)

	request := func(method, path, body, uid string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, bytes.NewBufferString(body))
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		req.Header.Set("X-Portal-User-Uid", uid)
		res := httptest.NewRecorder()
		New().ServeHTTP(res, req)
		return res
	}

	member := request(http.MethodPost, "/api/admin/public-folders", `{"title":"普通成员无权目录"}`, memberUID)
	if member.Code != http.StatusForbidden {
		t.Fatalf("regular member create status = %d, want %d; body = %s", member.Code, http.StatusForbidden, member.Body.String())
	}

	manager := request(http.MethodPost, "/api/admin/public-folders", `{"title":"素材管理员目录"}`, managerUID)
	if manager.Code != http.StatusOK {
		t.Fatalf("asset manager create status = %d, want %d; body = %s", manager.Code, http.StatusOK, manager.Body.String())
	}
	var created struct {
		Data model.PublicFolder `json:"data"`
	}
	if err := json.Unmarshal(manager.Body.Bytes(), &created); err != nil || created.Data.ID == "" {
		t.Fatalf("asset manager create payload = %s, err = %v", manager.Body.String(), err)
	}

	renamed := request(http.MethodPatch, "/api/admin/public-folders/"+created.Data.ID, `{"title":"素材管理员重命名目录"}`, managerUID)
	if renamed.Code != http.StatusOK {
		t.Fatalf("asset manager rename status = %d, want %d; body = %s", renamed.Code, http.StatusOK, renamed.Body.String())
	}
	deleted := request(http.MethodDelete, "/api/admin/public-folders/"+created.Data.ID, "", managerUID)
	if deleted.Code != http.StatusOK {
		t.Fatalf("asset manager delete status = %d, want %d; body = %s", deleted.Code, http.StatusOK, deleted.Body.String())
	}
	if _, err := repository.SaveMedia(model.Media{ID: "media-public-assets-manager", OwnerUID: "public-assets-admin", ObjectKey: "images/public/assets-manager.png", ContentType: "image/png"}); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.SavePublicImage(model.PublicImage{ID: "public-image-assets-manager", MediaID: "media-public-assets-manager", Title: "原名称", UploaderUID: "public-assets-admin"}); err != nil {
		t.Fatal(err)
	}
	imageUpdated := request(http.MethodPatch, "/api/admin/public-images/public-image-assets-manager", `{"title":"素材管理员修改图片"}`, managerUID)
	if imageUpdated.Code != http.StatusOK {
		t.Fatalf("asset manager image update status = %d, want %d; body = %s", imageUpdated.Code, http.StatusOK, imageUpdated.Body.String())
	}

	admin := request(http.MethodPost, "/api/admin/public-folders", `{"title":"管理员目录"}`, adminUID)
	if admin.Code != http.StatusOK {
		t.Fatalf("portal admin create status = %d, want %d; body = %s", admin.Code, http.StatusOK, admin.Body.String())
	}

	otherAdminRoute := request(http.MethodGet, "/api/admin/me", "", managerUID)
	if otherAdminRoute.Code != http.StatusForbidden {
		t.Fatalf("asset manager unrelated admin route status = %d, want %d; body = %s", otherAdminRoute.Code, http.StatusForbidden, otherAdminRoute.Body.String())
	}
}

func TestRegularMemberCannotUseAnyPublicAssetMutationRoute(t *testing.T) {
	const memberUID = "regular-public-assets-member"
	grantLocalAppRole(t, memberUID, model.AppRoleMember, true)
	routes := []struct {
		method string
		path   string
		body   string
	}{
		{method: http.MethodPost, path: "/api/admin/public-images"},
		{method: http.MethodPost, path: "/api/admin/public-folders", body: `{"title":"无权限"}`},
		{method: http.MethodPatch, path: "/api/admin/public-folders/forbidden-folder", body: `{"title":"无权限"}`},
		{method: http.MethodDelete, path: "/api/admin/public-folders/forbidden-folder"},
		{method: http.MethodPatch, path: "/api/admin/public-images/forbidden-image", body: `{"title":"无权限"}`},
		{method: http.MethodDelete, path: "/api/admin/public-images/forbidden-image"},
	}

	for _, route := range routes {
		t.Run(route.method+" "+route.path, func(t *testing.T) {
			request := httptest.NewRequest(route.method, route.path, strings.NewReader(route.body))
			if route.body != "" {
				request.Header.Set("Content-Type", "application/json")
			}
			request.Header.Set("X-Portal-User-Uid", memberUID)
			response := httptest.NewRecorder()
			New().ServeHTTP(response, request)
			if response.Code != http.StatusForbidden {
				t.Fatalf("regular member status = %d, want %d; body = %s", response.Code, http.StatusForbidden, response.Body.String())
			}
		})
	}
}

func TestLocalPublicAssetsManagerCanUploadAndDeletePublicImages(t *testing.T) {
	const uploadManagerUID = "public-assets-manager-upload"
	const deleteManagerUID = "public-assets-manager-delete"
	grantLocalAppRole(t, uploadManagerUID, model.AppRolePublicAssetsManager, true)
	grantLocalAppRole(t, deleteManagerUID, model.AppRolePublicAssetsManager, true)
	pngData, err := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLxgAAAAABJRU5ErkJggg==")
	if err != nil {
		t.Fatal(err)
	}

	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	part, err := writer.CreateFormFile("image", "manager-upload.png")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(pngData); err != nil {
		t.Fatal(err)
	}
	if err := writer.WriteField("title", "素材管理员上传"); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	uploadRequest := httptest.NewRequest(http.MethodPost, "/api/admin/public-images", body)
	uploadRequest.Header.Set("Content-Type", writer.FormDataContentType())
	uploadRequest.Header.Set("X-Portal-User-Uid", uploadManagerUID)
	uploadResponse := httptest.NewRecorder()
	New().ServeHTTP(uploadResponse, uploadRequest)
	if uploadResponse.Code != http.StatusOK {
		t.Fatalf("manager upload status = %d, want %d; body = %s", uploadResponse.Code, http.StatusOK, uploadResponse.Body.String())
	}
	var uploaded struct {
		Data struct {
			Item model.PublicImage `json:"item"`
		} `json:"data"`
	}
	if err := json.Unmarshal(uploadResponse.Body.Bytes(), &uploaded); err != nil {
		t.Fatal(err)
	}
	if uploaded.Data.Item.ID == "" || uploaded.Data.Item.Title != "素材管理员上传" {
		t.Fatalf("manager upload item = %+v; body = %s", uploaded.Data.Item, uploadResponse.Body.String())
	}

	media := model.Media{ID: "media-public-assets-manager-delete", OwnerUID: "public-assets-manager-delete", ObjectKey: "images/public/manager-delete.png", ContentType: "image/png"}
	publicImage := model.PublicImage{ID: "public-image-assets-manager-delete", MediaID: media.ID, Title: "待删除素材", UploaderUID: media.OwnerUID}
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

	deleteRequest := httptest.NewRequest(http.MethodDelete, "/api/admin/public-images/"+publicImage.ID, nil)
	deleteRequest.Header.Set("X-Portal-User-Uid", deleteManagerUID)
	deleteResponse := httptest.NewRecorder()
	New().ServeHTTP(deleteResponse, deleteRequest)
	if deleteResponse.Code != http.StatusOK {
		t.Fatalf("manager delete status = %d, want %d; body = %s", deleteResponse.Code, http.StatusOK, deleteResponse.Body.String())
	}
	if _, err := os.Stat(objectPath); !os.IsNotExist(err) {
		t.Fatalf("manager delete left object in place: %v", err)
	}
	if _, found, err := repository.GetPublicImage(publicImage.ID); err != nil || found {
		t.Fatalf("manager delete public image found=%t err=%v", found, err)
	}
	if _, found, err := repository.GetMedia(media.ID); err != nil || found {
		t.Fatalf("manager delete media found=%t err=%v", found, err)
	}
}

func TestGatewayPublicAssetManagerRolesDoNotGrantLocalAuthorization(t *testing.T) {
	const localManagerUID = "configured-local-public-assets-manager"
	const gatewayManagerUID = "gateway-public-assets-manager-only"
	grantLocalAppRole(t, localManagerUID, model.AppRolePublicAssetsManager, true)
	grantLocalAppRole(t, gatewayManagerUID, model.AppRoleMember, true)

	request := func(uid, roles string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, "/api/admin/public-folders", strings.NewReader(`{"title":"自定义公共素材角色"}`))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("X-Portal-User-Uid", uid)
		request.Header.Set("X-Portal-Roles", roles)
		response := httptest.NewRecorder()
		New().ServeHTTP(response, request)
		return response
	}

	if response := request(localManagerUID, "member"); response.Code != http.StatusOK {
		t.Fatalf("local manager status = %d, want %d; body = %s", response.Code, http.StatusOK, response.Body.String())
	}
	if response := request(gatewayManagerUID, "portal-public-assets-manager,portal-admin"); response.Code != http.StatusForbidden {
		t.Fatalf("Gateway-only manager status = %d, want %d; body = %s", response.Code, http.StatusForbidden, response.Body.String())
	}
}

func TestOperationLogListsAuditedWriteAndCleansExpiredEntries(t *testing.T) {
	const adminUID = "audit-admin"
	grantLocalAppRole(t, adminUID, model.AppRoleAdmin, true)
	request := httptest.NewRequest(http.MethodPost, "/api/admin/public-folders", bytes.NewBufferString(`{"title":"审计目录"}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Portal-User-Uid", adminUID)
	request.Header.Set("X-Portal-Username", adminUID)
	response := httptest.NewRecorder()
	New().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("create status = %d, body = %s", response.Code, response.Body.String())
	}

	request = httptest.NewRequest(http.MethodGet, "/api/admin/operation-logs?action=public_folder_create&actor=audit-admin", nil)
	request.Header.Set("X-Portal-User-Uid", adminUID)
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
	requestSummary := `{"method":"POST","endpoint":"https://www.maizitech.xyz/v1/images/generations","contentType":"application/json","jsonBody":{"images":["data:image/png;base64,<base64>"]}}`
	if err := repository.SaveOperationLog(model.OperationLog{ID: "operation-request-summary", ActorUID: "audit-admin", ActorName: "审计", Action: "image_edit", Status: model.OperationStatusSuccess, RequestSummary: requestSummary, CreatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	request = httptest.NewRequest(http.MethodGet, "/api/admin/operation-logs?action=image_edit&actor=audit-admin", nil)
	request.Header.Set("X-Portal-User-Uid", adminUID)
	response = httptest.NewRecorder()
	New().ServeHTTP(response, request)
	var summaryPayload struct {
		Data model.OperationLogList `json:"data"`
	}
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &summaryPayload) != nil || len(summaryPayload.Data.Items) != 1 || summaryPayload.Data.Items[0].RequestSummary != requestSummary {
		t.Fatalf("operation request summary = %d/%s", response.Code, response.Body.String())
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

func TestPrivateMediaDeleteKeepsRecordAndReturnsSafeMessageWhenStorageIsUnavailable(t *testing.T) {
	item := model.Media{ID: "media-private-delete-storage-failure", OwnerUID: "owner", ObjectKey: "images/private/owner/unavailable.png", ContentType: "image/png"}
	if _, err := repository.SaveMedia(item); err != nil {
		t.Fatal(err)
	}
	previousStorage := config.Cfg.MediaStorage
	config.Cfg.MediaStorage = "unavailable"
	t.Cleanup(func() { config.Cfg.MediaStorage = previousStorage })

	request := httptest.NewRequest(http.MethodDelete, "/api/v1/media/"+item.ID, nil)
	request.Header.Set("X-Portal-User-Uid", item.OwnerUID)
	response := httptest.NewRecorder()
	New().ServeHTTP(response, request)

	var body struct {
		Code int    `json:"code"`
		Msg  string `json:"msg"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Code != 1 || body.Msg != "删除图片失败，请稍后重试" {
		t.Fatalf("storage failure response = %#v, body = %s", body, response.Body.String())
	}
	if _, found, err := repository.GetMedia(item.ID); err != nil || !found {
		t.Fatalf("storage failure must retain media record, found=%t err=%v", found, err)
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
	grantLocalAppRole(t, "admin", model.AppRoleAdmin, true)
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
	grantLocalAppRole(t, "admin", model.AppRoleAdmin, true)
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
	grantLocalAppRole(t, "folder-member", model.AppRoleMember, true)
	grantLocalAppRole(t, "folder-admin", model.AppRoleAdmin, true)
	create := func(body string, admin bool) (*httptest.ResponseRecorder, model.PublicFolder) {
		req := httptest.NewRequest(http.MethodPost, "/api/admin/public-folders", bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		userUID := "folder-member"
		if admin {
			userUID = "folder-admin"
		}
		req.Header.Set("X-Portal-User-Uid", userUID)
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
	grantLocalAppRole(t, "public-image-update-member", model.AppRoleMember, true)
	grantLocalAppRole(t, "admin", model.AppRoleAdmin, true)
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
	req.Header.Set("X-Portal-User-Uid", "public-image-update-member")
	res := httptest.NewRecorder()
	New().ServeHTTP(res, req)
	if res.Code != http.StatusForbidden {
		t.Fatalf("non-admin patch status = %d, want %d; body = %s", res.Code, http.StatusForbidden, res.Body.String())
	}

	req = httptest.NewRequest(http.MethodPatch, "/api/admin/public-images/public-move", bytes.NewBufferString(`{"title":"  新名称  ","folderId":"`+folder.ID+`"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Portal-User-Uid", "admin")
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
	grantLocalAppRole(t, "admin", model.AppRoleAdmin, true)
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
	grantLocalAppRole(t, "admin", model.AppRoleAdmin, true)
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
