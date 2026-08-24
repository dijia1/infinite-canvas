package handler

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/service"
)

func Settings(w http.ResponseWriter, r *http.Request) {
	settings, err := service.PublicSettings()
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, settings)
}

func AdminSettings(w http.ResponseWriter, r *http.Request) {
	settings, err := service.AdminSettings()
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, settings)
}

func AdminSaveSettings(w http.ResponseWriter, r *http.Request) {
	var settings model.Settings
	_ = json.NewDecoder(r.Body).Decode(&settings)
	result, err := service.SaveSettings(settings)
	if err != nil {
		FailError(w, err)
		return
	}
	service.RecordOperation(r.Context(), service.OperationLogInput{Action: "ai_settings_save", TargetType: "ai_settings"})
	OK(w, result)
}

func AdminOperationLogs(w http.ResponseWriter, r *http.Request) {
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	pageSize, _ := strconv.Atoi(r.URL.Query().Get("pageSize"))
	result, err := service.ListOperationLogs(model.OperationLogQuery{Action: r.URL.Query().Get("action"), Actor: r.URL.Query().Get("actor"), Status: r.URL.Query().Get("status"), Page: page, PageSize: pageSize})
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, result)
}

func AdminSyncPortalMembers(w http.ResponseWriter, r *http.Request) {
	result, err := service.SyncPortalMembers(r.Context())
	if err != nil {
		FailError(w, err)
		return
	}
	service.RecordOperation(r.Context(), service.OperationLogInput{Action: "portal_member_sync", TargetType: "portal_members"})
	OK(w, result)
}

func PortalDirectorySync(w http.ResponseWriter, r *http.Request) {
	if !service.ValidDirectoryServiceHeaders(r.Header.Get("X-Portal-Service-Key"), r.Header.Get("X-Portal-Service-Secret")) {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	var input struct {
		UserUID string `json:"userUid"`
	}
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	if err := service.SyncPortalMember(r.Context(), input.UserUID); err != nil {
		if _, safe := err.(interface{ SafeMessage() string }); safe {
			w.WriteHeader(http.StatusBadRequest)
		} else {
			w.WriteHeader(http.StatusBadGateway)
		}
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func AdminAIProviderTypes(w http.ResponseWriter, r *http.Request) {
	OK(w, service.AIProviderTypes())
}
