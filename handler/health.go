package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/basketikun/infinite-canvas/repository"
)

var databaseHealthCheck = func(ctx context.Context) error {
	database, err := repository.DB()
	if err != nil {
		return err
	}
	sqlDB, err := database.DB()
	if err != nil {
		return err
	}
	return sqlDB.PingContext(ctx)
}

func Health(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	status := http.StatusOK
	payload := map[string]any{"ok": true}
	if err := databaseHealthCheck(ctx); err != nil {
		status = http.StatusServiceUnavailable
		payload = map[string]any{"ok": false, "error": "DEPENDENCY_UNAVAILABLE"}
	}
	w.WriteHeader(status)
	if r.Method != http.MethodHead {
		_ = json.NewEncoder(w).Encode(payload)
	}
}
