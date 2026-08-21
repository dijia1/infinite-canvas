package router

import "testing"

func TestLegacyAssetRoutesAreNotRegistered(t *testing.T) {
	legacy := map[string]bool{
		"/api/assets":           true,
		"/api/admin/assets":     true,
		"/api/admin/assets/:id": true,
	}

	for _, route := range New().Routes() {
		if legacy[route.Path] {
			t.Fatalf("legacy asset route is still registered: %s %s", route.Method, route.Path)
		}
	}
}
