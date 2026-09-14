package handler

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"strconv"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
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
	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(&settings); err != nil {
		Fail(w, "系统设置请求无效")
		return
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		Fail(w, "系统设置请求无效")
		return
	}
	result, err := service.SaveSettings(settings)
	if err != nil {
		var conflict *repository.SettingsRevisionConflictError
		if errors.As(err, &conflict) {
			FailDataStatus(w, http.StatusConflict, "AI 配置已在其他位置更新，请刷新后重试", map[string]any{"currentRevision": conflict.CurrentRevision})
			return
		}
		FailError(w, err)
		return
	}
	service.RecordOperation(r.Context(), service.OperationLogInput{Action: "ai_settings_save", TargetType: "ai_settings"})
	OK(w, result)
}

func AdminOperationLogs(w http.ResponseWriter, r *http.Request) {
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	pageSize, _ := strconv.Atoi(r.URL.Query().Get("pageSize"))
	result, err := service.ListOperationLogs(model.OperationLogQuery{MediaID: r.URL.Query().Get("mediaId"), Action: r.URL.Query().Get("action"), Actor: r.URL.Query().Get("actor"), Status: r.URL.Query().Get("status"), Page: page, PageSize: pageSize})
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, result)
}

func AdminPortalMembers(w http.ResponseWriter, r *http.Request) {
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	pageSize, _ := strconv.Atoi(r.URL.Query().Get("pageSize"))
	result, err := service.ListPortalMembers(model.PortalMemberQuery{Query: r.URL.Query().Get("query"), Page: page, PageSize: pageSize})
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, result)
}

func AdminSetPortalMemberAppRole(w http.ResponseWriter, r *http.Request, targetUID string) {
	var input struct {
		AppRole model.AppRole `json:"appRole"`
	}
	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(&input); err != nil {
		FailStatus(w, http.StatusBadRequest, "应用角色请求无效")
		return
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		FailStatus(w, http.StatusBadRequest, "应用角色请求无效")
		return
	}
	member, err := service.SetPortalMemberAppRole(r.Context(), targetUID, input.AppRole)
	if err != nil {
		switch {
		case errors.Is(err, repository.ErrLastAppAdmin):
			FailStatus(w, http.StatusConflict, "不能移除最后一名应用管理员")
		case service.IsAppMemberRoleValidationError(err):
			message := "应用角色请求无效"
			if safe, ok := err.(interface{ SafeMessage() string }); ok {
				message = safe.SafeMessage()
			}
			FailStatus(w, http.StatusBadRequest, message)
		default:
			log.Printf("application role change failed: target=%s error=%v", targetUID, err)
			FailStatus(w, http.StatusInternalServerError, "操作失败")
		}
		return
	}
	service.RecordOperation(r.Context(), service.OperationLogInput{
		Action: "member_app_role_change", TargetType: "portal_member", TargetID: member.UserUID, TargetName: member.DisplayName,
		RequestSummary: `{"appRole":"` + string(member.AppRole) + `"}`,
	})
	OK(w, member)
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
