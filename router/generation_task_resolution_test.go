package router

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

func TestGenerationTaskResolutionRequiresAdminAndValidRequest(t *testing.T) {
	owner, admin := fixtureUID("resolution-owner"), fixtureUID("resolution-admin")
	grantLocalAppRole(t, owner, model.AppRoleMember, true)
	grantLocalAppRole(t, admin, model.AppRoleAdmin, true)
	db, _ := repository.DB()
	task := model.ImageGenerationTask{ID: "resolution-route-task", OwnerUID: owner, ClientRequestID: "resolution-route-request", Status: model.ImageTaskUncertain}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = repository.DeleteImageGenerationTask(task.ID) })
	request := func(user, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, "/api/admin/generation-tasks/image/"+task.ID+"/resolve", strings.NewReader(body))
		r.Header.Set("X-Portal-User-Uid", user)
		r.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		servePortalRequest(response, r)
		return response
	}
	if response := request(owner, `{"action":"close","reason":"确认失败"}`); response.Code != http.StatusForbidden {
		t.Fatalf("non-admin resolution=%d %s", response.Code, response.Body.String())
	}
	for _, body := range []string{`{"action":"close","reason":"ok","extra":true}`, `{"action":"close"} {}`, strings.Repeat("x", 9<<10)} {
		if response := request(admin, body); response.Code != http.StatusBadRequest {
			t.Fatalf("invalid request=%d %s", response.Code, response.Body.String())
		}
	}
	for _, body := range []string{`{"action":"succeeded","reason":"verified"}`, `{"action":"attach","reason":"verified"}`, `{"action":"close","reason":""}`} {
		response := request(admin, body)
		var result struct{ Code int }
		if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil || result.Code == 0 {
			t.Fatalf("invalid decision accepted=%s err=%v", response.Body.String(), err)
		}
	}
	response := request(admin, `{"action":"close","reason":"供应商确认未受理"}`)
	var result struct{ Code int }
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil || result.Code != 0 {
		t.Fatalf("admin resolution=%s err=%v", response.Body.String(), err)
	}
	stored, _, _ := repository.GetImageGenerationTask(task.ID)
	if stored.Status != model.ImageTaskFailed {
		t.Fatalf("task not closed=%+v", stored)
	}
}
