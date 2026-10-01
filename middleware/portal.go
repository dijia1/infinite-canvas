package middleware

import (
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/service"
	"github.com/gin-gonic/gin"
)

// PortalIdentity requires a locally verified Portal identity on all user API routes.
func PortalIdentity(c *gin.Context) {
	user, ok, reason := verifyPortalIdentityWithReason(c.Request.Header, config.Cfg.PortalDirectoryAppKey, config.Cfg.PortalDirectorySecret, time.Now())
	if !ok {
		entry, _ := json.Marshal(map[string]string{"event": "portal_identity_unverified", "reason": reason, "method": c.Request.Method, "path": c.Request.URL.Path})
		log.Print(string(entry))
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"code": 1, "data": nil, "msg": "Portal 身份无效或已过期", "error": "PORTAL_IDENTITY_INVALID"})
		return
	}
	c.Request = c.Request.WithContext(service.WithPortalUser(c.Request.Context(), user))
	c.Next()
}

func RequireAppAdmin(c *gin.Context) {
	user, ok := service.PortalUserFromContext(c.Request.Context())
	if !ok {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"code": 1, "data": nil, "msg": "未登录或权限不足"})
		return
	}
	permissions, err := service.ResolveAppPermissions(c.Request.Context(), user)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"code": 1, "data": nil, "msg": "权限检查失败"})
		return
	}
	if !permissions.IsAdmin {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"code": 1, "data": nil, "msg": "未登录或权限不足"})
		return
	}
	c.Next()
}

func RequirePublicAssetManager(c *gin.Context) {
	user, ok := service.PortalUserFromContext(c.Request.Context())
	if !ok {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"code": 1, "data": nil, "msg": "未登录或权限不足"})
		return
	}
	permissions, err := service.ResolveAppPermissions(c.Request.Context(), user)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"code": 1, "data": nil, "msg": "权限检查失败"})
		return
	}
	if !permissions.CanManagePublicAssets {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"code": 1, "data": nil, "msg": "未登录或权限不足"})
		return
	}
	c.Next()
}
