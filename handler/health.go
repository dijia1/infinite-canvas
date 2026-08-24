package handler

import (
	"net/http"

	"github.com/basketikun/infinite-canvas/repository"
)

var databaseHealthCheck = func() error {
	database, err := repository.DB()
	if err != nil {
		return err
	}
	sqlDB, err := database.DB()
	if err != nil {
		return err
	}
	return sqlDB.Ping()
}

func Health(w http.ResponseWriter, _ *http.Request) {
	if err := databaseHealthCheck(); err != nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte("unavailable"))
		return
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}
