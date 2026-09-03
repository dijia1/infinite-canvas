package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAdminSaveSettingsRejectsMalformedJSON(t *testing.T) {
	request := httptest.NewRequest(http.MethodPost, "/api/admin/settings", strings.NewReader("{"))
	recorder := httptest.NewRecorder()

	AdminSaveSettings(recorder, request)

	var result response
	if err := json.NewDecoder(recorder.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if result.Code != 1 || result.Msg != "系统设置请求无效" {
		t.Fatalf("response = %#v, want invalid settings request", result)
	}
}

func TestAdminSaveSettingsRejectsTrailingJSON(t *testing.T) {
	request := httptest.NewRequest(http.MethodPost, "/api/admin/settings", strings.NewReader("{}{}"))
	recorder := httptest.NewRecorder()

	AdminSaveSettings(recorder, request)

	var result response
	if err := json.NewDecoder(recorder.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if result.Code != 1 || result.Msg != "系统设置请求无效" {
		t.Fatalf("response = %#v, want invalid settings request", result)
	}
}
