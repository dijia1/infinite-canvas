package handler

import (
	"encoding/json"
	"io"
	"net/http"

	"github.com/basketikun/infinite-canvas/service"
)

func AdminResolveGenerationTask(w http.ResponseWriter, r *http.Request, kind, id string) {
	var input service.GenerationTaskResolutionRequest
	r.Body = http.MaxBytesReader(w, r.Body, 8<<10)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		FailStatus(w, http.StatusBadRequest, "任务核对请求无效")
		return
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		FailStatus(w, http.StatusBadRequest, "任务核对请求无效")
		return
	}
	if err := service.ResolveGenerationTask(r.Context(), kind, id, input); err != nil {
		FailError(w, err)
		return
	}
	OK(w, map[string]bool{"ok": true})
}
