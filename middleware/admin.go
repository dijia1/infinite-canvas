package middleware

import (
	"strings"

	"github.com/basketikun/infinite-canvas/handler"
	"github.com/basketikun/infinite-canvas/service"
	"github.com/gin-gonic/gin"
)

func AdminAuth(c *gin.Context) {
	token := strings.TrimPrefix(c.GetHeader("Authorization"), "Bearer ")
	user, ok := service.CurrentAdmin(token)
	if !ok {
		handler.Fail(c.Writer, "未登录或权限不足")
		c.Abort()
		return
	}
	c.Request = c.Request.WithContext(service.WithUser(c.Request.Context(), user))
	c.Next()
}

func NotFoundJSON(c *gin.Context) {
	c.JSON(404, gin.H{"code": 1, "data": nil, "msg": "接口不存在"})
}
