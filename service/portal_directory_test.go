package service

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/basketikun/infinite-canvas/config"
)

func TestFetchDirectoryUsersPreservesDepartments(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Portal-Service-Key") != "infinite-canvas" || r.Header.Get("X-Portal-Service-Secret") != "directory-secret" {
			t.Fatalf("directory headers = %q, %q", r.Header.Get("X-Portal-Service-Key"), r.Header.Get("X-Portal-Service-Secret"))
		}
		_, _ = w.Write([]byte(`{"users":[{"userUid":"f3dbfc1a-06c5-4d31-a0cc-62e9475e34f1","displayName":"接收成员","enabled":true,"roles":["设计部"],"departments":["设计部"]}]}`))
	}))
	defer server.Close()
	previous := config.Cfg
	config.Cfg.PortalDirectoryURL = server.URL
	config.Cfg.PortalDirectoryAppKey = "infinite-canvas"
	config.Cfg.PortalDirectorySecret = "directory-secret"
	t.Cleanup(func() { config.Cfg = previous })

	users, err := fetchDirectoryUsers(context.Background())
	if err != nil || len(users) != 1 {
		t.Fatalf("fetchDirectoryUsers() = %#v, %v", users, err)
	}
	encoded, err := json.Marshal(users[0])
	if err != nil || string(encoded) != `{"userUid":"f3dbfc1a-06c5-4d31-a0cc-62e9475e34f1","displayName":"接收成员","enabled":true,"roles":["设计部"],"departments":["设计部"]}` {
		t.Fatalf("directory user JSON = %s, %v", encoded, err)
	}
}
