package handler

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"

	"github.com/basketikun/infinite-canvas/service"
)

const maxWorkflowRequestBytes = (4 << 20) + (64 << 10)

func Workflows(w http.ResponseWriter, r *http.Request) {
	user, ok := service.PortalUserFromContext(r.Context())
	if !ok {
		Fail(w, "未经过 Portal Gateway 身份验证")
		return
	}
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	pageSize, _ := strconv.Atoi(r.URL.Query().Get("pageSize"))
	items, err := service.ListWorkflows(r.Context(), user, page, pageSize)
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	OK(w, items)
}

func CreateWorkflow(w http.ResponseWriter, r *http.Request) {
	user, ok := service.PortalUserFromContext(r.Context())
	if !ok {
		Fail(w, "未经过 Portal Gateway 身份验证")
		return
	}
	input := service.WorkflowCreateInput{}
	if !decodeWorkflowRequest(w, r, &input, false) {
		return
	}
	item, err := service.CreateWorkflow(r.Context(), user, input)
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	OK(w, item)
}

func Workflow(w http.ResponseWriter, r *http.Request, id string) {
	user, ok := service.PortalUserFromContext(r.Context())
	if !ok {
		Fail(w, "未经过 Portal Gateway 身份验证")
		return
	}
	item, err := service.GetWorkflow(r.Context(), user, id)
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	OK(w, item)
}

func UpdateWorkflow(w http.ResponseWriter, r *http.Request, id string) {
	user, ok := service.PortalUserFromContext(r.Context())
	if !ok {
		Fail(w, "未经过 Portal Gateway 身份验证")
		return
	}
	input := service.WorkflowUpdateInput{}
	if !decodeWorkflowRequest(w, r, &input, false) {
		return
	}
	item, err := service.UpdateWorkflow(r.Context(), user, id, input)
	if errors.Is(err, service.ErrWorkflowConflict) {
		writeWorkflowConflict(w, r, user, id, input.Revision)
		return
	}
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	OK(w, item)
}

func CopyWorkflow(w http.ResponseWriter, r *http.Request, id string) {
	user, ok := service.PortalUserFromContext(r.Context())
	if !ok {
		Fail(w, "未经过 Portal Gateway 身份验证")
		return
	}
	input := service.WorkflowCopyInput{}
	if !decodeWorkflowRequest(w, r, &input, true) {
		return
	}
	item, err := service.CopyWorkflow(r.Context(), user, id, input)
	if err != nil {
		writeWorkflowError(w, err)
		return
	}
	OK(w, item)
}

func DeleteWorkflow(w http.ResponseWriter, r *http.Request, id string) {
	user, ok := service.PortalUserFromContext(r.Context())
	if !ok {
		Fail(w, "未经过 Portal Gateway 身份验证")
		return
	}
	input := struct {
		Revision int `json:"revision"`
	}{}
	if !decodeWorkflowRequest(w, r, &input, false) {
		return
	}
	if err := service.DeleteWorkflow(r.Context(), user, id, input.Revision); errors.Is(err, service.ErrWorkflowConflict) {
		writeWorkflowConflict(w, r, user, id, input.Revision)
		return
	} else if err != nil {
		writeWorkflowError(w, err)
		return
	}
	OK(w, true)
}

func decodeWorkflowRequest(w http.ResponseWriter, r *http.Request, destination any, allowEmpty bool) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxWorkflowRequestBytes)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		if allowEmpty && errors.Is(err, io.EOF) {
			return true
		}
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			FailStatus(w, http.StatusRequestEntityTooLarge, "流程数据超过保存上限（4MB）")
			return false
		}
		FailStatus(w, http.StatusBadRequest, "请求参数无效")
		return false
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		FailStatus(w, http.StatusBadRequest, "请求参数无效")
		return false
	}
	return true
}

func writeWorkflowConflict(w http.ResponseWriter, r *http.Request, user service.PortalUser, id string, requestedRevision int) {
	serverRevision := 0
	if current, err := service.GetWorkflow(r.Context(), user, id); err == nil {
		serverRevision = current.Revision
	}
	FailDataStatus(w, http.StatusConflict, "流程已在其他位置更新，请刷新后重试", map[string]any{
		"code":              "workflow_revision_conflict",
		"workflowId":        id,
		"requestedRevision": requestedRevision,
		"serverRevision":    serverRevision,
	})
}

func writeWorkflowError(w http.ResponseWriter, err error) {
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
		FailStatus(w, http.StatusConflict, "流程已在其他位置更新，请刷新后重试")
		return
	}
	if service.IsWorkflowValidationError(err) {
		FailStatus(w, http.StatusBadRequest, err.Error())
		return
	}
	FailError(w, err)
}
