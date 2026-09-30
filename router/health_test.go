package router

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHealthRoutesArePublicAndJSON(t *testing.T) {
	for _, path := range []string{"/api/healthz", "/api/health"} {
		for _, method := range []string{http.MethodGet, http.MethodHead} {
			t.Run(method+path, func(t *testing.T) {
				w := httptest.NewRecorder()
				New().ServeHTTP(w, httptest.NewRequest(method, path, nil))
				if w.Code != 200 || w.Header().Get("Content-Type") != "application/json" {
					t.Fatalf("health=%d headers=%v body=%s", w.Code, w.Header(), w.Body.String())
				}
				expected := "{\"ok\":true}\n"
				if method == http.MethodHead {
					expected = ""
				}
				if w.Body.String() != expected {
					t.Fatalf("body=%q want=%q", w.Body.String(), expected)
				}
			})
		}
	}
}
