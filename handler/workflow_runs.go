package handler

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/basketikun/infinite-canvas/repository"
	"github.com/basketikun/infinite-canvas/service"
)

func CreateWorkflowRun(w http.ResponseWriter, r *http.Request, workflowID string) {
	user, ok := service.PortalUserFromContext(r.Context())
	if !ok {
		Fail(w, "未经过 Portal Gateway 身份验证")
		return
	}
	input := service.CreateWorkflowRunInput{}
	if !decodeWorkflowRequest(w, r, &input, false) {
		return
	}
	item, err := service.CreateWorkflowRun(r.Context(), user, workflowID, input)
	if err != nil {
		writeWorkflowRunError(w, err)
		return
	}
	OK(w, item)
}

func WorkflowRuns(w http.ResponseWriter, r *http.Request) {
	user, ok := service.PortalUserFromContext(r.Context())
	if !ok {
		Fail(w, "未经过 Portal Gateway 身份验证")
		return
	}
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	pageSize, _ := strconv.Atoi(r.URL.Query().Get("pageSize"))
	items, err := service.ListWorkflowRuns(r.Context(), user, service.WorkflowRunListFilter{
		WorkflowID: r.URL.Query().Get("workflowId"), ScopeType: r.URL.Query().Get("scopeType"),
		FrameID: r.URL.Query().Get("frameId"), Active: r.URL.Query().Get("active"),
	}, page, pageSize)
	if err != nil {
		writeWorkflowRunError(w, err)
		return
	}
	OK(w, items)
}

func WorkflowRunState(w http.ResponseWriter, r *http.Request, workflowID string) {
	user, ok := service.PortalUserFromContext(r.Context())
	if !ok {
		Fail(w, "未经过 Portal Gateway 身份验证")
		return
	}
	page, _ := strconv.Atoi(r.URL.Query().Get("activePage"))
	pageSize, _ := strconv.Atoi(r.URL.Query().Get("activePageSize"))
	item, err := service.GetWorkflowRunState(r.Context(), user, workflowID, page, pageSize)
	if err != nil {
		writeWorkflowRunError(w, err)
		return
	}
	OK(w, item)
}

func WorkflowRun(w http.ResponseWriter, r *http.Request, id string) {
	user, ok := service.PortalUserFromContext(r.Context())
	if !ok {
		Fail(w, "未经过 Portal Gateway 身份验证")
		return
	}
	item, err := service.GetWorkflowRun(r.Context(), user, id)
	if err != nil {
		writeWorkflowRunError(w, err)
		return
	}
	OK(w, item)
}

func StopWorkflowRun(w http.ResponseWriter, r *http.Request, id string) {
	user, ok := service.PortalUserFromContext(r.Context())
	if !ok {
		Fail(w, "未经过 Portal Gateway 身份验证")
		return
	}
	item, err := service.StopWorkflowRun(r.Context(), user, id)
	if err != nil {
		writeWorkflowRunError(w, err)
		return
	}
	OK(w, item)
}

func RetryWorkflowRunOutput(w http.ResponseWriter, r *http.Request, id string) {
	user, ok := service.PortalUserFromContext(r.Context())
	if !ok {
		Fail(w, "未经过 Portal Gateway 身份验证")
		return
	}
	input := service.RetryWorkflowOutputInput{}
	if !decodeWorkflowRequest(w, r, &input, false) {
		return
	}
	item, err := service.RetryWorkflowOutput(r.Context(), user, id, input)
	if err != nil {
		writeWorkflowRunError(w, err)
		return
	}
	OK(w, item)
}

func DeleteWorkflowRun(w http.ResponseWriter, r *http.Request, id string) {
	user, ok := service.PortalUserFromContext(r.Context())
	if !ok {
		Fail(w, "未经过 Portal Gateway 身份验证")
		return
	}
	if err := service.DeleteWorkflowRun(r.Context(), user, id); err != nil {
		writeWorkflowRunError(w, err)
		return
	}
	OK(w, true)
}

func writeWorkflowRunError(w http.ResponseWriter, err error) {
	var business *service.WorkflowBusinessError
	if errors.As(err, &business) {
		data := map[string]any{"code": business.Code}
		for key, value := range business.Data {
			data[key] = value
		}
		FailDataStatus(w, business.HTTPStatus, business.Message, data)
		return
	}
	if errors.Is(err, service.ErrWorkflowConflict) {
		writeWorkflowError(w, err)
		return
	}
	if service.IsWorkflowValidationError(err) {
		FailStatus(w, http.StatusBadRequest, err.Error())
		return
	}
	if errors.Is(err, repository.ErrWorkflowRunActive) {
		FailStatus(w, http.StatusConflict, "运行尚未结束")
		return
	}
	FailError(w, err)
}
