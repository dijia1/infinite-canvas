package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/basketikun/infinite-canvas/service"
	"github.com/gin-gonic/gin"
)

func TestPortalIdentityRequiresGatewayHeaders(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(PortalIdentity)
	router.GET("/private", func(c *gin.Context) {
		user, ok := service.PortalUserFromContext(c.Request.Context())
		if !ok || user.UID != "user-1" {
			c.Status(http.StatusInternalServerError)
			return
		}
		c.Status(http.StatusNoContent)
	})

	missing := httptest.NewRecorder()
	router.ServeHTTP(missing, httptest.NewRequest(http.MethodGet, "/private", nil))
	if missing.Code != http.StatusUnauthorized {
		t.Fatalf("missing identity status = %d, want %d", missing.Code, http.StatusUnauthorized)
	}

	request := httptest.NewRequest(http.MethodGet, "/private", nil)
	request.Header.Set("X-Portal-User-Uid", "user-1")
	request.Header.Set("X-Portal-Username", "%E5%BC%A0%E4%B8%89")
	request.Header.Set("X-Portal-Roles", "member,portal-admin")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("portal identity status = %d, body = %s", response.Code, response.Body.String())
	}
}

func TestRequirePortalAdminRejectsRegularUser(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(PortalIdentity, RequirePortalAdmin)
	router.GET("/admin", func(c *gin.Context) { c.Status(http.StatusNoContent) })

	request := httptest.NewRequest(http.MethodGet, "/admin", nil)
	request.Header.Set("X-Portal-User-Uid", "user-1")
	request.Header.Set("X-Portal-Roles", "member")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("regular user status = %d, want %d", response.Code, http.StatusForbidden)
	}
}
