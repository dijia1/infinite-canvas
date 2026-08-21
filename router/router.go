package router

import (
	"net/http"

	"github.com/basketikun/infinite-canvas/handler"
	"github.com/basketikun/infinite-canvas/middleware"
	"github.com/gin-gonic/gin"
)

func New() *gin.Engine {
	router := gin.Default()
	router.RedirectTrailingSlash = false
	_ = router.SetTrustedProxies(nil)
	api := router.Group("/api")
	api.GET("/health", func(c *gin.Context) {
		c.String(http.StatusOK, "ok")
	})
	protected := api.Group("")
	protected.Use(middleware.PortalIdentity)
	protected.GET("/session", gin.WrapF(handler.PortalSession))
	protected.GET("/settings", gin.WrapF(handler.Settings))
	v1 := protected.Group("/v1")
	v1.POST("/images/generations", gin.WrapF(handler.AIImagesGenerations))
	v1.POST("/images/edits", gin.WrapF(handler.AIImagesEdits))
	v1.POST("/media/images", gin.WrapF(handler.UploadImage))
	v1.GET("/media/:id/access", func(c *gin.Context) { handler.MediaAccess(c.Writer, c.Request, c.Param("id")) })
	v1.GET("/media/:id/content", func(c *gin.Context) { handler.LocalMediaContent(c.Writer, c.Request, c.Param("id")) })
	v1.GET("/public-images", gin.WrapF(handler.PublicImages))
	v1.GET("/public-images/:id/access", func(c *gin.Context) { handler.PublicImageAccess(c.Writer, c.Request, c.Param("id")) })
	v1.GET("/public-images/:id/content", func(c *gin.Context) { handler.PublicImageContent(c.Writer, c.Request, c.Param("id")) })
	v1.POST("/videos", gin.WrapF(handler.AIVideos))
	v1.GET("/videos/:id", func(c *gin.Context) {
		handler.AIVideo(c.Writer, c.Request, c.Param("id"))
	})
	v1.GET("/videos/:id/content", func(c *gin.Context) {
		handler.AIVideoContent(c.Writer, c.Request, c.Param("id"))
	})
	protected.GET("/assets", gin.WrapF(handler.Assets))

	admin := protected.Group("/admin", middleware.RequirePortalAdmin)
	admin.GET("/me", gin.WrapF(handler.AdminCurrent))
	admin.GET("/settings", gin.WrapF(handler.AdminSettings))
	admin.POST("/settings", gin.WrapF(handler.AdminSaveSettings))
	admin.GET("/ai/provider-types", gin.WrapF(handler.AdminAIProviderTypes))
	admin.GET("/assets", gin.WrapF(handler.AdminAssets))
	admin.POST("/assets", gin.WrapF(handler.AdminSaveAsset))
	admin.DELETE("/assets/:id", func(c *gin.Context) {
		handler.AdminDeleteAsset(c.Writer, c.Request, c.Param("id"))
	})
	admin.POST("/public-images", gin.WrapF(handler.AdminUploadPublicImage))
	admin.DELETE("/public-images/:id", func(c *gin.Context) {
		handler.AdminDeletePublicImage(c.Writer, c.Request, c.Param("id"))
	})

	router.NoRoute(middleware.NotFoundJSON)

	return router
}
