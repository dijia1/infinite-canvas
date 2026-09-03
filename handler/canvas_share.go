package handler

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/service"
)

func CanvasShareRecipients(w http.ResponseWriter, r *http.Request) {
	user, ok := service.PortalUserFromContext(r.Context())
	if !ok {
		Fail(w, "未经过 Portal Gateway 身份验证")
		return
	}
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	pageSize, _ := strconv.Atoi(r.URL.Query().Get("pageSize"))
	result, err := service.ListCanvasShareRecipients(user.UID, model.PortalMemberQuery{Query: r.URL.Query().Get("query"), Page: page, PageSize: pageSize})
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, result)
}

func ShareCanvasProject(w http.ResponseWriter, r *http.Request, id string) {
	user, ok := service.PortalUserFromContext(r.Context())
	if !ok {
		Fail(w, "未经过 Portal Gateway 身份验证")
		return
	}
	var input service.CanvasShareInput
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		FailStatus(w, http.StatusBadRequest, "请求参数无效")
		return
	}
	result, err := service.ShareCanvasProject(r.Context(), user, id, input)
	if err != nil {
		writeCanvasProjectError(w, err)
		return
	}
	service.RecordOperation(r.Context(), service.OperationLogInput{Action: "canvas_share", TargetType: "canvas_project", TargetID: id})
	OK(w, result)
}
