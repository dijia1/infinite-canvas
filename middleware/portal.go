package middleware

import (
	"net/http"
	"net/url"
	"strings"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/service"
	"github.com/gin-gonic/gin"
)

// PortalIdentity accepts only identity information injected by Portal Gateway.
// The application container must not expose a host port, otherwise clients could forge these headers.
func PortalIdentity(c *gin.Context) {
	uid := strings.TrimSpace(c.GetHeader("X-Portal-User-Uid"))
	if uid == "" {
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"code": 1, "data": nil, "msg": "未经过 Portal Gateway 身份验证"})
		return
	}
	username, err := url.QueryUnescape(c.GetHeader("X-Portal-Username"))
	if err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"code": 1, "data": nil, "msg": "Portal 用户名格式无效"})
		return
	}
	roles := make([]string, 0)
	for _, encoded := range strings.Split(c.GetHeader("X-Portal-Roles"), ",") {
		if encoded = strings.TrimSpace(encoded); encoded == "" {
			continue
		}
		role, err := url.QueryUnescape(encoded)
		if err != nil {
			c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"code": 1, "data": nil, "msg": "Portal 角色格式无效"})
			return
		}
		roles = append(roles, role)
	}
	c.Request = c.Request.WithContext(service.WithPortalUser(c.Request.Context(), service.PortalUser{UID: uid, Username: username, Roles: roles}))
	c.Next()
}

func RequirePortalAdmin(c *gin.Context) {
	user, ok := service.PortalUserFromContext(c.Request.Context())
	role := config.Cfg.PortalAdminRole
	if strings.TrimSpace(role) == "" {
		role = "portal-admin"
	}
	if !ok || !user.HasRole(role) {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"code": 1, "data": nil, "msg": "未登录或权限不足"})
		return
	}
	c.Next()
}
