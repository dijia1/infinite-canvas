package handler

import (
	"net/http"

	"github.com/basketikun/infinite-canvas/service"
)

func AdminTodayStatistics(w http.ResponseWriter, _ *http.Request) {
	result, err := service.AdminTodayStatistics()
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, result)
}
