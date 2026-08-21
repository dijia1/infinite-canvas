package handler

import (
	"net/http"

	"github.com/basketikun/infinite-canvas/service"
)

func AdminCurrent(w http.ResponseWriter, r *http.Request) {
	user, ok := service.PortalUserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	OK(w, map[string]string{"id": user.UID, "username": user.Username, "role": "admin"})
}
