package handler

import (
	"net/http"

	"github.com/basketikun/infinite-canvas/service"
)

func AdminResolveGenerationTask(w http.ResponseWriter, r *http.Request, kind, id string) {
	var input service.GenerationTaskResolutionRequest
	if err := decodeJSONBody(w, r, &input, 8<<10, true); err != nil {
		writeJSONRequestError(w, err, "任务核对请求无效")
		return
	}
	if err := service.ResolveGenerationTask(r.Context(), kind, id, input); err != nil {
		FailError(w, err)
		return
	}
	OK(w, map[string]bool{"ok": true})
}
