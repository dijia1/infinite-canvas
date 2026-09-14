package router

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/basketikun/infinite-canvas/service"
)

type settingsRouteResponse struct {
	Code int             `json:"code"`
	Data json.RawMessage `json:"data"`
	Msg  string          `json:"msg"`
}

func requestAdminSettings(t *testing.T, method, userUID string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var requestBody *bytes.Reader
	if body == nil {
		requestBody = bytes.NewReader(nil)
	} else {
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		requestBody = bytes.NewReader(encoded)
	}
	request := httptest.NewRequest(method, "/api/admin/settings", requestBody)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Portal-User-Uid", userUID)
	response := httptest.NewRecorder()
	New().ServeHTTP(response, request)
	return response
}

func decodeSettingsRouteResponse(t *testing.T, response *httptest.ResponseRecorder) settingsRouteResponse {
	t.Helper()
	var payload settingsRouteResponse
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode settings response %d/%s: %v", response.Code, response.Body.String(), err)
	}
	return payload
}

func decodeAdminSettings(t *testing.T, response *httptest.ResponseRecorder) model.Settings {
	t.Helper()
	payload := decodeSettingsRouteResponse(t, response)
	var settings model.Settings
	if err := json.Unmarshal(payload.Data, &settings); err != nil {
		t.Fatalf("decode admin settings data %s: %v", payload.Data, err)
	}
	return settings
}

func saveServiceSettingsForTest(t *testing.T, settings model.Settings) model.Settings {
	t.Helper()
	current, err := repository.GetSettings()
	if err != nil {
		t.Fatal(err)
	}
	settings.Revision = current.Revision
	saved, err := service.SaveSettings(settings)
	if err != nil {
		t.Fatal(err)
	}
	return saved
}

func saveRepositorySettingsForTest(t *testing.T, settings model.Settings, stamp string) model.Settings {
	t.Helper()
	current, err := repository.GetSettings()
	if err != nil {
		t.Fatal(err)
	}
	settings.Revision = current.Revision
	saved, err := repository.SaveSettings(settings, stamp)
	if err != nil {
		t.Fatal(err)
	}
	return saved
}

func TestAdminSettingsRejectsStaleFullDocumentAndAuditsOnlyWinner(t *testing.T) {
	database, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Where("key = ?", model.SettingKeyAI).Delete(&model.Setting{}).Error; err != nil {
		t.Fatal(err)
	}
	if err := database.Where("action = ?", "ai_settings_save").Delete(&model.OperationLog{}).Error; err != nil {
		t.Fatal(err)
	}
	const adminA = "settings-cas-admin-a"
	const adminB = "settings-cas-admin-b"
	const manager = "settings-cas-assets-manager"
	grantLocalAppRole(t, adminA, model.AppRoleAdmin, true)
	grantLocalAppRole(t, adminB, model.AppRoleAdmin, true)
	grantLocalAppRole(t, manager, model.AppRolePublicAssetsManager, true)

	seed := requestAdminSettings(t, http.MethodPost, adminA, model.Settings{Revision: 0, AI: model.AISettings{}})
	if seed.Code != http.StatusOK || decodeAdminSettings(t, seed).Revision != 1 {
		t.Fatalf("seed settings = %d/%s", seed.Code, seed.Body.String())
	}
	if err := database.Where("action = ?", "ai_settings_save").Delete(&model.OperationLog{}).Error; err != nil {
		t.Fatal(err)
	}

	clientAResponse := requestAdminSettings(t, http.MethodGet, adminA, nil)
	clientBResponse := requestAdminSettings(t, http.MethodGet, adminB, nil)
	clientA := decodeAdminSettings(t, clientAResponse)
	clientB := decodeAdminSettings(t, clientBResponse)
	if clientA.Revision != 1 || clientB.Revision != 1 {
		t.Fatalf("loaded revisions = %d/%d, want 1/1", clientA.Revision, clientB.Revision)
	}
	clientA.AI.Providers = []model.AIProvider{{ID: "winner", Name: "winner", Type: "maizi-image", Enabled: true, AspectRatios: []string{"1:1"}, ImagePrices: []model.ImageResolutionPrice{}, Config: json.RawMessage(`{"apiKey":"winner-secret","model":"gpt-image-2"}`)}}
	clientB.AI.Providers = []model.AIProvider{{ID: "stale", Name: "stale", Type: "maizi-image", Enabled: true, AspectRatios: []string{"1:1"}, ImagePrices: []model.ImageResolutionPrice{}, Config: json.RawMessage(`{"apiKey":"stale-secret","model":"gpt-image-2"}`)}}

	winnerResponse := requestAdminSettings(t, http.MethodPost, adminA, clientA)
	if winnerResponse.Code != http.StatusOK {
		t.Fatalf("winner save = %d/%s", winnerResponse.Code, winnerResponse.Body.String())
	}
	winner := decodeAdminSettings(t, winnerResponse)
	if winner.Revision != 2 || len(winner.AI.Providers) != 1 || winner.AI.Providers[0].ID != "winner" {
		t.Fatalf("winner settings = %#v", winner)
	}

	staleResponse := requestAdminSettings(t, http.MethodPost, adminB, clientB)
	if staleResponse.Code != http.StatusConflict {
		t.Fatalf("stale save = %d/%s, want 409", staleResponse.Code, staleResponse.Body.String())
	}
	stalePayload := decodeSettingsRouteResponse(t, staleResponse)
	var conflictData map[string]any
	if err := json.Unmarshal(stalePayload.Data, &conflictData); err != nil {
		t.Fatal(err)
	}
	if len(conflictData) != 1 || conflictData["currentRevision"] != float64(2) {
		t.Fatalf("conflict data = %#v, want only currentRevision=2", conflictData)
	}
	if strings.Contains(staleResponse.Body.String(), "winner-secret") || strings.Contains(staleResponse.Body.String(), "stale-secret") {
		t.Fatalf("conflict leaked settings secrets: %s", staleResponse.Body.String())
	}

	finalResponse := requestAdminSettings(t, http.MethodGet, adminA, nil)
	finalSettings := decodeAdminSettings(t, finalResponse)
	if finalSettings.Revision != 2 || len(finalSettings.AI.Providers) != 1 || finalSettings.AI.Providers[0].ID != "winner" {
		t.Fatalf("stale writer changed final settings: %#v", finalSettings)
	}
	logs, _, err := repository.ListOperationLogs(model.OperationLogQuery{Action: "ai_settings_save", Page: 1, PageSize: 20})
	if err != nil {
		t.Fatal(err)
	}
	if len(logs) != 1 || logs[0].ActorUID != adminA {
		t.Fatalf("settings audit logs = %#v, want only winning admin A", logs)
	}

	forbidden := requestAdminSettings(t, http.MethodPost, manager, finalSettings)
	if forbidden.Code != http.StatusForbidden {
		t.Fatalf("public assets manager save = %d/%s, want 403", forbidden.Code, forbidden.Body.String())
	}
}
