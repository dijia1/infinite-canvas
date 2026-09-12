package router

import (
	"net/http"

	"github.com/basketikun/infinite-canvas/handler"
	"github.com/basketikun/infinite-canvas/middleware"
	"github.com/gin-gonic/gin"
)

func New() *gin.Engine {
	router := gin.New()
	router.Use(gin.Logger(), gin.CustomRecovery(func(c *gin.Context, recovered any) {
		// Streaming errors must reach net/http so a partial ZIP is a failed download.
		if recovered == http.ErrAbortHandler {
			panic(http.ErrAbortHandler)
		}
		c.AbortWithStatus(http.StatusInternalServerError)
	}))
	router.RedirectTrailingSlash = false
	_ = router.SetTrustedProxies(nil)
	router.POST("/internal/portal/directory-sync", gin.WrapF(handler.PortalDirectorySync))
	api := router.Group("/api")
	api.GET("/healthz", gin.WrapF(handler.Health))
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
	v1.GET("/canvas/projects", gin.WrapF(handler.CanvasProjects))
	v1.POST("/canvas/projects", gin.WrapF(handler.CreateCanvasProject))
	v1.POST("/canvas/projects/import", gin.WrapF(handler.ImportCanvasProjects))
	v1.GET("/canvas/projects/:id", func(c *gin.Context) { handler.CanvasProject(c.Writer, c.Request, c.Param("id")) })
	v1.PUT("/canvas/projects/:id", func(c *gin.Context) { handler.UpdateCanvasProject(c.Writer, c.Request, c.Param("id")) })
	v1.DELETE("/canvas/projects/:id", func(c *gin.Context) { handler.DeleteCanvasProject(c.Writer, c.Request, c.Param("id")) })
	v1.GET("/canvas/share-recipients", gin.WrapF(handler.CanvasShareRecipients))
	v1.POST("/canvas/projects/:id/share", func(c *gin.Context) { handler.ShareCanvasProject(c.Writer, c.Request, c.Param("id")) })
	v1.GET("/workflows", gin.WrapF(handler.Workflows))
	v1.POST("/workflows", gin.WrapF(handler.CreateWorkflow))
	v1.GET("/workflows/:id/run-state", func(c *gin.Context) { handler.WorkflowRunState(c.Writer, c.Request, c.Param("id")) })
	v1.GET("/workflows/:id", func(c *gin.Context) { handler.Workflow(c.Writer, c.Request, c.Param("id")) })
	v1.PUT("/workflows/:id", func(c *gin.Context) { handler.UpdateWorkflow(c.Writer, c.Request, c.Param("id")) })
	v1.POST("/workflows/:id/copy", func(c *gin.Context) { handler.CopyWorkflow(c.Writer, c.Request, c.Param("id")) })
	v1.DELETE("/workflows/:id", func(c *gin.Context) { handler.DeleteWorkflow(c.Writer, c.Request, c.Param("id")) })
	v1.POST("/workflows/:id/runs", func(c *gin.Context) { handler.CreateWorkflowRun(c.Writer, c.Request, c.Param("id")) })
	v1.GET("/workflow-runs", gin.WrapF(handler.WorkflowRuns))
	v1.GET("/workflow-runs/:id/images/download", func(c *gin.Context) { handler.WorkflowRunImages(c.Writer, c.Request, c.Param("id")) })
	v1.GET("/workflow-runs/:id", func(c *gin.Context) { handler.WorkflowRun(c.Writer, c.Request, c.Param("id")) })
	v1.POST("/workflow-runs/:id/stop", func(c *gin.Context) { handler.StopWorkflowRun(c.Writer, c.Request, c.Param("id")) })
	v1.POST("/workflow-runs/:id/retry", func(c *gin.Context) { handler.RetryWorkflowRunOutput(c.Writer, c.Request, c.Param("id")) })
	v1.DELETE("/workflow-runs/:id", func(c *gin.Context) { handler.DeleteWorkflowRun(c.Writer, c.Request, c.Param("id")) })
	v1.GET("/images/tasks/:id", func(c *gin.Context) { handler.AIImageTask(c.Writer, c.Request, c.Param("id")) })
	v1.GET("/images/tasks/by-client-request/:id", func(c *gin.Context) { handler.AIImageTaskByClientRequest(c.Writer, c.Request, c.Param("id")) })
	v1.POST("/media/images", gin.WrapF(handler.UploadImage))
	v1.POST("/media/upload-intents", gin.WrapF(handler.CreateMediaUploadIntent))
	v1.POST("/media/upload-intents/:id/complete", func(c *gin.Context) { handler.CompleteMediaUploadIntent(c.Writer, c.Request, c.Param("id")) })
	v1.GET("/media/:id/access", func(c *gin.Context) { handler.MediaAccess(c.Writer, c.Request, c.Param("id")) })
	v1.GET("/media/:id/content", func(c *gin.Context) { handler.LocalMediaContent(c.Writer, c.Request, c.Param("id")) })
	v1.DELETE("/media/:id", func(c *gin.Context) { handler.DeletePrivateMedia(c.Writer, c.Request, c.Param("id")) })
	v1.GET("/private-images", gin.WrapF(handler.PrivateImages))
	v1.PATCH("/private-images/:id", func(c *gin.Context) { handler.UpdatePrivateImage(c.Writer, c.Request, c.Param("id")) })
	v1.GET("/private-folders", gin.WrapF(handler.PrivateFolders))
	v1.POST("/private-folders", gin.WrapF(handler.CreatePrivateFolder))
	v1.PATCH("/private-folders/:id", func(c *gin.Context) { handler.RenamePrivateFolder(c.Writer, c.Request, c.Param("id")) })
	v1.DELETE("/private-folders/:id", func(c *gin.Context) { handler.DeletePrivateFolder(c.Writer, c.Request, c.Param("id")) })
	v1.GET("/public-images", gin.WrapF(handler.PublicImages))
	v1.GET("/public-folders", gin.WrapF(handler.PublicFolders))
	v1.GET("/public-images/:id/access", func(c *gin.Context) { handler.PublicImageAccess(c.Writer, c.Request, c.Param("id")) })
	v1.GET("/public-images/:id/content", func(c *gin.Context) { handler.PublicImageContent(c.Writer, c.Request, c.Param("id")) })
	v1.GET("/videos/by-client/:client", func(c *gin.Context) { handler.AIVideoByClient(c.Writer, c.Request, c.Param("client")) })
	v1.POST("/videos", gin.WrapF(handler.AIVideos))
	v1.POST("/videos/:id/resume", func(c *gin.Context) { handler.AIVideoResume(c.Writer, c.Request, c.Param("id")) })
	v1.GET("/videos/:id", func(c *gin.Context) {
		handler.AIVideo(c.Writer, c.Request, c.Param("id"))
	})
	v1.GET("/videos/:id/content", func(c *gin.Context) {
		handler.AIVideoContent(c.Writer, c.Request, c.Param("id"))
	})
	admin := protected.Group("/admin", middleware.RequireAppAdmin)
	admin.GET("/me", gin.WrapF(handler.AdminCurrent))
	admin.GET("/settings", gin.WrapF(handler.AdminSettings))
	admin.POST("/settings", gin.WrapF(handler.AdminSaveSettings))
	admin.GET("/ai/provider-types", gin.WrapF(handler.AdminAIProviderTypes))
	admin.GET("/operation-logs", gin.WrapF(handler.AdminOperationLogs))
	admin.GET("/members", gin.WrapF(handler.AdminPortalMembers))
	admin.PATCH("/members/:uid/app-role", func(c *gin.Context) {
		handler.AdminSetPortalMemberAppRole(c.Writer, c.Request, c.Param("uid"))
	})
	admin.GET("/statistics", gin.WrapF(handler.AdminStatistics))
	admin.POST("/members/sync", gin.WrapF(handler.AdminSyncPortalMembers))
	publicAssets := protected.Group("/admin", middleware.RequirePublicAssetManager)
	publicAssets.POST("/public-images", gin.WrapF(handler.AdminUploadPublicImage))
	publicAssets.POST("/public-folders", gin.WrapF(handler.AdminCreatePublicFolder))
	publicAssets.PATCH("/public-folders/:id", func(c *gin.Context) {
		handler.AdminRenamePublicFolder(c.Writer, c.Request, c.Param("id"))
	})
	publicAssets.DELETE("/public-folders/:id", func(c *gin.Context) {
		handler.AdminDeletePublicFolder(c.Writer, c.Request, c.Param("id"))
	})
	publicAssets.PATCH("/public-images/:id", func(c *gin.Context) {
		handler.AdminUpdatePublicImage(c.Writer, c.Request, c.Param("id"))
	})
	publicAssets.DELETE("/public-images/:id", func(c *gin.Context) {
		handler.AdminDeletePublicImage(c.Writer, c.Request, c.Param("id"))
	})

	router.NoRoute(middleware.NotFoundJSON)

	return router
}
