package middleware

import (
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/internal/testportal"
	"github.com/basketikun/infinite-canvas/internal/testpostgres"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/basketikun/infinite-canvas/service"
	"github.com/gin-gonic/gin"
)

func TestMain(m *testing.M) {
	schema, err := testpostgres.NewSchema("middleware")
	if err != nil {
		panic(err)
	}
	config.Cfg = config.Config{DatabaseDSN: schema.DSN, PortalDirectoryAppKey: "infinite-canvas", PortalDirectorySecret: "test-identity-secret"}
	code := m.Run()
	closeRepositoryPool()
	_ = schema.Close()
	os.Exit(code)
}

func closeRepositoryPool() {
	database, _ := repository.DB()
	if database == nil {
		return
	}
	sqlDB, err := database.DB()
	if err == nil {
		_ = sqlDB.Close()
	}
}

func grantLocalRole(t *testing.T, userUID string, role model.AppRole, enabled bool) {
	t.Helper()
	if err := repository.UpsertPortalMembers([]model.PortalMember{{
		UserUID: userUID, DisplayName: userUID, Enabled: enabled, Roles: []string{},
	}}); err != nil {
		t.Fatal(err)
	}
	if err := repository.SetAppRole(userUID, role, "test-grantor", false); err != nil {
		t.Fatal(err)
	}
}

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
	testportal.Sign(request, config.Cfg.PortalDirectoryAppKey, config.Cfg.PortalDirectorySecret)
	router.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("portal identity status = %d, body = %s", response.Code, response.Body.String())
	}
}

func TestRequireAppAdminRejectsRegularUser(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(PortalIdentity, RequireAppAdmin)
	router.GET("/admin", func(c *gin.Context) { c.Status(http.StatusNoContent) })

	request := httptest.NewRequest(http.MethodGet, "/admin", nil)
	request.Header.Set("X-Portal-User-Uid", "user-1")
	request.Header.Set("X-Portal-Roles", "member")
	response := httptest.NewRecorder()
	testportal.Sign(request, config.Cfg.PortalDirectoryAppKey, config.Cfg.PortalDirectorySecret)
	router.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("regular user status = %d, want %d", response.Code, http.StatusForbidden)
	}
}

func TestVerifiedGatewayAdminRoleGrantsAdmin(t *testing.T) {
	const userUID = "gateway-role-only-member"
	grantLocalRole(t, userUID, model.AppRoleMember, true)

	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(PortalIdentity, RequireAppAdmin)
	router.GET("/admin", func(c *gin.Context) { c.Status(http.StatusNoContent) })

	request := httptest.NewRequest(http.MethodGet, "/admin", nil)
	request.Header.Set("X-Portal-User-Uid", userUID)
	request.Header.Set("X-Portal-Roles", "portal-admin")
	response := httptest.NewRecorder()
	testportal.Sign(request, config.Cfg.PortalDirectoryAppKey, config.Cfg.PortalDirectorySecret)
	router.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("verified global admin status = %d, want %d", response.Code, http.StatusNoContent)
	}
}

func TestLocalPublicAssetsManagerMiddlewareAllowsOnlyPublicAssets(t *testing.T) {
	const userUID = "local-public-assets-manager-middleware"
	grantLocalRole(t, userUID, model.AppRolePublicAssetsManager, true)

	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(PortalIdentity)
	router.GET("/admin", RequireAppAdmin, func(c *gin.Context) { c.Status(http.StatusNoContent) })
	router.POST("/public-assets", RequirePublicAssetManager, func(c *gin.Context) { c.Status(http.StatusNoContent) })

	request := func(method, path string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, nil)
		req.Header.Set("X-Portal-User-Uid", userUID)
		response := httptest.NewRecorder()
		testportal.Sign(req, config.Cfg.PortalDirectoryAppKey, config.Cfg.PortalDirectorySecret)
		router.ServeHTTP(response, req)
		return response
	}
	if response := request(http.MethodPost, "/public-assets"); response.Code != http.StatusNoContent {
		t.Fatalf("public-assets status = %d, want %d", response.Code, http.StatusNoContent)
	}
	if response := request(http.MethodGet, "/admin"); response.Code != http.StatusForbidden {
		t.Fatalf("admin status = %d, want %d", response.Code, http.StatusForbidden)
	}
}

func TestAppPermissionLookupFailureReturnsInternalServerError(t *testing.T) {
	const userUID = "permission-lookup-failure"
	grantLocalRole(t, userUID, model.AppRoleAdmin, true)
	database, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Migrator().DropTable(&model.PortalMember{}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := database.AutoMigrate(&model.PortalMember{}); err != nil {
			t.Errorf("restore portal member table: %v", err)
		}
	})

	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(PortalIdentity, RequireAppAdmin)
	router.GET("/admin", func(c *gin.Context) { c.Status(http.StatusNoContent) })
	request := httptest.NewRequest(http.MethodGet, "/admin", nil)
	request.Header.Set("X-Portal-User-Uid", userUID)
	response := httptest.NewRecorder()
	testportal.Sign(request, config.Cfg.PortalDirectoryAppKey, config.Cfg.PortalDirectorySecret)
	router.ServeHTTP(response, request)
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("permission storage failure status = %d, want %d; body = %s", response.Code, http.StatusInternalServerError, response.Body.String())
	}
}
