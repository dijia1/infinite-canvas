package handler

import (
	"net/http"

	"github.com/basketikun/infinite-canvas/service"
)

func AdminStatistics(w http.ResponseWriter, r *http.Request) {
	result, err := service.AdminStatistics(r.URL.Query().Get("start"), r.URL.Query().Get("end"))
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, result)
}
