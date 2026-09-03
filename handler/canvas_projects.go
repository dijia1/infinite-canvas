package handler

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/basketikun/infinite-canvas/service"
)

func CanvasProjects(w http.ResponseWriter, r *http.Request) {
	user, ok := service.PortalUserFromContext(r.Context())
	if !ok {
		Fail(w, "未经过 Portal Gateway 身份验证")
		return
	}
	items, err := service.ListCanvasProjects(r.Context(), user)
	if err != nil {
		writeCanvasProjectError(w, err)
		return
	}
	OK(w, items)
}

func CreateCanvasProject(w http.ResponseWriter, r *http.Request) {
	user, ok := service.PortalUserFromContext(r.Context())
	if !ok {
		Fail(w, "未经过 Portal Gateway 身份验证")
		return
	}
	var input service.CanvasProjectInput
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		FailStatus(w, http.StatusBadRequest, "请求参数无效")
		return
	}
	item, err := service.CreateCanvasProject(r.Context(), user, input)
	if err != nil {
		writeCanvasProjectError(w, err)
		return
	}
	OK(w, item)
}

func ImportCanvasProjects(w http.ResponseWriter, r *http.Request) {
	user, ok := service.PortalUserFromContext(r.Context())
	if !ok {
		Fail(w, "未经过 Portal Gateway 身份验证")
		return
	}
	var input struct {
		Projects []service.CanvasProjectInput `json:"projects"`
	}
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		FailStatus(w, http.StatusBadRequest, "请求参数无效")
		return
	}
	items, err := service.ImportCanvasProjects(r.Context(), user, input.Projects)
	if err != nil {
		writeCanvasProjectError(w, err)
		return
	}
	OK(w, items)
}

func CanvasProject(w http.ResponseWriter, r *http.Request, id string) {
	user, ok := service.PortalUserFromContext(r.Context())
	if !ok {
		Fail(w, "未经过 Portal Gateway 身份验证")
		return
	}
	item, err := service.GetCanvasProject(r.Context(), user, id)
	if err != nil {
		writeCanvasProjectError(w, err)
		return
	}
	OK(w, item)
}

func UpdateCanvasProject(w http.ResponseWriter, r *http.Request, id string) {
	user, ok := service.PortalUserFromContext(r.Context())
	if !ok {
		Fail(w, "未经过 Portal Gateway 身份验证")
		return
	}
	var input service.CanvasProjectUpdateInput
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		FailStatus(w, http.StatusBadRequest, "请求参数无效")
		return
	}
	item, err := service.UpdateCanvasProject(r.Context(), user, id, input)
	if err != nil {
		writeCanvasProjectError(w, err)
		return
	}
	OK(w, item)
}

func DeleteCanvasProject(w http.ResponseWriter, r *http.Request, id string) {
	user, ok := service.PortalUserFromContext(r.Context())
	if !ok {
		Fail(w, "未经过 Portal Gateway 身份验证")
		return
	}
	var input struct {
		Revision int `json:"revision"`
	}
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		FailStatus(w, http.StatusBadRequest, "请求参数无效")
		return
	}
	if err := service.DeleteCanvasProject(r.Context(), user, id, input.Revision); err != nil {
		writeCanvasProjectError(w, err)
		return
	}
	OK(w, true)
}

func writeCanvasProjectError(w http.ResponseWriter, err error) {
	if errors.Is(err, service.ErrCanvasProjectDocumentTooLarge) {
		FailStatus(w, http.StatusRequestEntityTooLarge, err.Error())
		return
	}
	if errors.Is(err, service.ErrCanvasProjectConflict) {
		FailStatus(w, http.StatusConflict, "画布已在其他位置更新，请刷新后重试")
		return
	}
	if service.IsCanvasProjectValidationError(err) {
		FailStatus(w, http.StatusBadRequest, err.Error())
		return
	}
	FailError(w, err)
}
