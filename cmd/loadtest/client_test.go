package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestRejectUnsafeTargets(t *testing.T) {
	for _, s := range []string{"postgres://u:p@production/infinite_canvas_test", "postgres://u:p@127.0.0.1/user_database", "https://127.0.0.1/infinite_canvas_test"} {
		if _, err := neturlLocalDSN(s); err == nil {
			t.Fatalf("accepted unsafe target %s", s)
		}
	}
}
func TestHTTP200BusinessFailureIsNotSuccess(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"code":1,"data":null,"msg":"database failure"}`)
	}))
	defer s.Close()
	d := &driver{base: s.URL, client: s.Client(), start: time.Now(), events: json.NewEncoder(io.Discard)}
	if _, ok := d.request(1, "load-user-01", "test", "Canvas PUT", "PUT", "/", nil, ""); ok || len(d.failures) != 1 {
		t.Fatal("failed body incorrectly treated as success")
	}
}
func TestExpectedConflictAndPermissionResponses(t *testing.T) {
	for _, code := range []int{401, 403, 409} {
		t.Run(http.StatusText(code), func(t *testing.T) {
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(code)
				io.WriteString(w, `{"code":1,"data":null,"msg":"expected"}`)
			}))
			defer s.Close()
			expect := map[int]string{401: "401", 403: "403", 409: "race"}[code]
			d := &driver{base: s.URL, client: s.Client(), start: time.Now(), events: json.NewEncoder(io.Discard)}
			if _, ok := d.request(1, "load-user-01", "test", "check", "GET", "/", nil, expect); !ok || len(d.failures) != 0 {
				t.Fatal("expected business response counted as system error")
			}
		})
	}
}
