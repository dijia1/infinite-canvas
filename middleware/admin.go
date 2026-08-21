package middleware

import "github.com/gin-gonic/gin"

func AdminAuth(c *gin.Context) {
	PortalIdentity(c)
	if c.IsAborted() {
		return
	}
	RequirePortalAdmin(c)
}

func NotFoundJSON(c *gin.Context) {
	c.JSON(404, gin.H{"code": 1, "data": nil, "msg": "接口不存在"})
}
